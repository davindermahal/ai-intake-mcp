import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import type { LaunchFn } from "../../src/automation/dispatch.js";
import { listMarkers, writeMarker, type WorkerMarker } from "../../src/automation/markers.js";
import { runProjectPasses } from "../../src/automation/orchestrator.js";
import type { ProjectEntry } from "../../src/automation/registry.js";
import {
  type ImplementationResult,
  type PlanningResult,
  progressLogPath,
  resultFilePath,
} from "../../src/automation/result-file.js";
import type { AutomationSettings } from "../../src/automation/settings.js";
import { adfToPlainText } from "../../src/jira/adf.js";
import { JiraClient } from "../../src/jira/client.js";
import type { RepoConfig } from "../../src/repo-context.js";

/**
 * Integration harness (decision #21) — a mocked Jira board (in-memory, stateful across calls) plus a
 * fake provider adapter (writes a canned marker/result instead of spawning anything real), driving
 * `runProjectPasses` across multiple simulated cron ticks. This is what actually exercises the
 * cross-decision behavior end-to-end that the per-pass unit tests can't: does the concurrency cap
 * really skip a second dispatch, does a simulated dead PID really get restarted and then escalated
 * after the retry budget, does a heartbeat really compose from progress-log entries, does Status
 * really get promoted to `ready` on first implementation touch — all across a realistic multi-tick
 * timeline, not a single isolated call.
 */

interface FakeIssue {
  summary: string;
  labels: string[];
  comments: { author: string; body: unknown; created: string }[];
}

class FakeBoard {
  issues = new Map<string, FakeIssue>();

  seed(key: string, summary: string, labels: string[]): void {
    this.issues.set(key, { summary, labels: [...labels], comments: [] });
  }

  private rawIssue(key: string, issue: FakeIssue) {
    return {
      key,
      fields: {
        summary: issue.summary,
        status: { name: "To Do" },
        description: null,
        comment: { comments: issue.comments },
        labels: issue.labels,
        assignee: { accountId: "me" },
      },
    };
  }

  fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const jsonResponse = (body: unknown, status = 200): Response =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "POST" && url.endsWith("/rest/api/3/search")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { jql: string };
      const wantedLabels = [...body.jql.matchAll(/labels = "([^"]+)"/g)].map((m) => m[1] as string);
      const matches = [...this.issues.entries()].filter(([, issue]) =>
        wantedLabels.every((l) => issue.labels.includes(l)),
      );
      return jsonResponse({ issues: matches.map(([key, issue]) => this.rawIssue(key, issue)) });
    }

    if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });

    const issueMatch = /\/rest\/api\/3\/issue\/([^/?]+)/.exec(url);
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1] as string);
      const issue = this.issues.get(key);
      if (!issue) return jsonResponse(undefined, 404);

      if (method === "GET" && url.endsWith("/transitions")) return jsonResponse({ transitions: [] });
      if (method === "PUT" && url.endsWith("/assignee")) return jsonResponse(undefined, 204);
      if (method === "POST" && url.endsWith("/comment")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { body: unknown };
        issue.comments.push({ author: "AI", body: body.body, created: new Date().toISOString() });
        return jsonResponse({ id: String(issue.comments.length) });
      }
      if (method === "PUT") {
        const body = JSON.parse((init?.body as string) ?? "{}") as { fields?: { labels?: string[] } };
        if (body.fields?.labels) issue.labels = body.fields.labels;
        return jsonResponse(undefined, 204);
      }
      if (method === "GET") return jsonResponse(this.rawIssue(key, issue));
    }

    return jsonResponse(undefined, 204);
  };

  lastCommentText(key: string): string | undefined {
    const issue = this.issues.get(key);
    const last = issue?.comments.at(-1);
    return last ? adfToPlainText(last.body) : undefined;
  }

  labels(key: string): string[] | undefined {
    return this.issues.get(key)?.labels;
  }
}

interface ScriptedOutcome {
  pidAlive: boolean;
  result?: PlanningResult | ImplementationResult;
}

function makeFakeLaunch(
  deadPids: Set<number>,
  script: Map<string, ScriptedOutcome>,
  now: () => Date,
): { launch: LaunchFn; calls: string[] } {
  let nextPid = 20000;
  const calls: string[] = [];
  const launch: LaunchFn = (_provider, options) => {
    const pid = nextPid++;
    calls.push(`${options.ticketKey}:${options.phase}:attempt${options.attempts}:pid${pid}`);
    const outcome = script.get(options.ticketKey);
    if (outcome && !outcome.pidAlive) deadPids.add(pid);

    const marker: WorkerMarker = {
      ticketKey: options.ticketKey,
      phase: options.phase,
      pid,
      // Must track the test's simulated clock, not the real wall clock — the watchdog's grace/
      // heartbeat comparisons are all relative to `now()`, which in these tests is far from today.
      launchedAt: now().toISOString(),
      lastHeartbeatAt: now().toISOString(),
      progressReadPosition: 0,
      attempts: options.attempts,
      escalated: false,
    };
    writeMarker(options.projectName, marker, options.stateRoot);

    if (outcome?.result) {
      const path = resultFilePath(options.projectName, options.ticketKey, options.stateRoot);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(outcome.result), "utf8");
    }

    return { pid, logPath: options.promptPath };
  };
  return { launch, calls };
}

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
    planning: { graceSeconds: 600, maxAttempts: 2, heartbeatSeconds: 300 },
  },
  concurrency: { planning: 1 },
  permissions: {
    claude: "~/.config/ai-intake-mcp/permissions/claude.json",
    gemini: "~/.gemini/policies/ai-intake-mcp-headless.toml",
  },
  aiProfiles: {},
};

