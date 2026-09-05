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

describe("JiraClient retry/backoff", () => {
  function noSleepClient(fetchImpl: typeof fetch): { client: JiraClient; sleeps: number[] } {
    const sleeps: number[] = [];
    const client = new JiraClient({
      config: baseConfig,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { client, sleeps };
  }

  it("retries a 429 honoring Retry-After (seconds), then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("slow down", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "2" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { client, sleeps } = noSleepClient(fetchImpl);
    await expect(client.get("/rest/api/3/myself")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("retries a 5xx with capped exponential backoff when no Retry-After is given", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response("boom", { status: 503, statusText: "Service Unavailable" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { client, sleeps } = noSleepClient(fetchImpl);
    await expect(client.get("/rest/api/3/myself")).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("retries a network-level fetch failure", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { client } = noSleepClient(fetchImpl);
    await expect(client.get("/rest/api/3/myself")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("throws JiraApiError after exhausting retries on a persistent 429", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("slow down", { status: 429, statusText: "Too Many Requests" }),
    );
    const { client, sleeps } = noSleepClient(fetchImpl);
    await expect(client.get("/rest/api/3/myself")).rejects.toBeInstanceOf(JiraApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2); // slept between attempts 1→2 and 2→3, not after the final attempt
  });

  it("does not retry a non-retryable 4xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" }));
    const { client } = noSleepClient(fetchImpl);
    await expect(client.get("/rest/api/3/issue/DAV-999")).rejects.toBeInstanceOf(JiraApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
