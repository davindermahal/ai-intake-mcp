#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { resolveIncludes } from "./automation/prompt-template.js";
import { loadGlobalConfig, type GlobalConfig } from "./config.js";
import { ConfluenceClient } from "./confluence/client.js";
import { JiraClient } from "./jira/client.js";
import { approvePlanTool } from "./tools/approve-plan.js";
import { fetchConfluencePages } from "./tools/fetch-confluence-pages.js";
import { fetchGuide } from "./tools/fetch-guide.js";
import { healthCheck } from "./tools/health-check.js";
import { implementTicketTool } from "./tools/implement-ticket.js";
import { listGuides } from "./tools/list-guides.js";
import { trackerAddComment } from "./tools/tracker-add-comment.js";
import { trackerCreateIssue } from "./tools/tracker-create-issue.js";
import { trackerGetIssue } from "./tools/tracker-get-issue.js";
import { trackerTransition } from "./tools/tracker-transition.js";
import { worktreeCreateTool } from "./tools/worktree-create.js";
import { worktreeRemoveTool } from "./tools/worktree-remove.js";
import { writeRepoConfigTool } from "./tools/write-repo-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");

const server = new McpServer({ name: "ai-intake-mcp", version: "0.1.0" });

let cachedConfig: GlobalConfig | undefined;
function getConfig(): GlobalConfig {
  cachedConfig ??= loadGlobalConfig();
  return cachedConfig;
}
function getClient(): JiraClient {
  return new JiraClient({ config: getConfig() });
}
function getConfluenceClient(): ConfluenceClient {
  return new ConfluenceClient({ config: getConfig() });
}

function ok(structuredContent: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}
function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

// --- Tools -------------------------------------------------------------------------------------

