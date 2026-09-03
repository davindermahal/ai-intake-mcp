import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { approvePlanTool } from "../../src/tools/approve-plan.js";
import { worktreeCreate } from "../../src/worktree.js";

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

const ISSUE_ME = "me-account-id";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const PLAN_HEADER =
  "# Plan: DAV-5 Fix the thing\n\n**Status**: draft\n**Branch**: feature/DAV-5-fix-the-thing\n**Created**: 2026-01-01\n**Updated**: 2026-01-01\n";
const COMPLETE_SECTIONS =
  "\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun `npm test`.\n\n" +
  "## QA Plan\n\nNone — automated coverage above is sufficient.\n";

let parentDir: string;
let repoRoot: string;
let worktreePath: string;
let planPath: string;

beforeEach(async () => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-approve-plan-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  git(["config", "user.email", "test@example.com"], repoRoot);
  git(["config", "user.name", "Test"], repoRoot);
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });

  const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
  worktreePath = created.worktreePath;

  const activeDir = join(worktreePath, ".ai", "plans", "active");
  mkdirSync(activeDir, { recursive: true });
  planPath = join(activeDir, "DAV-5-fix-the-thing.md");
  writeFileSync(planPath, PLAN_HEADER + COMPLETE_SECTIONS, "utf8");
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

function makeClient(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({ config, fetchImpl });
}

function issueResponse(labels: string[]): Response {
  return jsonResponse({
    key: "DAV-5",
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

describe("approvePlanTool", () => {
  it("transitions Jira first, then flips the plan file Status", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/issue/DAV-5?")) return issueResponse(["state:review"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      return jsonResponse(undefined, 204); // assignee PUT, labels PUT, transitions GET/POST
    });

    const result = await approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot);

    expect(result).toEqual({ planPath, transitionedTo: "implement" });
    expect(readFileSync(planPath, "utf8")).toContain("**Status**: ready");

    const labelsPutIndex = calls.findIndex((c) => c.startsWith("PUT") && c.includes("/issue/DAV-5") && !c.includes("assignee"));
    expect(labelsPutIndex).toBeGreaterThanOrEqual(0);
  });

  it("never touches the plan file if the Jira transition fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/issue/DAV-5?")) return issueResponse(["state:review"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      if ((init?.method ?? "GET") === "PUT") return new Response("boom", { status: 500 });
      return jsonResponse(undefined, 204);
    });

    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow();
    expect(readFileSync(planPath, "utf8")).toContain("**Status**: draft");
  });

  it("refuses when the ticket isn't state:review", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/issue/DAV-5?")) return issueResponse(["state:plan"]);
      return jsonResponse(undefined, 204);
    });
    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /not "state:review"/,
    );
  });

  it("refuses when the plan file isn't draft", async () => {
    writeFileSync(planPath, PLAN_HEADER.replace("**Status**: draft", "**Status**: ready") + COMPLETE_SECTIONS, "utf8");
    const fetchImpl = vi.fn();
    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /not "draft"/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the plan has an unresolved Open Questions item", async () => {
    writeFileSync(
      planPath,
      `${PLAN_HEADER}\n## Open Questions\n\n- [ ] Still open.\n${COMPLETE_SECTIONS}`,
      "utf8",
    );
    const fetchImpl = vi.fn();
    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /unresolved "- \[ \]" items/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the plan has no Implementation order section", async () => {
    writeFileSync(planPath, `${PLAN_HEADER}\n## Testing strategy\n\nRun \`npm test\`.\n`, "utf8");
    const fetchImpl = vi.fn();
    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /no "## Implementation order" section/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the plan has no Testing strategy section", async () => {
    writeFileSync(planPath, `${PLAN_HEADER}\n## Implementation order\n\n1. Fix the thing.\n`, "utf8");
    const fetchImpl = vi.fn();
    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /no "## Testing strategy" section/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the plan has no QA Plan section", async () => {
    writeFileSync(
      planPath,
      `${PLAN_HEADER}\n## Implementation order\n\n1. Fix the thing.\n\n## Testing strategy\n\nRun \`npm test\`.\n`,
      "utf8",
    );
    const fetchImpl = vi.fn();
    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /no "## QA Plan" section/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("approves once every Open Questions item is checked off", async () => {
    writeFileSync(
      planPath,
      `${PLAN_HEADER}\n## Open Questions\n\n- [x] Resolved.\n${COMPLETE_SECTIONS}`,
      "utf8",
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issue/DAV-5?")) return issueResponse(["state:review"]);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      return jsonResponse(undefined, 204);
    });

    const result = await approvePlanTool(makeClient(fetchImpl), config, "DAV-5", repoRoot);
    expect(result).toEqual({ planPath, transitionedTo: "implement" });
  });

  it("refuses when no worktree exists for the ticket", async () => {
    const fetchImpl = vi.fn();
    await expect(approvePlanTool(makeClient(fetchImpl), config, "DAV-9", repoRoot)).rejects.toThrow(
      /No worktree found/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
