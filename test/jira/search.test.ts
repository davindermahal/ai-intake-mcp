import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { buildDiscoveryJql, searchIssues } from "../../src/jira/search.js";

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

describe("buildDiscoveryJql", () => {
  it("builds a query for one project key and one state label", () => {
    const jql = buildDiscoveryJql({ projectKeys: ["DAV"], appTag: "app:my-repo", stateLabels: ["plan"] });
    expect(jql).toBe(
      'project in ("DAV") AND labels = "app:my-repo" AND labels = "state:plan" AND assignee = currentUser() ORDER BY created ASC',
    );
  });

  it("spans multiple project keys in one project in (...) clause", () => {
    const jql = buildDiscoveryJql({
      projectKeys: ["DAV", "OPS"],
      appTag: "app:my-repo",
      stateLabels: ["plan"],
    });
    expect(jql).toContain('project in ("DAV", "OPS")');
  });

  it("ORs multiple state labels together", () => {
    const jql = buildDiscoveryJql({
      projectKeys: ["DAV"],
      appTag: "app:my-repo",
      stateLabels: ["plan", "needs-input"],
    });
    expect(jql).toContain('(labels = "state:plan" OR labels = "state:needs-input")');
  });

  it("omits the assignee clause when assignedToCurrentUser is false", () => {
    const jql = buildDiscoveryJql({
      projectKeys: ["DAV"],
      appTag: "app:my-repo",
      stateLabels: ["plan"],
      assignedToCurrentUser: false,
    });
    expect(jql).not.toContain("assignee");
  });

  it("throws when projectKeys is empty", () => {
    expect(() => buildDiscoveryJql({ projectKeys: [], appTag: "app:my-repo", stateLabels: ["plan"] })).toThrow(
      /projectKeys/,
    );
  });

  it("throws when stateLabels is empty", () => {
    expect(() => buildDiscoveryJql({ projectKeys: ["DAV"], appTag: "app:my-repo", stateLabels: [] })).toThrow(
      /stateLabels/,
    );
  });
});

describe("searchIssues", () => {
  it("posts the JQL and maps every returned issue", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse({
        issues: [
          {
            key: "DAV-1",
            fields: {
              summary: "First",
              status: { name: "To Do" },
              description: null,
              comment: { comments: [] },
              labels: ["state:plan", "app:my-repo"],
              assignee: null,
            },
          },
          {
            key: "DAV-2",
            fields: {
              summary: "Second",
              status: { name: "To Do" },
              description: null,
              comment: { comments: [] },
              labels: ["state:needs-input", "app:my-repo"],
              assignee: null,
            },
          },
        ],
      });
    });

    const jql = 'project in ("DAV") AND labels = "app:my-repo"';
    const issues = await searchIssues(makeClient(fetchImpl), jql);

    expect(capturedBody).toMatchObject({ jql });
    expect(issues.map((i) => i.key)).toEqual(["DAV-1", "DAV-2"]);
    expect(issues[0]?.summary).toBe("First");
  });

  it("returns an empty array when nothing matches", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));
    const issues = await searchIssues(makeClient(fetchImpl), 'project in ("DAV")');
    expect(issues).toEqual([]);
  });
});
