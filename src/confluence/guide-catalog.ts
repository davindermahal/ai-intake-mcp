import type { ConfluenceClient } from "./client.js";
import { fetchPageByUrl } from "./client.js";
import { parseGuideIndex, type GuideIndexEntry } from "./index-parser.js";

let cached: GuideIndexEntry[] | undefined;

/**
 * Fetches + parses the guide index once per process (curated-guide-retrieval.md Key decision #3 —
 * no persistent cache, no TTL, just memoized for this process's lifetime) and shared by
 * `list_guides` and `fetch_guide` so they agree on the exact same catalog within one session.
 */
export async function getGuideCatalog(client: ConfluenceClient, indexUrl: string): Promise<GuideIndexEntry[]> {
  if (!cached) {
    const page = await fetchPageByUrl(client, indexUrl);
    cached = parseGuideIndex(page.body.storage.value);
  }
  return cached;
}

/** Test-only: clears the module-level cache so each test starts from a clean slate. */
export function _resetGuideCatalogCacheForTests(): void {
  cached = undefined;
}
