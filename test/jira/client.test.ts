import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraApiError, JiraClient } from "../../src/jira/client.js";

const baseConfig: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

describe("JiraClient token auth", () => {
  it("sends Basic auth built from email + token", async () => {
    let seenAuth: string | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new JiraClient({ config: baseConfig, fetchImpl });
    await client.get("/rest/api/3/myself");

    const expected = `Basic ${Buffer.from("bot@example.com:test-token").toString("base64")}`;
    expect(seenAuth).toBe(expected);
  });

  it("throws JiraApiError with status/body on a non-ok response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("issue does not exist", { status: 404, statusText: "Not Found" }),
    );
    const client = new JiraClient({ config: baseConfig, fetchImpl });
    await expect(client.get("/rest/api/3/issue/DAV-999")).rejects.toMatchObject(
      new JiraApiError(404, "Not Found", "issue does not exist"),
    );
  });

  it("returns undefined for a 204 No Content response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new JiraClient({ config: baseConfig, fetchImpl });
    await expect(client.put("/rest/api/3/issue/DAV-5", {})).resolves.toBeUndefined();
  });
});