let parentDir: string;
let repoRoot: string;
let stateRoot: string;
let project: ProjectEntry;
let board: FakeBoard;
let client: JiraClient;
let deadPids: Set<number>;
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-integration-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
  mkdirSync(join(repoRoot, ".ai"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".ai", "intake-mcp.json"),
    JSON.stringify({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo" } satisfies RepoConfig),
    "utf8",
  );

  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-integration-state-"));
  project = { path: repoRoot, name: "my-app", enabled: true, overrides: undefined };
  board = new FakeBoard();
  client = new JiraClient({ config, fetchImpl: board.fetchImpl });

  deadPids = new Set();
  killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    if (deadPids.has(pid)) {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    return true;
  }) as never);
});

afterEach(() => {
  killSpy.mockRestore();
  rmSync(parentDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

const COMPLETE_SECTIONS =
  "\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun `npm test`.\n\n" +
  "## QA Plan\n\nNone — automated coverage above is sufficient.\n";

describe("integration: full planning -> implementation lifecycle across ticks", () => {
  it("dispatches planning, completes it cleanly to state:review, then implementation promotes Status and completes to state:verify", async () => {
    board.seed("DAV-1", "Fix the thing", ["state:plan", "app:my-repo"]);
    const script = new Map<string, ScriptedOutcome>();
    const { launch } = makeFakeLaunch(deadPids, script, () => new Date());

    // Tick 1: planning pass discovers DAV-1 and dispatches a (simulated) worker.
    const tick1 = await runProjectPasses({ client, config, project, settings, stateRoot, launch });
    expect(tick1.planning.dispatched).toEqual(["DAV-1"]);
    expect(listMarkers("my-app", stateRoot)).toHaveLength(1);

    // The "worker" now commits a plan file and reports done — simulate that directly, then kill its pid.
    const marker = listMarkers("my-app", stateRoot)[0] as WorkerMarker;
    deadPids.add(marker.pid);
    const activeDir = join(dirname(repoRoot), "feature-DAV-1-fix-the-thing", ".ai", "plans", "active");
    mkdirSync(activeDir, { recursive: true });
    const planPath = join(activeDir, "DAV-1-fix-the-thing.md");
    writeFileSync(
      planPath,
      `# Plan: DAV-1 Fix the thing\n\n**Status**: draft\n**Branch**: feature/DAV-1-fix-the-thing\n` +
        `**Created**: 2026-01-01\n**Updated**: 2026-01-01\n${COMPLETE_SECTIONS}`,
      "utf8",
    );
    mkdirSync(dirname(resultFilePath("my-app", "DAV-1", stateRoot)), { recursive: true });
    writeFileSync(resultFilePath("my-app", "DAV-1", stateRoot), JSON.stringify({ outcome: "done" }), "utf8");

    // Tick 2: watchdog notices the dead PID + result, posts the plan, transitions to state:review.
    const tick2 = await runProjectPasses({ client, config, project, settings, stateRoot, launch });
    expect(tick2.watchdog.completed).toEqual(["DAV-1"]);
    expect(board.labels("DAV-1")).toContain("state:review");
    expect(board.lastCommentText("DAV-1")).toContain("Plan ready for review");
    expect(listMarkers("my-app", stateRoot)).toHaveLength(0);

    // A human approves by moving the label directly (not via approve_plan) — plan Status stays draft.
    board.seed("DAV-1", "Fix the thing", ["state:implement", "app:my-repo"]);

    // Tick 3: implementation pass promotes Status draft -> ready (decision #17), starts, dispatches.
    const tick3 = await runProjectPasses({ client, config, project, settings, stateRoot, launch });
    expect(tick3.implementation.dispatched).toBe("DAV-1");
    expect(tick3.implementation.bounced).toEqual([]);
    expect(readFileSync(planPath, "utf8")).toContain("**Status**: ready");
    expect(board.labels("DAV-1")).toContain("state:working");
    expect(board.lastCommentText("DAV-1")).toContain("Implementation starting");

    // The implementation "worker" reports success; kill its pid.
    const implMarker = listMarkers("my-app", stateRoot).find((m) => m.phase === "implementation") as WorkerMarker;
    deadPids.add(implMarker.pid);
    writeFileSync(
      resultFilePath("my-app", "DAV-1", stateRoot),
      JSON.stringify({ outcome: "success", summary: "Added the fix.", verify: "make test passed" }),
      "utf8",
    );

    // Tick 4: watchdog completes the implementation, transitions to state:verify.
    const tick4 = await runProjectPasses({ client, config, project, settings, stateRoot, launch });
    expect(tick4.watchdog.completed).toEqual(["DAV-1"]);
    expect(board.labels("DAV-1")).toContain("state:verify");
    expect(board.lastCommentText("DAV-1")).toContain("Implementation complete");
    expect(listMarkers("my-app", stateRoot)).toHaveLength(0);
  });
});

describe("integration: planning concurrency cap across multiple candidates in one tick", () => {
  it("dispatches only up to the resolved cap (1) even with two eligible tickets", async () => {
    board.seed("DAV-1", "First", ["state:plan", "app:my-repo"]);
    board.seed("DAV-2", "Second", ["state:plan", "app:my-repo"]);
    const script = new Map<string, ScriptedOutcome>();
    const { launch, calls } = makeFakeLaunch(deadPids, script, () => new Date());

    const tick1 = await runProjectPasses({ client, config, project, settings, stateRoot, launch });

    expect(tick1.planning.dispatched).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(listMarkers("my-app", stateRoot)).toHaveLength(1);

    // Tick 2, same still-alive worker in flight: still capped, no second dispatch.
    const tick2 = await runProjectPasses({ client, config, project, settings, stateRoot, launch });
    expect(tick2.planning.dispatched).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("integration: a stalled planning worker restarts, then escalates once the retry budget is exhausted", () => {
  it("restarts on tick 2 (past grace), then escalates on tick 3 without a third dispatch", async () => {
    board.seed("DAV-1", "Fix the thing", ["state:plan", "app:my-repo"]);
    const script = new Map<string, ScriptedOutcome>([["DAV-1", { pidAlive: false }]]); // never reports a result
    let now = new Date("2026-01-01T00:00:00.000Z");
    const { launch, calls } = makeFakeLaunch(deadPids, script, () => now);
    const tick1 = await runProjectPasses({ client, config, project, settings, stateRoot, launch, now: () => now });
    expect(tick1.planning.dispatched).toEqual(["DAV-1"]);
    expect(calls).toHaveLength(1);

    // Past planning's 600s grace period — watchdog restarts (attempt 2 of maxAttempts 2).
    now = new Date("2026-01-01T00:15:00.000Z");
    const tick2 = await runProjectPasses({ client, config, project, settings, stateRoot, launch, now: () => now });
    expect(tick2.watchdog.restarted).toEqual(["DAV-1"]);
    expect(tick2.watchdog.escalated).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(listMarkers("my-app", stateRoot)[0]?.attempts).toBe(2);

    // Past grace again, attempts (2) now >= maxAttempts (2) — escalate, no third dispatch.
    now = new Date("2026-01-01T00:30:00.000Z");
    const tick3 = await runProjectPasses({ client, config, project, settings, stateRoot, launch, now: () => now });
    expect(tick3.watchdog.escalated).toEqual(["DAV-1"]);
    expect(tick3.watchdog.restarted).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(listMarkers("my-app", stateRoot)[0]?.escalated).toBe(true);
    expect(board.lastCommentText("DAV-1")).toContain("Escalating");

    // Tick 4: the planning pass must never redispatch an escalated ticket.
    const tick4 = await runProjectPasses({ client, config, project, settings, stateRoot, launch, now: () => now });
    expect(tick4.planning.dispatched).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe("integration: heartbeat composed from progress-log entries for a still-alive worker", () => {
  it("posts a heartbeat once the interval elapses, reflecting what the worker appended in between ticks", async () => {
    board.seed("DAV-1", "Fix the thing", ["state:plan", "app:my-repo"]);
    const script = new Map<string, ScriptedOutcome>([["DAV-1", { pidAlive: true }]]);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const { launch } = makeFakeLaunch(deadPids, script, () => now);
    await runProjectPasses({ client, config, project, settings, stateRoot, launch, now: () => now });

    // The "worker" appends progress between ticks — still alive, no result yet.
    const logPath = progressLogPath("my-app", "DAV-1", stateRoot);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "Done: read the ticket\nNext: draft a first pass\n", "utf8");

    // Past planning's 300s heartbeat interval.
    now = new Date("2026-01-01T00:06:00.000Z");
    const tick2 = await runProjectPasses({ client, config, project, settings, stateRoot, launch, now: () => now });

    expect(tick2.watchdog.heartbeats).toEqual(["DAV-1"]);
    const comment = board.lastCommentText("DAV-1");
    expect(comment).toContain("read the ticket");
    expect(comment).toContain("Next: draft a first pass");
    expect(listMarkers("my-app", stateRoot)[0]?.pid).toBeDefined(); // still in flight, not deleted
  });
});
