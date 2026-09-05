import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { trackerTransition } from "../../src/tools/tracker-transition.js";
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

beforeEach(async () => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-tracker-transition-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  git(["config", "user.email", "test@example.com"], repoRoot);
  git(["config", "user.name", "Test"], repoRoot);
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
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

function fetchImplFor(labels: string[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/issue/DAV-5?")) return issueResponse(labels);
    if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
    if (url.endsWith("/transitions")) return jsonResponse({ transitions: [] });
    return jsonResponse(undefined, 204);
  }) as unknown as typeof fetch;
}

describe("trackerTransition — verify-time skipTargets/Makefile check", () => {
  function writeIntakeConfig(worktreePath: string, repoConfig: Record<string, unknown>): void {
    mkdirSync(join(worktreePath, ".ai"), { recursive: true });
    writeFileSync(join(worktreePath, ".ai", "intake-mcp.json"), JSON.stringify(repoConfig), "utf8");
  }

  it("refuses when a declared skipTargets entry is actually defined in the Makefile", async () => {
    const worktree = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    writeFileSync(join(worktree.worktreePath, "Makefile"), "lint:\n\techo lint\n", "utf8");
    writeIntakeConfig(worktree.worktreePath, { jiraProjectKey: "DAV", appTag: "app:x", skipTargets: ["lint"] });
    const fetchImpl = vi.fn();

    await expect(
      trackerTransition(makeClient(fetchImpl), config, "DAV-5", "verify", worktree.worktreePath),
    ).rejects.toThrow(/Makefile defines "lint".*skipTargets/s);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("proceeds when skipTargets doesn't contradict the Makefile", async () => {
    const worktree = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    writeFileSync(join(worktree.worktreePath, "Makefile"), "build:\n\techo build\n", "utf8");
    writeIntakeConfig(worktree.worktreePath, { jiraProjectKey: "DAV", appTag: "app:x", skipTargets: ["lint"] });
    const fetchImpl = fetchImplFor(["state:working"]);

    const result = await trackerTransition(makeClient(fetchImpl), config, "DAV-5", "verify", worktree.worktreePath);
    expect(result.mirrored).toBe(false);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("proceeds when there's no worktree for the ticket at all", async () => {
    const fetchImpl = fetchImplFor(["state:working"]);
    const result = await trackerTransition(makeClient(fetchImpl), config, "DAV-5", "verify", repoRoot);
    expect(result.mirrored).toBe(false);
  });

  it("proceeds when the config declares no skipTargets", async () => {
    const worktree = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    writeFileSync(join(worktree.worktreePath, "Makefile"), "lint:\n\techo lint\n", "utf8");
    writeIntakeConfig(worktree.worktreePath, { jiraProjectKey: "DAV", appTag: "app:x" });
    const fetchImpl = fetchImplFor(["state:working"]);

    const result = await trackerTransition(makeClient(fetchImpl), config, "DAV-5", "verify", worktree.worktreePath);
    expect(result.mirrored).toBe(false);
  });

  it("does not run the check for a non-verify transition", async () => {
    const worktree = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    writeFileSync(join(worktree.worktreePath, "Makefile"), "lint:\n\techo lint\n", "utf8");
    writeIntakeConfig(worktree.worktreePath, { jiraProjectKey: "DAV", appTag: "app:x", skipTargets: ["lint"] });
    const fetchImpl = fetchImplFor(["state:review"]);

    const result = await trackerTransition(makeClient(fetchImpl), config, "DAV-5", "problem", worktree.worktreePath);
    expect(result.mirrored).toBe(false);
  });
});
