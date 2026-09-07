import type { GlobalConfig } from "../config.js";
import type { ConfluenceClient } from "../confluence/client.js";
import { getGuideCatalog } from "../confluence/guide-catalog.js";

export interface ListGuidesResult {
  configured: boolean;
  guides: { title: string; description: string; tags: string[] }[];
}

/**
 * Exposes the parsed guide catalog (titles/descriptions/tags only — never `link` or full content,
 * see fetch_guide) for the planning agent to match against a ticket. Returns `configured: false`
 * rather than throwing when `CONFLUENCE_GUIDE_INDEX_URL` is unset — the feature is fully off, not
 * broken, in that case (Goals: "absent config = feature fully off, today's behavior unchanged").
 */
export async function listGuides(client: ConfluenceClient, config: GlobalConfig): Promise<ListGuidesResult> {
  if (!config.confluenceGuideIndexUrl) {
    return { configured: false, guides: [] };
  }
  const catalog = await getGuideCatalog(client, config.confluenceGuideIndexUrl);
  return {
    configured: true,
    guides: catalog.map(({ title, description, tags }) => ({ title, description, tags })),
  };
}
