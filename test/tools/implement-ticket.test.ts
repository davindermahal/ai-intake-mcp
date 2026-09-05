import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { implementTicketTool } from "../../src/tools/implement-ticket.js";
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

let parentDir: string;
let repoRoot: string;
let worktreePath: string;
let planPath: string;

function writePlan(status: string, includeBoundaries: boolean): void {
  const boundaries = includeBoundaries
    ? "\n## Boundaries\n\nNo files outside src/ may be touched.\n"
    : "";
  writeFileSync(
    planPath,
    `# Plan: DAV-5 Fix the thing\n\n**Status**: ${status}\n**Branch**: feature/DAV-5-fix-the-thing\n**Created**: 2026-01-01\n**Updated**: 2026-01-01\n${boundaries}`,
    "utf8",
  );
}

beforeEach(async () => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-implement-ticket-test-"));
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
  writePlan("ready", true);
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

function implementFetchImpl(labels: string[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/issue/DAV-5?")) return issueResponse(labels);
    if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
    return jsonResponse(undefined, 204); // assignee PUT, labels PUT, transitions GET/POST
  }) as unknown as typeof fetch;
}

describe("implementTicketTool", () => {
  it("refuses when the plan has no Boundaries section, without ever calling Jira", async () => {
    writePlan("ready", false);
    const fetchImpl = vi.fn();

    await expect(implementTicketTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /no "## Boundaries" section/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("proceeds when the plan has a Boundaries section", async () => {
    const fetchImpl = implementFetchImpl(["state:implement"]);

    const result = await implementTicketTool(makeClient(fetchImpl), config, "DAV-5", repoRoot);

    expect(result).toEqual({ worktreePath, branch: "feature/DAV-5-fix-the-thing", planPath });
  });

  it("accepts a Boundaries heading with trailing content on the same line", async () => {
    writeFileSync(
      planPath,
      "# Plan: DAV-5 Fix the thing\n\n**Status**: ready\n**Branch**: feature/DAV-5-fix-the-thing\n**Created**: 2026-01-01\n**Updated**: 2026-01-01\n\n## Boundaries\n\nDo not touch tests/.\n",
      "utf8",
    );
    const fetchImpl = implementFetchImpl(["state:implement"]);

    await expect(implementTicketTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).resolves.toBeDefined();
  });

  it("still enforces the plan Status check before the Boundaries check", async () => {
    writePlan("draft", false);
    const fetchImpl = vi.fn();

    await expect(implementTicketTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /is "draft"/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still checks readFileSync(planPath) content after status even when Boundaries is present but Jira state is wrong", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/issue/DAV-5?")) return issueResponse(["state:plan"]);
      return jsonResponse(undefined, 204);
    }) as unknown as typeof fetch;

    await expect(implementTicketTool(makeClient(fetchImpl), config, "DAV-5", repoRoot)).rejects.toThrow(
      /not "state:implement"\/"state:working"/,
    );
    expect(readFileSync(planPath, "utf8")).toContain("**Status**: ready");
  });
});
