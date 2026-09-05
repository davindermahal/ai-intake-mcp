import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import {
  maybeAddComment,
  maybeDeleteMarker,
  maybeSetPlanStatus,
  maybeTransition,
  maybeWriteMarker,
} from "../../src/automation/dry-run.js";
import { readMarker, writeMarker, type WorkerMarker } from "../../src/automation/markers.js";
import { JiraClient } from "../../src/jira/client.js";
import type { JiraIssue } from "../../src/jira/tags.js";

const config: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function issue(): JiraIssue {
  return {
    key: "DAV-5",
    projectKey: "DAV",
    summary: "Fix the thing",
    statusName: "To Do",
    description: "",
    comments: [],
    labels: ["state:review"],
    assigneeAccountId: "me",
  };
}

describe("maybeAddComment / maybeTransition", () => {
  it("makes no live call at all when dryRun is true", async () => {
    const fetchImpl = vi.fn();
    const client = new JiraClient({ config, fetchImpl });

    await maybeAddComment({ dryRun: true }, client, "DAV-5", "hello", "footer");
    await maybeTransition({ dryRun: true }, client, issue(), "review", config);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("performs the real call when dryRun is false or unset", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(undefined, 204));
    const client = new JiraClient({ config, fetchImpl });

    await maybeAddComment({}, client, "DAV-5", "hello", "footer");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-dry-run-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("maybeSetPlanStatus", () => {
  it("leaves the plan file untouched when dryRun is true", () => {
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "**Status**: draft\n**Updated**: 2026-01-01\n", "utf8");

    maybeSetPlanStatus({ dryRun: true }, planPath, "ready");

    expect(readFileSync(planPath, "utf8")).toContain("**Status**: draft");
  });

  it("writes the status change when dryRun is false", () => {
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "**Status**: draft\n**Updated**: 2026-01-01\n", "utf8");

    maybeSetPlanStatus({}, planPath, "ready");

    expect(readFileSync(planPath, "utf8")).toContain("**Status**: ready");
  });
});

function marker(overrides: Partial<WorkerMarker> = {}): WorkerMarker {
  return {
    ticketKey: "DAV-5",
    phase: "planning",
    pid: 1,
    launchedAt: "x",
    lastHeartbeatAt: "x",
    progressReadPosition: 0,
    attempts: 1,
    escalated: false,
    ...overrides,
  };
}

describe("maybeWriteMarker / maybeDeleteMarker", () => {
  it("leaves marker state untouched when dryRun is true", () => {
    writeMarker("my-app", marker(), dir);

    maybeWriteMarker({ dryRun: true }, "my-app", marker({ escalated: true }), dir);
    expect(readMarker("my-app", "DAV-5", dir)?.escalated).toBe(false);

    maybeDeleteMarker({ dryRun: true }, "my-app", "DAV-5", dir);
    expect(readMarker("my-app", "DAV-5", dir)).toBeDefined();
  });

  it("mutates marker state for real when dryRun is false", () => {
    writeMarker("my-app", marker(), dir);

    maybeWriteMarker({}, "my-app", marker({ escalated: true }), dir);
    expect(readMarker("my-app", "DAV-5", dir)?.escalated).toBe(true);

    maybeDeleteMarker({}, "my-app", "DAV-5", dir);
    expect(readMarker("my-app", "DAV-5", dir)).toBeUndefined();
  });
});
