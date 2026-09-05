import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { type OrchestratorContext, runProjectPasses } from "../../src/automation/orchestrator.js";
import { writeMarker, type WorkerMarker } from "../../src/automation/markers.js";
import type { ProjectEntry } from "../../src/automation/registry.js";
import type { AutomationSettings } from "../../src/automation/settings.js";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let parentDir: string;
let repoRoot: string;
let stateRoot: string;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-orchestrator-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
  mkdirSync(join(repoRoot, ".ai"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".ai", "intake-mcp.json"),
    JSON.stringify({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo" }),
    "utf8",
  );

  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-orchestrator-state-"));
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

function makeCtx(project: ProjectEntry, fetchImpl: typeof fetch, launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" })): OrchestratorContext {
  return { client: new JiraClient({ config, fetchImpl }), config, project, settings, stateRoot, launch };
}

describe("runProjectPasses", () => {
  it("throws when the project repo has no .ai/intake-mcp.json", async () => {
    const bareRepo = join(parentDir, "bare");
    execFileSync("git", ["init", "-b", "main", bareRepo]);
    const project: ProjectEntry = { path: bareRepo, name: "bare-app", enabled: true, overrides: undefined };
    await expect(runProjectPasses(makeCtx(project, vi.fn()))).rejects.toThrow(/no .ai\/intake-mcp.json/);
  });

  it("runs all three passes for an enabled project with nothing to do", async () => {
    const project: ProjectEntry = { path: repoRoot, name: "my-app", enabled: true, overrides: undefined };
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));

    const result = await runProjectPasses(makeCtx(project, fetchImpl));

    expect(result.planning.dispatched).toEqual([]);
    expect(result.implementation.dispatched).toBeUndefined();
    expect(result.watchdog).toEqual({ heartbeats: [], completed: [], restarted: [], escalated: [] });
  });

  it("skips planning/implementation dispatch for a disabled project but still runs the watchdog", async () => {
    const project: ProjectEntry = { path: repoRoot, name: "my-app", enabled: false, overrides: undefined };
    const marker: WorkerMarker = {
      ticketKey: "DAV-1",
      phase: "planning",
      pid: process.pid,
      launchedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      progressReadPosition: 0,
      attempts: 1,
      escalated: false,
    };
    writeMarker("my-app", marker, stateRoot);

    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));

    const result = await runProjectPasses(makeCtx(project, fetchImpl));

    // Neither pass's search JQL was ever issued for planning/implementation dispatch.
    expect(result.planning).toEqual({ dispatched: [] });
    expect(result.implementation).toEqual({ dispatched: undefined, bounced: [] });
    expect(fetchImpl).not.toHaveBeenCalled(); // watchdog found an alive worker; no heartbeat due yet
    expect(result.watchdog.heartbeats).toEqual([]);
  });
});
