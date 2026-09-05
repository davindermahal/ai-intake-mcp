import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import {
  AppTagConflictError,
  AssigneeConflictError,
  STATE_LABEL,
  TRANSITION_TARGETS,
  addComment,
  assertAssigneeOrAutoAssign,
  bootstrapIfNeeded,
  fetchIssue,
  isTransitionTarget,
  transitionState,
  type JiraIssue,
} from "../../src/jira/tags.js";

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

function clientWith(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({ config, fetchImpl });
}

const ISSUE_ME = "me-account-id";

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "DAV-5",
    projectKey: "DAV",
    summary: "Test ticket",
    statusName: "Open",
    description: "",
    comments: [],
    labels: [],
    assigneeAccountId: null,
    ...overrides,
  };
}

describe("fetchIssue", () => {
  it("parses ADF description/comments and derives the project key", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        key: "DAV-5",
        fields: {
          summary: "Fix the thing",
          status: { name: "Open" },
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
          comment: {
            comments: [
              {
                author: { displayName: "Ada" },
                created: "2026-01-01",
                body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
              },
            ],
          },
          labels: ["state:plan"],
          assignee: null,
        },
      }),
    );

    const issue = await fetchIssue(clientWith(fetchImpl), "DAV-5");
    expect(issue.projectKey).toBe("DAV");
    expect(issue.description).toBe("hello");
    expect(issue.comments).toEqual([{ author: "Ada", body: "hi", created: "2026-01-01" }]);
    expect(issue.labels).toEqual(["state:plan"]);
  });
});

describe("assertAssigneeOrAutoAssign", () => {
  it("proceeds without writing when already assigned to me", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ accountId: ISSUE_ME }));
    await assertAssigneeOrAutoAssign(clientWith(fetchImpl), makeIssue({ assigneeAccountId: ISSUE_ME }));
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only /myself, no write
  });

  it("auto-assigns when unassigned", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
      if (String(input).endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      return jsonResponse(undefined, 204);
    });
    await assertAssigneeOrAutoAssign(clientWith(fetchImpl), makeIssue({ assigneeAccountId: null }));
    expect(calls).toEqual([
      "GET https://example.atlassian.net/rest/api/3/myself",
      "PUT https://example.atlassian.net/rest/api/3/issue/DAV-5/assignee",
    ]);
  });

  it("refuses when assigned to someone else", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ accountId: ISSUE_ME }));
    await expect(
      assertAssigneeOrAutoAssign(clientWith(fetchImpl), makeIssue({ assigneeAccountId: "someone-else" })),
    ).rejects.toBeInstanceOf(AssigneeConflictError);
  });
});

describe("bootstrapIfNeeded", () => {
  it("adds state:plan and app tag when both are missing", async () => {
    let putBody: unknown;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      putBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse(undefined, 204);
    });
    const written = await bootstrapIfNeeded(clientWith(fetchImpl), makeIssue({ labels: [] }), "app:my-repo");
    expect(written).toEqual([STATE_LABEL.plan, "app:my-repo"]);
    expect(putBody).toEqual({ fields: { labels: [STATE_LABEL.plan, "app:my-repo"] } });
  });

  it("does nothing when both labels already present", async () => {
    const fetchImpl = vi.fn();
    const written = await bootstrapIfNeeded(
      clientWith(fetchImpl),
      makeIssue({ labels: ["state:review", "app:my-repo"] }),
      "app:my-repo",
    );
    expect(written).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when tagged for a different app", async () => {
    const fetchImpl = vi.fn();
    await expect(
      bootstrapIfNeeded(clientWith(fetchImpl), makeIssue({ labels: ["app:other-repo"] }), "app:my-repo"),
    ).rejects.toBeInstanceOf(AppTagConflictError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("transitionState", () => {
  it("swaps the state label and mirrors the native status when a matching transition exists", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      if (url.endsWith("/transitions")) {
        if (init?.method === "POST") return jsonResponse(undefined, 204);
        return jsonResponse({ transitions: [{ id: "21", to: { name: "In Progress" } }] });
      }
      return jsonResponse(undefined, 204); // labels PUT
    });

    const result = await transitionState(
      clientWith(fetchImpl),
      makeIssue({ assigneeAccountId: ISSUE_ME, labels: [STATE_LABEL.plan] }),
      "needs-input",
      config,
    );

    expect(result).toEqual({ mirrored: true, note: 'Mirrored to native status "In Progress".' });
    expect(calls).toContain("POST https://example.atlassian.net/rest/api/3/issue/DAV-5/transitions");
  });

  it("never throws when no matching native-status transition exists", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      if (url.endsWith("/transitions")) return jsonResponse({ transitions: [] });
      return jsonResponse(undefined, 204);
    });

    const result = await transitionState(
      clientWith(fetchImpl),
      makeIssue({ assigneeAccountId: ISSUE_ME }),
      "review",
      config,
    );
    expect(result.mirrored).toBe(false);
  });
});

describe("addComment", () => {
  it("posts an ADF body containing the text and footer", async () => {
    let body: { body: { content: { content: { text: string }[] }[] } } | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse(undefined, 204);
    });
    await addComment(clientWith(fetchImpl), "DAV-5", "Plan ready.", "🤖 _Posted by Claude Code_");
    const text = body?.body.content.map((p) => p.content.map((c) => c.text).join("")).join("\n");
    expect(text).toContain("Plan ready.");
    expect(text).toContain("Posted by Claude Code");
  });
});

describe("transition target vocabulary", () => {
  it("excludes plan and implement from valid transition targets", () => {
    expect(TRANSITION_TARGETS).toEqual(["needs-input", "review", "working", "verify", "problem"]);
    expect(isTransitionTarget("plan")).toBe(false);
    expect(isTransitionTarget("implement")).toBe(false);
    expect(isTransitionTarget("review")).toBe(true);
    expect(isTransitionTarget("working")).toBe(true);
    expect(isTransitionTarget("verify")).toBe(true);
    expect(isTransitionTarget("problem")).toBe(true);
  });
});

describe("native status mapping (implementation phase)", () => {
  it("mirrors verify to the code-review column", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      if (url.endsWith("/transitions")) {
        if (init?.method === "POST") return jsonResponse(undefined, 204);
        return jsonResponse({ transitions: [{ id: "9", to: { name: "Code Review" } }] });
      }
      return jsonResponse(undefined, 204);
    });

    const result = await transitionState(
      clientWith(fetchImpl),
      makeIssue({ assigneeAccountId: ISSUE_ME, labels: [STATE_LABEL.working] }),
      "verify",
      config,
    );
    expect(result).toEqual({ mirrored: true, note: 'Mirrored to native status "Code Review".' });
  });

  it("mirrors implement/working/problem to the in-progress column", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: ISSUE_ME });
      if (url.endsWith("/transitions") && init?.method !== "POST") {
        return jsonResponse({ transitions: [{ id: "1", to: { name: "In Progress" } }] });
      }
      return jsonResponse(undefined, 204);
    });

    for (const target of ["implement", "working", "problem"] as const) {
      const result = await transitionState(
        clientWith(fetchImpl),
        makeIssue({ assigneeAccountId: ISSUE_ME }),
        target,
        config,
      );
      expect(result.note).toBe('Mirrored to native status "In Progress".');
    }
  });
});
