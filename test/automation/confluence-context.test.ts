import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkerConfluenceContext, extractCandidateUrls } from "../../src/automation/confluence-context.js";
import type { GlobalConfig } from "../../src/config.js";
import { ConfluenceClient } from "../../src/confluence/client.js";
import { _resetGuideCatalogCacheForTests } from "../../src/confluence/guide-catalog.js";

const baseConfig: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

describe("extractCandidateUrls", () => {
  it("extracts every http(s) URL from free text", () => {
    const text = "See https://example.atlassian.net/wiki/x/1 and also http://other.example.com/y.";
    expect(extractCandidateUrls(text)).toEqual([
      "https://example.atlassian.net/wiki/x/1",
      "http://other.example.com/y",
    ]);
  });

  it("deduplicates repeated URLs", () => {
    const text = "https://example.atlassian.net/wiki/x/1 mentioned twice: https://example.atlassian.net/wiki/x/1";
    expect(extractCandidateUrls(text)).toEqual(["https://example.atlassian.net/wiki/x/1"]);
  });

  it("returns an empty array when there are no URLs", () => {
    expect(extractCandidateUrls("no links here")).toEqual([]);
  });
});

describe("buildWorkerConfluenceContext", () => {
  beforeEach(() => {
    _resetGuideCatalogCacheForTests();
  });

  it("returns guide catalog metadata and fetched ticket-referenced pages", async () => {
    const config: GlobalConfig = { ...baseConfig, confluenceGuideIndexUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/999/Guides" };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/999")) {
        return new Response(
          JSON.stringify({
            id: "999",
            title: "Guides",
            body: {
              storage: {
                representation: "storage",
                value:
                  "<table><tbody><tr><th>Title</th><th>Description</th><th>Link</th><th>Tags</th></tr>" +
                  '<tr><td><p>Symfony 4→5 Upgrade</p></td><td><p>Steps</p></td><td><p><a href="https://example.atlassian.net/wiki/spaces/ENG/pages/111/S">l</a></p></td><td><p>symfony</p></td></tr>' +
                  "</tbody></table>",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/222")) {
        return new Response(
          JSON.stringify({
            id: "222",
            title: "Runbook",
            body: { storage: { representation: "storage", value: "<p>Do this.</p>" } },
            version: { when: "2024-05-01T00:00:00.000Z" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const client = new ConfluenceClient({ config, fetchImpl });

    const result = await buildWorkerConfluenceContext(client, config, {
      summary: "Fix the thing",
      description: "See https://example.atlassian.net/wiki/spaces/ENG/pages/222/Runbook for context.",
      comments: [{ body: "No further links here." }],
    });

    expect(result.guideCatalog).toEqual([
      { title: "Symfony 4→5 Upgrade", description: "Steps", tags: ["symfony"], lastModified: undefined },
    ]);
    expect(result.referencedPages).toEqual([
      {
        url: "https://example.atlassian.net/wiki/spaces/ENG/pages/222/Runbook",
        title: "Runbook",
        content: "Do this.",
        lastModified: "2024-05-01T00:00:00.000Z",
      },
    ]);
  });

  it("returns empty results (never throws) when the guide index is unconfigured and no links are present", async () => {
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl: vi.fn() });
    const result = await buildWorkerConfluenceContext(client, baseConfig, {
      summary: "Fix the thing",
      description: "No links here.",
      comments: [],
    });
    expect(result).toEqual({ guideCatalog: [], referencedPages: [] });
  });

  it("degrades to an empty guide catalog (not a thrown error) when the guide index itself fails to fetch", async () => {
    const config: GlobalConfig = {
      ...baseConfig,
      confluenceGuideIndexUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/999/Guides",
    };
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
    const client = new ConfluenceClient({ config, fetchImpl, sleepImpl: async () => {} });

    const result = await buildWorkerConfluenceContext(client, config, {
      summary: "Fix the thing",
      description: "No links here.",
      comments: [],
    });
    expect(result.guideCatalog).toEqual([]);
  });
});
