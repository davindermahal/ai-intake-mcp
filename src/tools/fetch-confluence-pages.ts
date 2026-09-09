import {
  extractPageIdFromUrl,
  fetchPageByUrl,
  storageToPlainText,
  type ConfluenceClient,
} from "@davindermahal/confluence-client";
import type { GlobalConfig } from "../config.js";

export interface FetchConfluencePagesResultEntry {
  url: string;
  title?: string;
  content?: string;
  lastModified?: string;
  error?: string;
}

/** Same site/email/token fallback `ConfluenceClient` already applies for auth (Key decision #6 of
 * curated-guide-retrieval.md) — reused here for the URL-matching rule, not a new config surface. */
function configuredSiteHost(config: GlobalConfig): string {
  const raw = config.confluenceSiteUrl ?? config.jiraSiteUrl;
  const normalized = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  return new URL(normalized).host;
}

/**
 * A URL only gets fetched if it's on the configured Confluence site's own host *and*
 * `extractPageIdFromUrl` can pull a page ID out of it (confluence-references-in-planning.md Key
 * decision #5) — hostname-only would waste calls on non-page URLs (space overviews); pattern-only
 * would let a same-shaped URL on an unrelated system cause a wrong-content query against our own
 * tenant, since `fetchPageByUrl` never looks at the URL's own host, only the numeric ID it extracts.
 */
function isFetchableConfluenceUrl(url: string, siteHost: string): boolean {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  return host === siteHost && extractPageIdFromUrl(url) !== undefined;
}

/**
 * Fetches explicit-link Confluence pages named during planning (operator- or ticket-named, Design
 * #3 of confluence-references-in-planning.md) — partial-failure tolerant: one bad or inaccessible
 * link doesn't sink the whole batch. A URL that isn't a fetchable Confluence page for this site is
 * silently skipped (no entry at all), not treated as an error — this is a filter over "things that
 * might be Confluence links in free text," not validation of a promised-good input.
 */
export async function fetchConfluencePages(
  client: ConfluenceClient,
  config: GlobalConfig,
  urls: string[],
): Promise<FetchConfluencePagesResultEntry[]> {
  const siteHost = configuredSiteHost(config);
  const results: FetchConfluencePagesResultEntry[] = [];

  for (const url of urls) {
    if (!isFetchableConfluenceUrl(url, siteHost)) continue;
    try {
      const page = await fetchPageByUrl(client, url);
      results.push({
        url,
        title: page.title,
        content: storageToPlainText(page.storageBody),
        lastModified: page.lastModified,
      });
    } catch (err) {
      results.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
