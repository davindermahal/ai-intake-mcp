import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { ConfluenceClient } from "../../src/confluence/client.js";
import { _resetGuideCatalogCacheForTests } from "../../src/confluence/guide-catalog.js";
import { fetchGuide } from "../../src/tools/fetch-guide.js";

const baseConfig: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
  confluenceGuideIndexUrl: "https://example.atlassian.net/wiki/spaces/ENG/pages/999/Guides",
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

const GUIDE_PAGE_RESPONSE = {
  id: "111",
  title: "Symfony 4→5 Upgrade",
  body: {
    storage: {
      representation: "storage" as const,
      value: "<h1>Step 1</h1><p>Run <code>composer require symfony/symfony:^5.0</code></p>",
    },
  },
};

beforeEach(() => {
  _resetGuideCatalogCacheForTests();
});
afterEach(() => {
  _resetGuideCatalogCacheForTests();
});

describe("fetchGuide", () => {
  it("throws when the guide index isn't configured", async () => {
    const unconfigured: GlobalConfig = { ...baseConfig, confluenceGuideIndexUrl: undefined };
    const client = new ConfluenceClient({ config: unconfigured, fetchImpl: vi.fn() });
    await expect(fetchGuide(client, unconfigured, "Symfony 4→5 Upgrade")).rejects.toThrow(/isn't configured/);
  });

  it("throws when the title isn't in the index catalog (no raw search)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(INDEX_PAGE_RESPONSE), { status: 200 }));
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    await expect(fetchGuide(client, baseConfig, "Some Random Title")).rejects.toThrow(/not in the guide index/);
    // Only the index page was fetched -- never a second, unbounded lookup for the bogus title.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches and returns plain-text content for a title present in the index", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify(calls === 1 ? INDEX_PAGE_RESPONSE : GUIDE_PAGE_RESPONSE), { status: 200 });
    });
    const client = new ConfluenceClient({ config: baseConfig, fetchImpl });
    const result = await fetchGuide(client, baseConfig, "Symfony 4→5 Upgrade");
    expect(result.title).toBe("Symfony 4→5 Upgrade");
    expect(result.content).toContain("Step 1");
    expect(result.content).toContain("composer require symfony/symfony:^5.0");
    expect(result.content).not.toContain("<h1>");
  });
});
