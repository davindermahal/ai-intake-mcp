import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { type ImplementationPassContext, runImplementationPass } from "../../src/automation/implementation-pass.js";
import { writeMarker } from "../../src/automation/markers.js";
import type { ProjectEntry } from "../../src/automation/registry.js";
import type { AutomationSettings } from "../../src/automation/settings.js";
import type { RepoConfig } from "../../src/repo-context.js";
import { worktreeCreate } from "../../src/worktree.js";

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
  aiProfiles: {},
};

const repoConfig: RepoConfig = { jiraProjectKeys: ["DAV"], appTag: "app:my-repo" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function issueJson(key: string, labels: string[]) {
  return {
    key,
    fields: {
      summary: "Fix the thing",
      status: { name: "To Do" },
      description: null,
      comment: { comments: [] },
      labels,
      assignee: null,
    },
  };
}

let parentDir: string;
let repoRoot: string;
let stateRoot: string;
let project: ProjectEntry;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-impl-pass-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });

  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-impl-pass-state-"));
  project = { path: repoRoot, name: "my-app", enabled: true, overrides: undefined };
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

const COMPLETE_SECTIONS =
  "\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun `npm test`.\n\n" +
  "## QA Plan\n\nNone — automated coverage above is sufficient.\n";

async function seedPlan(ticketKey: string, status: string, extra = COMPLETE_SECTIONS): Promise<string> {
  const worktree = await worktreeCreate(ticketKey, async () => "Fix the thing", repoRoot);
  const activeDir = join(worktree.worktreePath, ".ai", "plans", "active");
  mkdirSync(activeDir, { recursive: true });
  const planPath = join(activeDir, `${ticketKey}-fix-the-thing.md`);
  writeFileSync(
    planPath,
    `# Plan: ${ticketKey} Fix the thing\n\n**Status**: ${status}\n**Branch**: ${worktree.branch}\n` +
      `**Created**: 2026-01-01\n**Updated**: 2026-01-01\n${extra}`,
    "utf8",
  );
  return planPath;
}

function makeCtx(fetchImpl: typeof fetch, launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" })): ImplementationPassContext {
  return {
    client: new JiraClient({ config, fetchImpl }),
    config,
    repoConfig,
    project,
    settings,
    stateRoot,
    launch,
  };
}

describe("runImplementationPass", () => {
  it("dispatches a ready-status ticket: posts a start comment, transitions to working, launches", async () => {
    await seedPlan("DAV-5", "ready");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const body = init?.body ? (JSON.parse(init.body as string) as { jql?: string }) : {};
      if (body.jql) return jsonResponse({ issues: [issueJson("DAV-5", ["state:implement", "app:my-repo"])] });
      if (url.includes("/issue/DAV-5?")) return jsonResponse(issueJson("DAV-5", ["state:implement", "app:my-repo"]));
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" });

    const result = await runImplementationPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toBe("DAV-5");
    expect(result.bounced).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/comment"))).toBe(true);
    const labelsPut = calls.find((c) => c.startsWith("PUT") && c.includes("/issue/DAV-5") && !c.includes("assignee"));
    expect(labelsPut).toBeDefined();
  });

  it("promotes a draft plan with all gates satisfied to ready, then dispatches", async () => {
    const planPath = await seedPlan("DAV-5", "draft");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(init.body as string) as { jql?: string }) : {};
      if (body.jql) return jsonResponse({ issues: [issueJson("DAV-5", ["state:implement", "app:my-repo"])] });
      if (url.includes("/issue/DAV-5?")) return jsonResponse(issueJson("DAV-5", ["state:implement", "app:my-repo"]));
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" });

    const result = await runImplementationPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toBe("DAV-5");
    expect(readFileSync(planPath, "utf8")).toContain("**Status**: ready");
  });

  it("bounces to state:review when a draft plan is missing the Implementation order section, without dispatching", async () => {
    await seedPlan("DAV-5", "draft", "\n## Testing strategy\n\nRun `npm test`.\n");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const body = init?.body ? (JSON.parse(init.body as string) as { jql?: string }) : {};
      if (body.jql) return jsonResponse({ issues: [issueJson("DAV-5", ["state:implement", "app:my-repo"])] });
      if (url.includes("/issue/DAV-5?")) return jsonResponse(issueJson("DAV-5", ["state:implement", "app:my-repo"]));
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn();

    const result = await runImplementationPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toBeUndefined();
    expect(result.bounced).toEqual(["DAV-5"]);
    expect(launch).not.toHaveBeenCalled();
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/comment"))).toBe(true);
    const labelsPut = calls.find((c) => c.startsWith("PUT") && c.includes("/issue/DAV-5") && !c.includes("assignee"));
    expect(labelsPut).toBeDefined();
  });

  it("bounces to state:review when a draft plan is missing only the QA Plan section", async () => {
    await seedPlan(
      "DAV-5",
      "draft",
      "\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun `npm test`.\n",
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(init.body as string) as { jql?: string }) : {};
      if (body.jql) return jsonResponse({ issues: [issueJson("DAV-5", ["state:implement", "app:my-repo"])] });
      if (url.includes("/issue/DAV-5?")) return jsonResponse(issueJson("DAV-5", ["state:implement", "app:my-repo"]));
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn();

    const result = await runImplementationPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toBeUndefined();
    expect(result.bounced).toEqual(["DAV-5"]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("does nothing when the implementation concurrency cap (1) is already occupied", async () => {
    writeMarker(
      "my-app",
      { ticketKey: "DAV-1", phase: "implementation", pid: 1, launchedAt: "x", lastHeartbeatAt: "x", progressReadPosition: 0, attempts: 1, escalated: false },
      stateRoot,
    );
    const fetchImpl = vi.fn();
    const launch = vi.fn();

    const result = await runImplementationPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("skips a candidate that already has a marker and tries the next one", async () => {
    await seedPlan("DAV-6", "ready");
    writeMarker(
      "my-app",
      { ticketKey: "DAV-5", phase: "implementation", pid: 1, launchedAt: "x", lastHeartbeatAt: "x", progressReadPosition: 0, attempts: 1, escalated: true },
      stateRoot,
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(init.body as string) as { jql?: string }) : {};
      if (body.jql) {
        return jsonResponse({
          issues: [
            issueJson("DAV-5", ["state:implement", "app:my-repo"]),
            issueJson("DAV-6", ["state:implement", "app:my-repo"]),
          ],
        });
      }
      if (url.includes("/issue/DAV-6?")) return jsonResponse(issueJson("DAV-6", ["state:implement", "app:my-repo"]));
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" });

    const result = await runImplementationPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toBe("DAV-6");
  });
});
