import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { healthCheck } from "../../src/tools/health-check.js";

const config: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeClient(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({ config, fetchImpl });
}

describe("healthCheck", () => {
  it("fails fast on a credential/connectivity error, without checking statuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }));
    const result = await healthCheck(makeClient(fetchImpl), config);
    expect(result.ok).toBe(false);
    expect(result.details[0]).toMatch(/Credential\/connectivity check failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("succeeds when authenticated and the in-progress status exists", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me", displayName: "Bot" });
      if (url.endsWith("/status")) return jsonResponse([{ name: "In Progress" }, { name: "Done" }]);
      throw new Error(`unexpected url ${url}`);
    });
    const result = await healthCheck(makeClient(fetchImpl), config);
    expect(result.ok).toBe(true);
    expect(result.details.some((d) => d.includes("Authenticated as Bot"))).toBe(true);
    expect(result.details.some((d) => d.includes('Native status "In Progress" exists'))).toBe(true);
  });

  it("reports ok:false when the in-progress status doesn't exist on the site", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me", displayName: "Bot" });
      if (url.endsWith("/status")) return jsonResponse([{ name: "Backlog" }]);
      throw new Error(`unexpected url ${url}`);
    });
    const result = await healthCheck(makeClient(fetchImpl), config);
    expect(result.ok).toBe(false);
    expect(result.details.some((d) => d.includes("was not found"))).toBe(true);
  });

  it("reports ok:false when the status check itself fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/myself")) return jsonResponse({ accountId: "me", displayName: "Bot" });
      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    });
    const result = await healthCheck(makeClient(fetchImpl), config);
    expect(result.ok).toBe(false);
    expect(result.details.some((d) => d.includes("Native status check failed"))).toBe(true);
  });
});
