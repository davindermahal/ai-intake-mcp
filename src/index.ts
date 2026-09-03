#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadGlobalConfig, type GlobalConfig } from "./config.js";
import { JiraClient } from "./jira/client.js";
import { approvePlanTool } from "./tools/approve-plan.js";
import { healthCheck } from "./tools/health-check.js";
import { implementTicketTool } from "./tools/implement-ticket.js";
import { trackerAddComment } from "./tools/tracker-add-comment.js";
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
      "native status exists on the board.",
    inputSchema: {},
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
    inputSchema: { key: z.string().describe("Ticket key, e.g. DAV-5") },
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
  "tracker_add_comment",
  {
    description: "Adds a comment to a Jira ticket, stamped with a footer naming the calling agent.",
    inputSchema: { key: z.string().describe("Ticket key, e.g. DAV-5"), text: z.string() },
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
    inputSchema: {
      key: z.string().describe("Ticket key, e.g. DAV-5"),
      state: z.enum(["needs-input", "review", "working", "verify", "problem"]),
    },
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
    inputSchema: { ticket_key: z.string().describe("Ticket key, e.g. DAV-5") },
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
    inputSchema: {
      jira_project_keys: z.array(z.string()).min(1).describe('e.g. ["DAV"] or ["DAV", "OPS"]'),
      app_tag: z.string().describe('e.g. "app:my-repo"'),
    },
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
    inputSchema: { ticket_key: z.string().describe("Ticket key, e.g. DAV-5") },
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
    inputSchema: { ticket_key: z.string().describe("Ticket key, e.g. DAV-5") },
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
    inputSchema: {
      ticket_key: z.string().describe("Ticket key, e.g. DAV-5"),
      force: z.boolean().optional().describe("Remove even if not merged into the base branch"),
      keep_branch: z.boolean().optional().describe("Remove the worktree but keep the branch"),
    },
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
      contents: [{ uri: readUri.href, mimeType: "text/markdown", text: readFileSync(join(DOCS_DIR, file), "utf8") }],
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
    argsSchema: { ticket_key: z.string().describe("Ticket key, e.g. DAV-5") },
  },
  ({ ticket_key: ticketKey }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Plan ticket ${ticketKey}. Do this, in order:\n` +
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
    argsSchema: { ticket_key: z.string().describe("Ticket key, e.g. DAV-5") },
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
