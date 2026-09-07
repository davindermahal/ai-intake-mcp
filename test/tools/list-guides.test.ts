import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { ConfluenceClient } from "../../src/confluence/client.js";
import { _resetGuideCatalogCacheForTests } from "../../src/confluence/guide-catalog.js";
import { listGuides } from "../../src/tools/list-guides.js";

const baseConfig: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

const INDEX_PAGE_RESPONSE = {
  id: "999",
  title: "AI Agent Guides",
  body: {
    storage: {
      representation: "storage" as const,
      value: `<table><tbody>
        <tr><th>Title</th><th>Description</th><th>Link</th><th>Tags</th></tr>
        <tr>
          <td><p>Symfony 4→5 Upgrade</p></td>
          <td><p>Steps for 4.4→5.x</p></td>
          <td><p><a href="https://example.atlassian.net/wiki/spaces/ENG/pages/111/S">l</a></p></td>
          <td><p>symfony, upgrade</p></td>
        </tr>
      </tbody></table>`,
    },
  },
};

beforeEach(() => {
  _resetGuideCatalogCacheForTests();
});
afterEach(() => {
  _resetGuideCatalogCacheForTests();
});

describe("listGuides", () => {
  it("reports configured: false and does not call Confluence when the index URL is unset", async () => {
    const fetchImpl = vi.fn();
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const result = await listGuides(client, baseConfig);
    expect(result).toEqual({ configured: false, guides: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and parses the catalog, omitting link, when the index URL is set", async () => {
    const configured: GlobalConfig = {
      ...baseConfig,
      confluenceGuideIndexUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/999/Guides",
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(INDEX_PAGE_RESPONSE), { status: 200 }));
    const client = new ConfluenceClient({ config: configured, fetchImpl });

    const result = await listGuides(client, configured);
    expect(result.configured).toBe(true);
    expect(result.guides).toEqual([
      { title: "Symfony 4→5 Upgrade", description: "Steps for 4.4→5.x", tags: ["symfony", "upgrade"] },
    ]);
    expect(result.guides[0]).not.toHaveProperty("link");
  });

  it("passes lastModified through from the catalog, defined and undefined", async () => {
    const configured: GlobalConfig = {
      ...baseConfig,
      confluenceGuideIndexUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/999/Guides",
    };
    const response = {
      ...INDEX_PAGE_RESPONSE,
      body: {
        storage: {
          representation: "storage" as const,
          value: `<table><tbody>
            <tr><th>Title</th><th>Description</th><th>Link</th><th>Tags</th><th>Last Modified</th></tr>
            <tr>
              <td><p>Symfony 4→5 Upgrade</p></td>
              <td><p>Steps for 4.4→5.x</p></td>
              <td><p><a href="https://example.atlassian.net/wiki/spaces/ENG/pages/111/S">l</a></p></td>
              <td><p>symfony, upgrade</p></td>
              <td><p>2026-09-06</p></td>
            </tr>
            <tr>
              <td><p>Company Conventions</p></td>
              <td><p>Coding standards</p></td>
              <td><p><a href="https://example.atlassian.net/wiki/spaces/ENG/pages/222/C">l</a></p></td>
              <td><p>always</p></td>
              <td><p></p></td>
            </tr>
          </tbody></table>`,
        },
      },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = new ConfluenceClient({ config: configured, fetchImpl });

    const result = await listGuides(client, configured);
    expect(result.guides).toHaveLength(2);
    expect(result.guides[0].lastModified).toBe("2026-09-06");
    expect(result.guides[1].lastModified).toBeUndefined();
  });

  it("only fetches the index page once across repeated calls in the same process", async () => {
    const configured: GlobalConfig = {
      ...baseConfig,
      confluenceGuideIndexUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/999/Guides",
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(INDEX_PAGE_RESPONSE), { status: 200 }));
    const client = new ConfluenceClient({ config: configured, fetchImpl });

    await listGuides(client, configured);
    await listGuides(client, configured);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
