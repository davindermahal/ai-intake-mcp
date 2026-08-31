import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { trackerGetIssue } from "../../src/tools/tracker-get-issue.js";

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

function makeClient(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({ config, fetchImpl });
}

function issueResponse(key: string, labels: string[]): Response {
  return jsonResponse({
    key,
    fields: {
      summary: "Test ticket",
      status: { name: "To Do" },
      description: null,
      comment: { comments: [] },
      labels,
      assignee: null,
    },
  });
}

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-tracker-get-issue-test-"));
  execFileSync("git", ["init", "-b", "main", repoRoot]);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeRepoConfigFile(config_: Record<string, unknown>): void {
  mkdirSync(join(repoRoot, ".ai"), { recursive: true });
  writeFileSync(join(repoRoot, ".ai", "intake-mcp.json"), JSON.stringify(config_), "utf8");
}

describe("trackerGetIssue", () => {
  it("refuses when the repo isn't configured", async () => {
    const fetchImpl = vi.fn();
    await expect(trackerGetIssue(makeClient(fetchImpl), "DAV-5", repoRoot)).rejects.toThrow(
      /isn't configured yet/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the ticket belongs to a different Jira project", async () => {
    writeRepoConfigFile({ jiraProjectKey: "DAV", appTag: "app:my-repo" });
    const fetchImpl = vi.fn(async () => issueResponse("OTHER-1", ["state:plan", "app:my-repo"]));
    await expect(trackerGetIssue(makeClient(fetchImpl), "OTHER-1", repoRoot)).rejects.toThrow(
      /belongs to Jira project "OTHER", not "DAV"/,
    );
  });

  it("returns the issue summary/status/description/comments when configured and matching", async () => {
    writeRepoConfigFile({ jiraProjectKey: "DAV", appTag: "app:my-repo" });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:my-repo"]);
      return jsonResponse(undefined, 204);
    });

    const result = await trackerGetIssue(makeClient(fetchImpl), "DAV-5", repoRoot);
    expect(result).toEqual({
      summary: "Test ticket",
      status: "To Do",
      description: "",
      comments: [],
    });
  });

  it("bootstraps an untouched ticket with state:plan + the app tag", async () => {
    writeRepoConfigFile({ jiraProjectKey: "DAV", appTag: "app:my-repo" });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", []);
      return jsonResponse(undefined, 204);
    });

    await trackerGetIssue(makeClient(fetchImpl), "DAV-5", repoRoot);
    const labelsPut = calls.find((c) => c.startsWith("PUT") && c.includes("/issue/DAV-5") && !c.includes("assignee"));
    expect(labelsPut).toBeDefined();
  });

  it("propagates an app-tag conflict from bootstrapIfNeeded", async () => {
    writeRepoConfigFile({ jiraProjectKey: "DAV", appTag: "app:my-repo" });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issue/DAV-5?")) return issueResponse("DAV-5", ["state:plan", "app:other-repo"]);
      return jsonResponse(undefined, 204);
    });

    await expect(trackerGetIssue(makeClient(fetchImpl), "DAV-5", repoRoot)).rejects.toThrow(
      /tagged app:other-repo, not app:my-repo/,
    );
  });
});
