import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import type { ProjectEntry } from "../../src/automation/registry.js";
import { readMarker, writeMarker, type WorkerMarker } from "../../src/automation/markers.js";
import { progressLogPath, resultFilePath } from "../../src/automation/result-file.js";
import type { AutomationSettings } from "../../src/automation/settings.js";
import { type WatchdogPassContext, runWatchdogPass } from "../../src/automation/watchdog-pass.js";
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
    planning: { graceSeconds: 600, maxAttempts: 2, heartbeatSeconds: 300 },
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

function issueResponse(key: string, labels: string[]): Response {
  return jsonResponse({
    key,
    fields: {
      summary: "Fix the thing",
      status: { name: "To Do" },
      description: null,
      comment: { comments: [] },
      labels,
      assignee: null,
    },
  });
}

let parentDir: string;
let repoRoot: string;
let stateRoot: string;
let project: ProjectEntry;
let killSpy: ReturnType<typeof vi.spyOn>;
let deadPids: Set<number>;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-watchdog-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });

  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-watchdog-state-"));
  project = { path: repoRoot, name: "my-app", enabled: true, overrides: undefined };

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

function baseMarker(overrides: Partial<WorkerMarker> = {}): WorkerMarker {
  return {
    ticketKey: "DAV-5",
    phase: "planning",
    pid: 12345,
    launchedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    progressReadPosition: 0,
    attempts: 1,
    escalated: false,
    ...overrides,
  };
}

function makeCtx(fetchImpl: typeof fetch, launch = vi.fn().mockReturnValue({ pid: 1, logPath: "/log" }), now?: Date): WatchdogPassContext {
  return {
    client: new JiraClient({ config, fetchImpl }),
    config,
    project,
    settings,
    stateRoot,
    launch,
    now: now ? () => now : undefined,
  };
}

const COMPLETE_SECTIONS =
  "\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun `npm test`.\n\n" +
  "## QA Plan\n\nNone — automated coverage above is sufficient.\n";

async function seedPlan(ticketKey: string, extra: string, openQuestions = ""): Promise<string> {
  const worktree = await worktreeCreate(ticketKey, async () => "Fix the thing", repoRoot);
  const activeDir = join(worktree.worktreePath, ".ai", "plans", "active");
  mkdirSync(activeDir, { recursive: true });
  const planPath = join(activeDir, `${ticketKey}-fix-the-thing.md`);
  writeFileSync(
    planPath,
    `# Plan: ${ticketKey} Fix the thing\n\n**Status**: draft\n**Branch**: ${worktree.branch}\n` +
      `**Created**: 2026-01-01\n**Updated**: 2026-01-01\n${openQuestions}${extra}`,
    "utf8",
  );
  return planPath;
}

