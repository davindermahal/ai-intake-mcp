import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { trackerAddComment } from "../../src/tools/tracker-add-comment.js";

const config: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

function makeClient(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({ config, fetchImpl });
}

describe("trackerAddComment", () => {
  it("posts to the comment endpoint with the text and a stamped footer", async () => {
    let seenUrl: string | undefined;
    let seenBody: string | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ id: "10001" }), { status: 200 });
    });

    const result = await trackerAddComment(makeClient(fetchImpl), "DAV-5", "All done.", {
      name: "Claude Code",
      version: "1.0",
    });

    expect(result).toEqual({ id: "10001" });
    expect(seenUrl).toContain("/issue/DAV-5/comment");
    expect(seenBody).toContain("Posted by Claude Code via ai-intake-mcp");
    expect(seenBody).toContain("All done.");
  });

  it("falls back to a generic footer when clientInfo is undefined", async () => {
    let seenBody: string | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ id: "10002" }), { status: 200 });
    });

    await trackerAddComment(makeClient(fetchImpl), "DAV-5", "Note.", undefined);
    expect(seenBody).toContain("Posted by AI via ai-intake-mcp");
  });
});