server.registerTool(
  "health_check",
  {
    description:
      "Verifies Jira credentials load, the site is reachable, and the configured in-progress " +
      "and code-review native statuses exist on the board.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, title: "Health check" },
  },
  async () => {
    try {
      const result = await healthCheck(getClient(), getConfig());
      return { ...ok(result), isError: !result.ok };
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "tracker_get_issue",
  {
    description:
      "Fetches a Jira ticket (summary, status, description, comments). Refuses if this repo isn't " +
      "configured yet (see write_repo_config) or if the ticket belongs to a different repo.",
    inputSchema: z.object({ key: z.string().describe("Ticket key, e.g. DAV-5") }),
    annotations: { readOnlyHint: true, title: "Get ticket" },
  },
  async ({ key }) => {
    try {
      return ok(await trackerGetIssue(getClient(), key));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_guides",
  {
    description:
      "Lists the curated Confluence guide catalog (title, description, tags — not full content or " +
      "link) for the planning agent to match against a ticket. Reports configured: false rather " +
      "than erroring if CONFLUENCE_GUIDE_INDEX_URL isn't set — the feature is simply off then.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, title: "List guides" },
  },
  async () => {
    try {
      return ok(await listGuides(getConfluenceClient(), getConfig()));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "fetch_guide",
  {
    description:
      "Fetches a guide's full content by exact title. Scoped only to titles present in the " +
      "list_guides catalog — there is no raw Confluence search, by design.",
    inputSchema: z.object({ title: z.string().describe("Exact guide title, from list_guides") }),
    annotations: { readOnlyHint: true, title: "Fetch guide" },
  },
  async ({ title }) => {
    try {
      return ok(await fetchGuide(getConfluenceClient(), getConfig(), title));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "fetch_confluence_pages",
  {
    description:
      "Fetches specific Confluence pages by URL — ticket-referenced or operator-named links, not a " +
      "catalog. Partial-failure tolerant: returns one entry per URL that resolves to a page on this " +
      "site (title, content, lastModified, error?); a URL that isn't a fetchable Confluence page on " +
      "this site (wrong host, or no extractable page ID) is silently skipped, not an error.",
    inputSchema: z.object({
      urls: z.array(z.string()).describe("Candidate Confluence page URLs; non-matching ones are silently skipped"),
    }),
    annotations: { readOnlyHint: true, title: "Fetch Confluence pages" },
  },
  async ({ urls }) => {
    try {
      return ok({ pages: await fetchConfluencePages(getConfluenceClient(), getConfig(), urls) });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "tracker_create_issue",
  {
    description:
      "Creates a new Jira ticket in this repo's configured project (see write_repo_config), " +
      "bootstrapped with state:plan and this repo's app tag so it's immediately usable by the " +
      "rest of the harness. Refuses if this repo isn't configured yet.",
    inputSchema: z.object({
      summary: z.string().describe("Ticket summary/title"),
      description: z.string().optional().describe("Plain text; converted to Jira's document format"),
      issue_type: z.string().optional().describe('Jira issue type name, defaults to "Task"'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Create ticket" },
  },
  async ({ summary, description, issue_type: issueType }) => {
    try {
      return ok(await trackerCreateIssue(getClient(), getConfig(), summary, description, issueType));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "tracker_add_comment",
  {
    description: "Adds a comment to a Jira ticket, stamped with a footer naming the calling agent.",
    inputSchema: z.object({ key: z.string().describe("Ticket key, e.g. DAV-5"), text: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Add comment" },
  },
  async ({ key, text }) => {
    try {
      const clientInfo = server.server.getClientVersion();
      const { id } = await trackerAddComment(getClient(), key, text, clientInfo);
      return ok({ posted: true, comment_id: id });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "tracker_transition",
  {
    description:
      "Transitions a ticket's abstract state (needs-input, review, working, verify, or problem) " +
      "via its state:* label. state:implement is reachable only via approve_plan, not this tool. " +
      "Assignee-gated: refuses if assigned to someone else, auto-assigns if unassigned.",
    inputSchema: z.object({
      key: z.string().describe("Ticket key, e.g. DAV-5"),
      state: z.enum(["needs-input", "review", "working", "verify", "problem"]),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Transition ticket" },
  },
  async ({ key, state }) => {
    try {
      return ok(await trackerTransition(getClient(), getConfig(), key, state));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "worktree_create",
  {
    description:
      "Creates (or resumes) a git worktree for a ticket's branch, as a sibling directory of the " +
      "current repo. No DB/container provisioning — pure git.",
    inputSchema: z.object({ ticket_key: z.string().describe("Ticket key, e.g. DAV-5") }),
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Create worktree" },
  },
  async ({ ticket_key: ticketKey }) => {
    try {
      const result = await worktreeCreateTool(getClient(), ticketKey);
      return ok({ worktree_path: result.worktreePath, branch: result.branch });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "write_repo_config",
  {
    description:
      "Creates or overwrites .ai/intake-mcp.json at the current repo's root, mapping it to one or " +
      "more Jira project keys and an app tag. Called once, automatically, the first time a tracker " +
      "tool is used in an unconfigured repo.",
    inputSchema: z.object({
      jira_project_keys: z.array(z.string()).min(1).describe('e.g. ["DAV"] or ["DAV", "OPS"]'),
      app_tag: z.string().describe('e.g. "app:my-repo"'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Write repo config" },
  },
  ({ jira_project_keys: jiraProjectKeys, app_tag: appTag }) => {
    try {
      return ok(writeRepoConfigTool(jiraProjectKeys, appTag));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "approve_plan",
  {
    description:
      "Approves a ticket's plan: transitions it to state:implement (refusing unless it's " +
      "currently state:review) and flips the plan file's Status from draft to ready. The only way " +
      "to reach state:implement — tracker_transition refuses that target directly.",
    inputSchema: z.object({ ticket_key: z.string().describe("Ticket key, e.g. DAV-5") }),
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Approve plan" },
  },
  async ({ ticket_key: ticketKey }) => {
    try {
      const result = await approvePlanTool(getClient(), getConfig(), ticketKey);
      return ok({ plan_path: result.planPath, transitioned_to: result.transitionedTo });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "implement_ticket",
  {
    description:
      "Resolves/resumes a ticket's worktree, confirms its plan is approved (Status: ready/active " +
      "plus state:implement/working on Jira), and transitions to state:working if this is the " +
      "first run. Hand off to docs://implementation-procedure afterward for the actual " +
      "implementation, build/test/lint, and final tracker_transition to verify or problem.",
    inputSchema: z.object({ ticket_key: z.string().describe("Ticket key, e.g. DAV-5") }),
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Start implementation" },
  },
  async ({ ticket_key: ticketKey }) => {
    try {
      const result = await implementTicketTool(getClient(), getConfig(), ticketKey);
      return ok({
        worktree_path: result.worktreePath,
        branch: result.branch,
        plan_path: result.planPath,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "worktree_remove",
  {
    description:
      "Removes a ticket's git worktree and, unless keep_branch is set, its branch. Refuses non-" +
      "feature/* branches and anything not merged into the base branch unless force is set. Pure " +
      "git — no container/DB was ever created for a worktree, so there's nothing else to tear down.",
    inputSchema: z.object({
      ticket_key: z.string().describe("Ticket key, e.g. DAV-5"),
      force: z.boolean().optional().describe("Remove even if not merged into the base branch"),
      keep_branch: z.boolean().optional().describe("Remove the worktree but keep the branch"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, title: "Remove worktree" },
  },
  ({ ticket_key: ticketKey, force, keep_branch: keepBranch }) => {
    try {
      const result = worktreeRemoveTool(ticketKey, { force, keepBranch });
      return ok({
        worktree: result.worktree,
        branch: result.branch,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- Resources -----------------------------------------------------------------------------------

function registerDocResource(name: string, uri: string, file: string, description: string): void {
  server.registerResource(
    name,
    uri,
    { description, mimeType: "text/markdown" },
    (readUri) => ({
      contents: [
        {
          uri: readUri.href,
          mimeType: "text/markdown",
          text: resolveIncludes(readFileSync(join(DOCS_DIR, file), "utf8")),
        },
      ],
    }),
  );
}

registerDocResource(
  "planning-procedure",
  "docs://planning-procedure",
  "planning-procedure.md",
  "How to plan a ticket: read, question vs. clean, plan-file conventions, transition rules.",
);
registerDocResource(
  "ticket-states",
  "docs://ticket-states",
  "ticket-states.md",
  "ai-intake-mcp's state:* label vocabulary, reference only.",
);
registerDocResource(
  "implementation-procedure",
  "docs://implementation-procedure",
  "implementation-procedure.md",
  "How to implement an approved plan: gate check, make targets, commit, report back.",
);

// --- Prompts -------------------------------------------------------------------------------------

server.registerPrompt(
  "plan_ticket",
  {
    description: "Plan a ticket: fetch it, read the planning procedure, create/resume its worktree.",
    argsSchema: z.object({
      ticket_key: z.string().describe("Ticket key, e.g. DAV-5"),
      confluence_links: z
        .string()
        .optional()
        .describe(
          "Optional: Confluence page URL(s) the developer wants fetched during planning, space- or " +
            "comma-separated (confluence-references-in-planning.md Design #3, operator-named source)",
        ),
    }),
  },
  ({ ticket_key: ticketKey, confluence_links: confluenceLinks }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Plan ticket ${ticketKey}. Do this, in order:\n` +
            (confluenceLinks
              ? `Operator-named Confluence links to fetch during context-gathering (pass these to ` +
                `fetch_confluence_pages alongside anything found in the ticket itself): ${confluenceLinks}\n`
              : "") +
            `1. Call tracker_get_issue with key="${ticketKey}".\n` +
            `2. Read the docs://planning-procedure resource.\n` +
            `3. Call worktree_create with ticket_key="${ticketKey}", then change into the returned ` +
            `worktree_path for the rest of this session.\n` +
            `4. Follow docs://planning-procedure exactly from step 1 onward — it covers reading the ` +
            `ticket, writing/refining the plan file, and reporting back via tracker_add_comment and ` +
            `tracker_transition.\n` +
            `If this repo isn't configured yet, tracker_get_issue will say so — ask the developer for ` +
            `the Jira project key and app tag, then call write_repo_config before retrying.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "implement_ticket",
  {
    description:
      "Implement a ticket's approved plan: resolve/resume its worktree, confirm approval, follow " +
      "the implementation procedure, report back.",
    argsSchema: z.object({ ticket_key: z.string().describe("Ticket key, e.g. DAV-5") }),
  },
  ({ ticket_key: ticketKey }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Implement ticket ${ticketKey}. Do this, in order:\n` +
            `1. Call implement_ticket with ticket_key="${ticketKey}". This resolves/resumes the ` +
            `worktree and checks the plan is approved — if it refuses, stop and tell the developer ` +
            `why (e.g. the plan isn't approved yet: ask them to review it and call approve_plan).\n` +
            `2. Change into the returned worktree_path for the rest of this session.\n` +
            `3. Read the docs://implementation-procedure resource.\n` +
            `4. Follow it exactly — it covers reading the plan/project context, implementing the ` +
            `plan's Implementation order, running the project's make targets, committing locally, ` +
            `and reporting back via tracker_add_comment and tracker_transition (to "verify" on ` +
            `success or "problem" if blocked). Never git push, merge, or deploy.`,
        },
      },
    ],
  }),
);

// --- Start -----------------------------------------------------------------------------------

// `server` is exported so a test can drive it over an in-memory transport (hardening-phase plan,
// decision #4) without ever reaching the real stdio connect below — real dev-machine credentials
// only load lazily, inside a tool handler, so listing tools/prompts/resources never touches them.
export { server };

/**
 * The MCP_TRANSPORT=http branch's server, factored out (and exported) so a test can bind it to an
 * ephemeral port and drive it with real HTTP requests — same rationale as exporting `server` above,
 * but for the loopback/origin validation and request wiring, which is this project's own code, not
 * SDK-internal (draft plan: http-transport-and-v2-sdk-migration.md, open question #4).
 */
export function createHttpServer() {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  return createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}

/**
 * stdio (default, unchanged) unless MCP_TRANSPORT=http opts a teammate into a long-lived local
 * instance other clients can point a URL at, instead of each spawning their own stdio process
 * (draft plan: http-transport-and-v2-sdk-migration.md). Loopback-only and origin-checked — this is
 * "one teammate runs their own instance," not a network-exposed shared service; credentials are
 * still read locally by loadGlobalConfig() the same as stdio today.
 */
async function main(): Promise<void> {
  if (process.env.MCP_TRANSPORT === "http") {
    const port = Number(process.env.MCP_HTTP_PORT ?? 3939);
    createHttpServer().listen(port, "127.0.0.1");
    console.error(`ai-intake-mcp listening on http://127.0.0.1:${port}/mcp`);
  } else {
    await server.connect(new StdioServerTransport());
  }
}

// Guards the real stdio connect to only the actual CLI entrypoint (`node .../dist/index.js`, the
// only way this server is ever invoked — see docs/setup.md/install.sh, never via npm's `bin`
// symlink) — not a plain `import` of this module, e.g. from a test. realpathSync on both sides
// makes this robust to a symlinked invocation path, though the documented invocation never uses one.
function isMainModule(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