function writeResult(projectName: string, ticketKey: string, data: unknown): void {
  const path = resultFilePath(projectName, ticketKey, stateRoot);
  mkdirSync(join(stateRoot, projectName, "result"), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf8");
}

describe("runWatchdogPass — alive workers", () => {
  it("does nothing when the heartbeat interval hasn't elapsed yet", async () => {
    const marker = baseMarker({ pid: process.pid, lastHeartbeatAt: new Date().toISOString() });
    writeMarker("my-app", marker, stateRoot);
    const fetchImpl = vi.fn();

    const result = await runWatchdogPass(makeCtx(fetchImpl));

    expect(result.heartbeats).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a heartbeat comment once the interval elapses, using progress-log entries", async () => {
    const now = new Date("2026-01-01T01:00:00.000Z"); // 1h after launch, past planning's 300s interval
    const marker = baseMarker({ pid: process.pid });
    writeMarker("my-app", marker, stateRoot);
    const logPath = progressLogPath("my-app", "DAV-5", stateRoot);
    mkdirSync(join(stateRoot, "my-app", "progress"), { recursive: true });
    writeFileSync(logPath, "Done: read the ticket\nNext: draft a first pass\n", "utf8");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse(undefined, 204);
    });

    const result = await runWatchdogPass(makeCtx(fetchImpl, undefined, now));

    expect(result.heartbeats).toEqual(["DAV-5"]);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/comment"))).toBe(true);
    expect(readMarker("my-app", "DAV-5", stateRoot)?.progressReadPosition).toBe(2);
    expect(readMarker("my-app", "DAV-5", stateRoot)?.lastHeartbeatAt).toBe(now.toISOString());
  });

  it("skips an escalated marker entirely, even if the interval elapsed", async () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    writeMarker("my-app", baseMarker({ pid: process.pid, escalated: true }), stateRoot);
    const fetchImpl = vi.fn();

    const result = await runWatchdogPass(makeCtx(fetchImpl, undefined, now));

    expect(result.heartbeats).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("runWatchdogPass — dead planning worker, result present", () => {
  it("posts the plan and transitions to review when there are no open questions", async () => {
    const planPath = await seedPlan("DAV-5", COMPLETE_SECTIONS);
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ pid: 99999 }), stateRoot);
    writeResult("my-app", "DAV-5", { outcome: "done" });

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:my-repo"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });

    const result = await runWatchdogPass(makeCtx(fetchImpl));

    expect(result.completed).toEqual(["DAV-5"]);
    expect(readMarker("my-app", "DAV-5", stateRoot)).toBeUndefined();
    const commentCall = calls.find((c) => c.startsWith("POST") && c.includes("/comment"));
    expect(commentCall).toBeDefined();
    const labelsPut = calls.find((c) => c.startsWith("PUT") && c.includes("/issue/DAV-5") && !c.includes("assignee"));
    expect(labelsPut).toBeDefined();
    void planPath;
  });

  it("transitions to needs-input when the plan has unresolved open questions", async () => {
    await seedPlan("DAV-5", COMPLETE_SECTIONS, "\n## Open Questions\n\n- [ ] Still open.\n");
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ pid: 99999 }), stateRoot);
    writeResult("my-app", "DAV-5", { outcome: "done" });

    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:my-repo"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });

    const result = await runWatchdogPass(makeCtx(fetchImpl));
    expect(result.completed).toEqual(["DAV-5"]);
    const labelsPut = calls.find((c) => c.body?.includes('"labels"'));
    expect(JSON.parse(labelsPut?.body ?? "{}").fields.labels).toContain("state:needs-input");
  });

  // headless-automation-qa.md Phase E found this live: a plan whose only unresolved item is a
  // non-blocking "## Confirm at Review" note (not "## Open Questions") must still land on
  // state:review, never state:needs-input — that section is reviewed, not a pipeline blocker.
  it("transitions to review (not needs-input) when only Confirm at Review has an unresolved item", async () => {
    await seedPlan(
      "DAV-5",
      COMPLETE_SECTIONS,
      "\n## Open Questions\n\n- [x] Resolved.\n\n## Confirm at Review\n\n- [ ] Recommend as-is.\n",
    );
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ pid: 99999 }), stateRoot);
    writeResult("my-app", "DAV-5", { outcome: "done" });

    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:my-repo"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });

    const result = await runWatchdogPass(makeCtx(fetchImpl));

    expect(result.completed).toEqual(["DAV-5"]);
    const labelsPut = calls.find((c) => c.body?.includes('"labels"'));
    expect(JSON.parse(labelsPut?.body ?? "{}").fields.labels).toContain("state:review");
    const commentCall = calls.find((c) => c.method === "POST" && c.url.includes("/comment"));
    expect(commentCall?.body).toContain("Plan ready for review");
    expect(commentCall?.body).not.toContain("I need answers before finalizing");
  });

  it("retries with a correction note instead of posting/transitioning when a required section is missing", async () => {
    await seedPlan("DAV-5", "\n## Testing strategy\n\nRun `npm test`.\n"); // no Implementation order
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ pid: 99999, attempts: 1 }), stateRoot);
    writeResult("my-app", "DAV-5", { outcome: "done" });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:my-repo"]);
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn().mockReturnValue({ pid: 2, logPath: "/log" });

    const result = await runWatchdogPass(makeCtx(fetchImpl, launch));

    expect(result.restarted).toEqual(["DAV-5"]);
    expect(result.completed).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);
    const options = launch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.attempts).toBe(2);
    const promptContent = readFileSync(options.promptPath as string, "utf8");
    expect(promptContent).toContain("Correction from your previous attempt");
  });

  it("retries with a correction note when only the QA Plan section is missing", async () => {
    await seedPlan("DAV-5", "\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun `npm test`.\n");
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ pid: 99999, attempts: 1 }), stateRoot);
    writeResult("my-app", "DAV-5", { outcome: "done" });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:my-repo"]);
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn().mockReturnValue({ pid: 2, logPath: "/log" });

    const result = await runWatchdogPass(makeCtx(fetchImpl, launch));

    expect(result.restarted).toEqual(["DAV-5"]);
    expect(result.completed).toEqual([]);
    const options = launch.mock.calls[0]?.[1] as Record<string, unknown>;
    const promptContent = readFileSync(options.promptPath as string, "utf8");
    expect(promptContent).toContain("QA Plan");
  });

  it("escalates immediately when the worker reported a blocker", async () => {
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ pid: 99999 }), stateRoot);
    writeResult("my-app", "DAV-5", { outcome: "blocked", notes: "repo doesn't match ticket" });

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn();

    const result = await runWatchdogPass(makeCtx(fetchImpl, launch));

    expect(result.escalated).toEqual(["DAV-5"]);
    expect(launch).not.toHaveBeenCalled();
    expect(readMarker("my-app", "DAV-5", stateRoot)?.escalated).toBe(true);
    expect(calls.some((c) => c.includes("/comment"))).toBe(true);
  });
});

