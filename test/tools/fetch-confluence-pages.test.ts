import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { ConfluenceClient } from "../../src/confluence/client.js";
import { fetchConfluencePages } from "../../src/tools/fetch-confluence-pages.js";

const baseConfig: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

function pageResponse(id: string, title: string, when: string): Response {
  return new Response(
    JSON.stringify({
      id,
      title,
      body: { storage: { value: `<p>content for ${title}</p>`, representation: "storage" } },
      version: { when },
    }),
    { status: 200 },
  );
}

describe("fetchConfluencePages", () => {
  it("fetches every URL that matches the configured site host and has an extractable page ID", async () => {
    const fetchImpl = vi.fn(async () => pageResponse("111", "Design Doc", "2024-01-02T00:00:00.000Z"));
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const results = await fetchConfluencePages(client, baseConfig, [
      "https://example.atlassian.net/wiki/spaces/ENG/pages/111/Design-Doc",
    ]);
    expect(results).toEqual([
      {
        url: "https://example.atlassian.net/wiki/spaces/ENG/pages/111/Design-Doc",
        title: "Design Doc",
        content: "content for Design Doc",
        lastModified: "2024-01-02T00:00:00.000Z",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("silently skips a URL on the wrong host even though it pattern-matches a page ID (Key decision #5)", async () => {
    const fetchImpl = vi.fn(async () => pageResponse("999", "Wrong Host", "2024-01-01T00:00:00.000Z"));
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const results = await fetchConfluencePages(client, baseConfig, [
      "https://not-our-confluence.example.com/wiki/spaces/ENG/pages/999/Something",
    ]);
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("silently skips a same-host URL with no extractable page ID (e.g. a space overview)", async () => {
    const fetchImpl = vi.fn();
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const results = await fetchConfluencePages(client, baseConfig, [
      "https://example.atlassian.net/wiki/spaces/ENG/overview",
    ]);
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is partial-failure tolerant: one bad link doesn't sink the whole batch", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/111")) return pageResponse("111", "Good Page", "2024-01-02T00:00:00.000Z");
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const results = await fetchConfluencePages(client, baseConfig, [
      "https://example.atlassian.net/wiki/spaces/ENG/pages/111/Good",
      "https://example.atlassian.net/wiki/spaces/ENG/pages/404/Missing",
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      url: "https://example.atlassian.net/wiki/spaces/ENG/pages/111/Good",
      title: "Good Page",
      content: "content for Good Page",
      lastModified: "2024-01-02T00:00:00.000Z",
    });
    expect(results[1]?.url).toBe("https://example.atlassian.net/wiki/spaces/ENG/pages/404/Missing");
    expect(results[1]?.error).toMatch(/404/);
    expect(results[1]?.content).toBeUndefined();
  });

  it("propagates a ConfluenceApiError's message as the per-URL error", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403, statusText: "Forbidden" }));
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const results = await fetchConfluencePages(client, baseConfig, [
      "https://example.atlassian.net/wiki/spaces/ENG/pages/500/NoAccess",
    ]);
    expect(results[0]?.error).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("matches against confluenceSiteUrl when set, not jiraSiteUrl (Key decision #6's site-resolution rule)", async () => {
    const overrideConfig: GlobalConfig = { ...baseConfig, confluenceSiteUrl: "https://confluence.example.com" };
    const fetchImpl = vi.fn(async () => pageResponse("111", "On Override Site", "2024-01-02T00:00:00.000Z"));
    const client = new ConfluenceClient({ config: overrideConfig, fetchImpl });

    const skipped = await fetchConfluencePages(client, overrideConfig, [
      "https://example.atlassian.net/wiki/spaces/ENG/pages/111/On-Jira-Host",
    ]);
    expect(skipped).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();

    const fetched = await fetchConfluencePages(client, overrideConfig, [
      "https://confluence.example.com/wiki/spaces/ENG/pages/111/On-Override-Site",
    ]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.title).toBe("On Override Site");
  });

  it("returns an empty array for an empty input list", async () => {
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl: vi.fn() });
    expect(await fetchConfluencePages(client, baseConfig, [])).toEqual([]);
  });
});

