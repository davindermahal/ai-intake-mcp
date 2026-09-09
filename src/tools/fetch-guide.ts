import { fetchPageByUrl, storageToPlainText, type ConfluenceClient } from "@davindermahal/confluence-client";
import type { GlobalConfig } from "../config.js";
import { getGuideCatalog } from "../confluence/guide-catalog.js";

export interface FetchGuideResult {
  title: string;
  content: string;
}

/**
 * Fetches a guide's full content, scoped **only** to titles present in the parsed index catalog —
 * this is the code-level enforcement of "no raw Confluence search" (curated-guide-retrieval.md
 * Implementation step 4), not just an absence of a search tool.
 */
export async function fetchGuide(
  client: ConfluenceClient,
  config: GlobalConfig,
  title: string,
): Promise<FetchGuideResult> {
  if (!config.confluenceGuideIndexUrl) {
    throw new Error("Confluence guide index isn't configured (CONFLUENCE_GUIDE_INDEX_URL is unset).");
  }
  const catalog = await getGuideCatalog(client, config.confluenceGuideIndexUrl);
  const entry = catalog.find((g) => g.title === title);
  if (!entry) {
    throw new Error(`"${title}" is not in the guide index. Call list_guides to see available titles.`);
  }
  const page = await fetchPageByUrl(client, entry.link);
  return { title: entry.title, content: storageToPlainText(page.storageBody) };
}
