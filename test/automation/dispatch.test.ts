import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceClient } from "@davindermahal/confluence-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DispatchContext, dispatchWorker } from "../../src/automation/dispatch.js";
import type { ProjectEntry } from "../../src/automation/registry.js";
import { confluenceContextFilePath, contextFilePath, readConfluenceContext, readWorkerContext } from "../../src/automation/result-file.js";
import type { AutomationSettings } from "../../src/automation/settings.js";
import type { GlobalConfig } from "../../src/config.js";
import { resolveConfluenceAuthOrThrow } from "../../src/confluence/auth.js";
import type { JiraIssue } from "../../src/jira/tags.js";

const config: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

const settings: AutomationSettings = {
  watchdog: {
    implementation: { graceSeconds: 1800, maxAttempts: 3, heartbeatSeconds: 1500 },
    planning: { graceSeconds: 600, maxAttempts: 3, heartbeatSeconds: 300 },
  },
  concurrency: { planning: 3 },
  permissions: {
    claude: "~/.config/ai-intake-mcp/permissions/claude.json",
    gemini: "~/.gemini/policies/ai-intake-mcp-headless.toml",
  },
  aiProfiles: { "fast-impl": "gemini:gemini-2.5-pro" },
};

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "DAV-5",
    projectKey: "DAV",
    summary: "Fix the thing",
    statusName: "To Do",
    description: "It's broken.",
    comments: [{ author: "Dev", body: "Please prioritize.", created: "2026-01-01" }],
    labels: ["state:plan", "app:my-repo"],
    assigneeAccountId: null,
    ...overrides,
  };
}

let parentDir: string;
let repoRoot: string;
let stateRoot: string;
let project: ProjectEntry;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-dispatch-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });

  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-dispatch-state-"));
  project = { path: repoRoot, name: "my-app", enabled: true, overrides: undefined };
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("dispatchWorker", () => {
  it("creates the worktree, writes the context file, renders the prompt, and launches the default provider", async () => {
    const launch = vi.fn().mockReturnValue({ pid: 4242, logPath: "/fake/log" });
    const ctx: DispatchContext = { project, config, settings, stateRoot, launch };

    const result = await dispatchWorker(ctx, issue(), "planning", 1);

    expect(result.worktree.branch).toBe("feature/DAV-5-fix-the-thing");
    expect(result.provider).toBe("claude");
    expect(result.launchResult).toEqual({ pid: 4242, logPath: "/fake/log" });

    const context = readWorkerContext("my-app", "DAV-5", stateRoot);
    expect(context).toEqual({
      ticketKey: "DAV-5",
      phase: "planning",
      summary: "Fix the thing",
      description: "It's broken.",
      comments: [{ author: "Dev", body: "Please prioritize.", created: "2026-01-01" }],
    });

    expect(launch).toHaveBeenCalledTimes(1);
    const [providerArg, options] = launch.mock.calls[0] as [string, Record<string, unknown>];
    expect(providerArg).toBe("claude");
    expect(options.ticketKey).toBe("DAV-5");
    expect(options.phase).toBe("planning");
    expect(options.attempts).toBe(1);
    expect(options.worktreePath).toBe(result.worktree.worktreePath);
    // Tilde-expanded (resolvePermissionProfilePath, settings.ts) — spawn() takes no shell, so a
    // literal "~" would break the real `claude --settings` invocation (headless-automation QA
    // Phase B).
    expect(options.permissionProfilePath).toBe(
      join(homedir(), ".config", "ai-intake-mcp", "permissions", "claude.json"),
    );

    const promptContent = readFileSync(options.promptPath as string, "utf8");
    expect(promptContent).toContain("DAV-5");
    expect(promptContent).toContain(contextFilePath("my-app", "DAV-5", stateRoot));
    expect(promptContent).not.toMatch(/\{\{\w+\}\}/);
  });

  it("resolves the implementation prompt template for the implementation phase", async () => {
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/fake/log" });
    const ctx: DispatchContext = { project, config, settings, stateRoot, launch };

    await dispatchWorker(ctx, issue({ labels: ["state:implement", "app:my-repo"] }), "implementation", 1);

    const options = launch.mock.calls[0]?.[1] as Record<string, unknown>;
    const promptContent = readFileSync(options.promptPath as string, "utf8");
    expect(promptContent).toContain("plan's own acceptance checks");
  });

  it("resolves a ticket-labeled provider profile over the default", async () => {
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/fake/log" });
    const ctx: DispatchContext = { project, config, settings, stateRoot, launch };

    await dispatchWorker(ctx, issue({ labels: ["state:plan", "ai-plan-fast-impl"] }), "planning", 1);

    const [providerArg, options] = launch.mock.calls[0] as [string, Record<string, unknown>];
    expect(providerArg).toBe("gemini");
    expect(options.model).toBe("gemini-2.5-pro");
    expect(options.permissionProfilePath).toBe(
      join(homedir(), ".gemini", "policies", "ai-intake-mcp-headless.toml"),
    );
  });

  it("passes the given attempts count through to the launcher", async () => {
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/fake/log" });
    const ctx: DispatchContext = { project, config, settings, stateRoot, launch };

    await dispatchWorker(ctx, issue(), "planning", 3);

    const options = launch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.attempts).toBe(3);
  });

  it("pre-fetches Confluence context for a planning launch and points the prompt at the written file (Option B)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/222")) {
        return new Response(
          JSON.stringify({
            id: "222",
            title: "Runbook",
            version: { number: 1, when: "2024-05-01T00:00:00.000Z" },
            body: { storage: { representation: "storage", value: "<p>Do this.</p>" } },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const confluenceClient = new ConfluenceClient({ ...resolveConfluenceAuthOrThrow(config), fetchImpl });
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/fake/log" });
    const ctx: DispatchContext = { project, config, settings, stateRoot, launch, confluenceClient };

    await dispatchWorker(
      ctx,
      issue({ description: "See https://example.atlassian.net/wiki/spaces/ENG/pages/222/Runbook for context." }),
      "planning",
      1,
    );

    const expectedPath = confluenceContextFilePath("my-app", "DAV-5", stateRoot);
    const written = readConfluenceContext("my-app", "DAV-5", stateRoot);
    expect(written).toEqual({
      guideCatalog: [],
      referencedPages: [
        {
          url: "https://example.atlassian.net/wiki/spaces/ENG/pages/222/Runbook",
          title: "Runbook",
          content: "Do this.",
          lastModified: "2024-05-01T00:00:00.000Z",
        },
      ],
    });

    const options = launch.mock.calls[0]?.[1] as Record<string, unknown>;
    const promptContent = readFileSync(options.promptPath as string, "utf8");
    expect(promptContent).toContain(expectedPath);
    expect(promptContent).not.toMatch(/\{\{\w+\}\}/);
  });

  it("does not pre-fetch or write Confluence context for an implementation-phase launch", async () => {
    const fetchImpl = vi.fn();
    const confluenceClient = new ConfluenceClient({ ...resolveConfluenceAuthOrThrow(config), fetchImpl });
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/fake/log" });
    const ctx: DispatchContext = { project, config, settings, stateRoot, launch, confluenceClient };

    await dispatchWorker(ctx, issue({ labels: ["state:implement", "app:my-repo"] }), "implementation", 1);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readConfluenceContext("my-app", "DAV-5", stateRoot)).toBeUndefined();
  });
});