describe("runWatchdogPass — dead implementation worker, result present", () => {
  it("posts a completion comment and transitions to verify on success", async () => {
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ ticketKey: "DAV-9", phase: "implementation", pid: 99999 }), stateRoot);
    writeResult("my-app", "DAV-9", { outcome: "success", summary: "Added the endpoint.", verify: "make test passed" });

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/issue/DAV-9?")) return issueResponse("DAV-9", ["state:working", "app:my-repo"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });

    const result = await runWatchdogPass(makeCtx(fetchImpl));

    expect(result.completed).toEqual(["DAV-9"]);
    expect(readMarker("my-app", "DAV-9", stateRoot)).toBeUndefined();
    expect(calls.some((c) => c.includes("/comment"))).toBe(true);
  });

  it("includes the plan's QA Plan section in the completion comment when one exists", async () => {
    await seedPlan(
      "DAV-9",
      "\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun `npm test`.\n\n" +
        "## QA Plan\n\nManually verify the real endpoint returns 200.\n",
    );
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ ticketKey: "DAV-9", phase: "implementation", pid: 99999 }), stateRoot);
    writeResult("my-app", "DAV-9", { outcome: "success", summary: "Added the endpoint.", verify: "make test passed" });

    let commentBody: unknown;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/issue/DAV-9?")) return issueResponse("DAV-9", ["state:working", "app:my-repo"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      if (url.endsWith("/comment") && init?.body) {
        commentBody = (JSON.parse(init.body as string) as { body: unknown }).body;
      }
      return jsonResponse(undefined, 204);
    });

    await runWatchdogPass(makeCtx(fetchImpl));

    const { adfToPlainText } = await import("../../src/jira/adf.js");
    expect(adfToPlainText(commentBody)).toContain("Manual QA still needed");
    expect(adfToPlainText(commentBody)).toContain("Manually verify the real endpoint returns 200.");
  });

  it("posts a blocked comment and transitions to problem on a blocked outcome", async () => {
    deadPids.add(99999);
    writeMarker("my-app", baseMarker({ ticketKey: "DAV-9", phase: "implementation", pid: 99999 }), stateRoot);
    writeResult("my-app", "DAV-9", { outcome: "blocked", whatHappened: "make test fails" });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issue/DAV-9?")) return issueResponse("DAV-9", ["state:working", "app:my-repo"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me" });
      return jsonResponse(undefined, 204);
    });

    const result = await runWatchdogPass(makeCtx(fetchImpl));
    expect(result.completed).toEqual(["DAV-9"]);
    expect(readMarker("my-app", "DAV-9", stateRoot)).toBeUndefined();
  });
});

describe("runWatchdogPass — dead worker, no result file (stall)", () => {
  it("does nothing while still within the grace period", async () => {
    deadPids.add(99999);
    const now = new Date("2026-01-01T00:05:00.000Z"); // 5 min after launch; planning grace is 600s
    writeMarker("my-app", baseMarker({ pid: 99999 }), stateRoot);
    const fetchImpl = vi.fn();
    const launch = vi.fn();

    const result = await runWatchdogPass(makeCtx(fetchImpl, launch, now));

    expect(result.restarted).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("restarts once the grace period has passed and attempts remain", async () => {
    deadPids.add(99999);
    const now = new Date("2026-01-01T00:15:00.000Z"); // 15 min after launch, past planning's 600s grace
    await seedPlan("DAV-5", COMPLETE_SECTIONS);
    writeMarker("my-app", baseMarker({ pid: 99999, attempts: 1 }), stateRoot);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:my-repo"]);
      return jsonResponse(undefined, 204);
    });
    const launch = vi.fn().mockReturnValue({ pid: 2, logPath: "/log" });

    const result = await runWatchdogPass(makeCtx(fetchImpl, launch, now));

    expect(result.restarted).toEqual(["DAV-5"]);
    expect(launch).toHaveBeenCalledTimes(1);
    const options = launch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.attempts).toBe(2);
  });

  it("escalates once maxAttempts is reached instead of restarting", async () => {
    deadPids.add(99999);
    const now = new Date("2026-01-01T00:15:00.000Z");
    writeMarker("my-app", baseMarker({ pid: 99999, attempts: 2 }), stateRoot); // planning maxAttempts is 2
    const fetchImpl = vi.fn(async () => jsonResponse(undefined, 204));
    const launch = vi.fn();

    const result = await runWatchdogPass(makeCtx(fetchImpl, launch, now));

    expect(result.escalated).toEqual(["DAV-5"]);
    expect(launch).not.toHaveBeenCalled();
    expect(readMarker("my-app", "DAV-5", stateRoot)?.escalated).toBe(true);
  });
});
