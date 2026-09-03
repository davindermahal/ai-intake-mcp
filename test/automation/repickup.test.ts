import { describe, expect, it } from "vitest";
import type { JiraIssue } from "../../src/jira/tags.js";
import { hasAuthorReplySinceLastAutomationComment } from "../../src/automation/repickup.js";

function issue(comments: { author: string; body: string; created: string }[]): JiraIssue {
  return {
    key: "DAV-5",
    projectKey: "DAV",
    summary: "Test",
    statusName: "To Do",
    description: "",
    comments,
    labels: ["state:needs-input"],
    assigneeAccountId: null,
  };
}

describe("hasAuthorReplySinceLastAutomationComment", () => {
  it("returns false when there is no automation comment yet", () => {
    expect(
      hasAuthorReplySinceLastAutomationComment(
        issue([{ author: "Dev", body: "Just a normal comment.", created: "2026-01-01" }]),
      ),
    ).toBe(false);
  });

  it("returns true when an author reply follows the last automation comment", () => {
    expect(
      hasAuthorReplySinceLastAutomationComment(
        issue([
          { author: "AI", body: "Plan ready.\n\n🤖 _Posted by Claude via ai-intake-mcp_", created: "2026-01-01" },
          { author: "Dev", body: "Here's the answer to your question.", created: "2026-01-02" },
        ]),
      ),
    ).toBe(true);
  });

  it("returns false when no reply has landed since the last automation comment", () => {
    expect(
      hasAuthorReplySinceLastAutomationComment(
        issue([
          { author: "Dev", body: "Original question context.", created: "2026-01-01" },
          { author: "AI", body: "Blocked on X.\n\n🤖 _Posted by Gemini via ai-intake-mcp_", created: "2026-01-02" },
        ]),
      ),
    ).toBe(false);
  });

  it("does not count automation's own later comment as an author reply", () => {
    expect(
      hasAuthorReplySinceLastAutomationComment(
        issue([
          { author: "AI", body: "Blocked on X.\n\n🤖 _Posted by Claude via ai-intake-mcp_", created: "2026-01-01" },
          {
            author: "AI",
            body: "Heartbeat: still waiting.\n\n🤖 _Posted by Claude via ai-intake-mcp_",
            created: "2026-01-02",
          },
        ]),
      ),
    ).toBe(false);
  });

  it("only looks at replies after the LAST automation comment, not the first", () => {
    expect(
      hasAuthorReplySinceLastAutomationComment(
        issue([
          { author: "Dev", body: "An old reply, already handled.", created: "2026-01-01" },
          { author: "AI", body: "Bounced again.\n\n🤖 _Posted by Claude via ai-intake-mcp_", created: "2026-01-02" },
        ]),
      ),
    ).toBe(false);
  });
});
