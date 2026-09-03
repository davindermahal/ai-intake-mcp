import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../src/automation/registry.js";
import { writeMarker, type WorkerMarker } from "../../src/automation/markers.js";
import { type PlanningPassContext, runPlanningPass } from "../../src/automation/planning-pass.js";
import type { AutomationSettings } from "../../src/automation/settings.js";
import { JiraClient } from "../../src/jira/client.js";
import { plainTextToAdf } from "../../src/jira/adf.js";
import type { RepoConfig } from "../../src/repo-context.js";

const settings: AutomationSettings = {
  watchdog: {
    implementation: { graceSeconds: 1800, maxAttempts: 3, heartbeatSeconds: 1500 },
    planning: { graceSeconds: 600, maxAttempts: 3, heartbeatSeconds: 300 },
  },
  concurrency: { planning: 2 },
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

function issueJson(key: string, labels: string[], comments: { author?: { displayName?: string }; body?: unknown; created?: string }[] = []) {
  return {
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { name: "To Do" },
      description: null,
      comment: { comments },
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
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-planning-pass-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });

  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-planning-pass-state-"));
  project = { path: repoRoot, name: "my-app", enabled: true, overrides: undefined };
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

function makeCtx(fetchImpl: typeof fetch, launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" })): PlanningPassContext {
  const config = {
    jiraSiteUrl: "https://example.atlassian.net",
    jiraEmail: "bot@example.com",
    jiraApiToken: "test-token",
    trackerNativeStatusInProgress: "In Progress",
    trackerNativeStatusCodeReview: "Code Review",
    jiraCookieBrowser: "chrome",
  };
  return {
    client: new JiraClient({ config, fetchImpl }),
    repoConfig,
    project,
    settings,
    stateRoot,
    launch,
  };
}

describe("runPlanningPass", () => {
  it("dispatches every state:plan ticket returned by the search", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { jql: string }) : { jql: "" };
      if (body.jql.includes('"state:plan"')) {
        return jsonResponse({ issues: [issueJson("DAV-1", ["state:plan", "app:my-repo"])] });
      }
      return jsonResponse({ issues: [] });
    });
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" });

    const result = await runPlanningPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toEqual(["DAV-1"]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("dispatches a needs-input ticket only when an author reply follows the last automation comment", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { jql: string }) : { jql: "" };
      if (body.jql.includes('"state:plan"')) return jsonResponse({ issues: [] });
      return jsonResponse({
        issues: [
          issueJson("DAV-2", ["state:needs-input", "app:my-repo"], [
            {
              author: { displayName: "AI" },
              body: plainTextToAdf("Blocked.\n\n🤖 _Posted by Claude via ai-intake-mcp_"),
              created: "2026-01-01",
            },
            { author: { displayName: "Dev" }, body: plainTextToAdf("Here's the answer."), created: "2026-01-02" },
          ]),
          issueJson("DAV-3", ["state:needs-input", "app:my-repo"], [
            {
              author: { displayName: "AI" },
              body: plainTextToAdf("Blocked.\n\n🤖 _Posted by Claude via ai-intake-mcp_"),
              created: "2026-01-01",
            },
          ]),
        ],
      });
    });
    const launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" });

    const result = await runPlanningPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toEqual(["DAV-2"]);
  });

  it("skips a ticket that already has a marker (already running, or escalated)", async () => {
    const marker: WorkerMarker = {
      ticketKey: "DAV-1",
      phase: "planning",
      pid: 999,
      launchedAt: "2026-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      progressReadPosition: 0,
      attempts: 1,
      escalated: false,
    };
    writeMarker("my-app", marker, stateRoot);

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { jql: string }) : { jql: "" };
      if (body.jql.includes('"state:plan"')) {
        return jsonResponse({ issues: [issueJson("DAV-1", ["state:plan", "app:my-repo"])] });
      }
      return jsonResponse({ issues: [] });
    });
    const launch = vi.fn();

    const result = await runPlanningPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("stops dispatching once the planning concurrency cap is reached", async () => {
    // cap is 2 (settings.concurrency.planning); pre-seed 2 in-flight planning markers.
    writeMarker(
      "my-app",
      { ticketKey: "DAV-90", phase: "planning", pid: 1, launchedAt: "x", lastHeartbeatAt: "x", progressReadPosition: 0, attempts: 1, escalated: false },
      stateRoot,
    );
    writeMarker(
      "my-app",
      { ticketKey: "DAV-91", phase: "planning", pid: 2, launchedAt: "x", lastHeartbeatAt: "x", progressReadPosition: 0, attempts: 1, escalated: false },
      stateRoot,
    );

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { jql: string }) : { jql: "" };
      if (body.jql.includes('"state:plan"')) {
        return jsonResponse({ issues: [issueJson("DAV-1", ["state:plan", "app:my-repo"])] });
      }
      return jsonResponse({ issues: [] });
    });
    const launch = vi.fn();

    const result = await runPlanningPass(makeCtx(fetchImpl, launch));

    expect(result.dispatched).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });
});
