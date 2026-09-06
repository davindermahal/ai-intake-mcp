import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { ConfluenceApiError, ConfluenceClient, extractPageIdFromUrl, fetchPageByUrl } from "../../src/confluence/client.js";

const baseConfig: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "jira-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

describe("ConfluenceClient auth resolution (Key decision #6)", () => {
  it("falls back to the Jira site/email/token when no Confluence override is set", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    await client.get("/wiki/rest/api/content/123");

    expect(seenUrl).toBe("https://example.atlassian.net/wiki/rest/api/content/123");
    expect(seenAuth).toBe(`Basic ${Buffer.from("bot@example.com:jira-token").toString("base64")}`);
  });

  it("prefers Confluence-specific overrides when set", async () => {
    const overrideConfig: GlobalConfig = {
      ...baseConfig,
      confluenceSiteUrl: "https://confluence.example.com",
      confluenceEmail: "confluence-bot@example.com",
      confluenceApiToken: "confluence-token",
    };
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ConfluenceClient({ config: overrideConfig, fetchImpl });
    await client.get("/wiki/rest/api/content/123");

    expect(seenUrl).toBe("https://confluence.example.com/wiki/rest/api/content/123");
    expect(seenAuth).toBe(
      `Basic ${Buffer.from("confluence-bot@example.com:confluence-token").toString("base64")}`,
    );
  });

  it("throws a clear error when no API token is available at all", async () => {
    const noTokenConfig: GlobalConfig = { ...baseConfig, jiraApiToken: undefined };
    const client = new ConfluenceClient({ config: noTokenConfig, fetchImpl: vi.fn() });
    await expect(client.get("/wiki/rest/api/content/123")).rejects.toThrow(/No Confluence API token/);
  });
});

describe("ConfluenceClient retry/backoff", () => {
  function noSleepClient(fetchImpl: typeof fetch): { client: ConfluenceClient; sleeps: number[] } {
    const sleeps: number[] = [];
    const client = new ConfluenceClient({
      config: baseConfig,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { client, sleeps };
  }

  it("retries a 5xx with capped exponential backoff, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response("boom", { status: 503, statusText: "Service Unavailable" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { client, sleeps } = noSleepClient(fetchImpl);
    await expect(client.get("/wiki/rest/api/content/123")).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("does not retry a non-retryable 4xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" }));
    const { client } = noSleepClient(fetchImpl);
    await expect(client.get("/wiki/rest/api/content/999")).rejects.toBeInstanceOf(ConfluenceApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("extractPageIdFromUrl", () => {
  it("extracts the ID from a /pages/<id>/<slug> URL", () => {
    expect(
      extractPageIdFromUrl("https://example.atlassian.net/wiki/spaces/ENG/pages/12345/Symfony+4-5"),
    ).toBe("12345");
  });

  it("extracts the ID from a legacy viewpage.action?pageId= URL", () => {
    expect(
      extractPageIdFromUrl("https://example.atlassian.net/wiki/pages/viewpage.action?pageId=67890"),
    ).toBe("67890");
  });

  it("returns undefined for a URL with no recognizable page ID", () => {
    expect(extractPageIdFromUrl("https://example.atlassian.net/wiki/spaces/ENG/overview")).toBeUndefined();
  });
});

describe("fetchPageByUrl", () => {
  it("fetches the page by its extracted ID with body.storage expanded", async () => {
    let seenUrl: string | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({ id: "12345", title: "Symfony 4→5 Upgrade", body: { storage: { value: "<p>x</p>", representation: "storage" } } }),
        { status: 200 },
      );
    });
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const page = await fetchPageByUrl(client, "https://example.atlassian.net/wiki/spaces/ENG/pages/12345/Symfony");
    expect(seenUrl).toBe("https://example.atlassian.net/wiki/rest/api/content/12345?expand=body.storage");
    expect(page.title).toBe("Symfony 4→5 Upgrade");
  });

  it("throws when the URL has no extractable page ID", async () => {
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl: vi.fn() });
    await expect(fetchPageByUrl(client, "https://example.atlassian.net/wiki/overview")).rejects.toThrow(
      /Could not extract a Confluence page ID/,
    );
  });
});
