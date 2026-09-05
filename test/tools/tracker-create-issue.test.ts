import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { trackerCreateIssue } from "../../src/tools/tracker-create-issue.js";

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
  repoRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-tracker-create-issue-test-"));
  execFileSync("git", ["init", "-b", "main", repoRoot]);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeRepoConfigFile(config_: Record<string, unknown>): void {
  mkdirSync(join(repoRoot, ".ai"), { recursive: true });
  writeFileSync(join(repoRoot, ".ai", "intake-mcp.json"), JSON.stringify(config_), "utf8");
}

describe("trackerCreateIssue", () => {
  it("refuses when the repo isn't configured", async () => {
    const fetchImpl = vi.fn();
    await expect(
      trackerCreateIssue(makeClient(fetchImpl), config, "New ticket", undefined, undefined, repoRoot),
    ).rejects.toThrow(/isn't configured yet/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates the issue in the repo's first configured project and returns key + url", async () => {
    writeRepoConfigFile({ jiraProjectKeys: ["DAV", "OPS"], appTag: "app:my-repo" });
    let createBody: string | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/rest/api/3/issue")) {
        createBody = String(init?.body);
        return jsonResponse({ key: "DAV-99" });
      }
      if (url.includes("/issue/DAV-99?")) return issueResponse("DAV-99", []);
      return jsonResponse(undefined, 204);
    });

    const result = await trackerCreateIssue(
      makeClient(fetchImpl),
      config,
      "New ticket",
      "Some description",
      undefined,
      repoRoot,
    );

    expect(result).toEqual({ key: "DAV-99", url: "https://example.atlassian.net/browse/DAV-99" });
    expect(createBody).toBeDefined();
    const parsed = JSON.parse(createBody!);
    expect(parsed.fields.project).toEqual({ key: "DAV" });
    expect(parsed.fields.summary).toBe("New ticket");
    expect(parsed.fields.issuetype).toEqual({ name: "Task" });
    expect(parsed.fields.description).toBeDefined();
  });

  it("defaults issue_type to Task when omitted, and passes through an explicit one", async () => {
    writeRepoConfigFile({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo" });
    let lastIssueType: string | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/rest/api/3/issue")) {
        lastIssueType = JSON.parse(String(init?.body)).fields.issuetype.name;
        return jsonResponse({ key: "DAV-100" });
      }
      if (url.includes("/issue/DAV-100?")) return issueResponse("DAV-100", []);
      return jsonResponse(undefined, 204);
    });

    await trackerCreateIssue(makeClient(fetchImpl), config, "Bug ticket", undefined, "Bug", repoRoot);
    expect(lastIssueType).toBe("Bug");
  });

  it("bootstraps the newly created ticket with state:plan + the app tag", async () => {
    writeRepoConfigFile({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo" });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && url.endsWith("/rest/api/3/issue")) return jsonResponse({ key: "DAV-101" });
      if (url.includes("/issue/DAV-101?")) return issueResponse("DAV-101", []);
      return jsonResponse(undefined, 204);
    });

    await trackerCreateIssue(makeClient(fetchImpl), config, "New ticket", undefined, undefined, repoRoot);
    const labelsPut = calls.find((c) => c.startsWith("PUT") && c.includes("/issue/DAV-101") && !c.includes("assignee"));
    expect(labelsPut).toBeDefined();
  });
});
