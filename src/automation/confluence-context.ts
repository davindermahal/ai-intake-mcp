import type { ConfluenceClient } from "@davindermahal/confluence-client";
import type { GlobalConfig } from "../config.js";
import { fetchConfluencePages } from "../tools/fetch-confluence-pages.js";
import { listGuides } from "../tools/list-guides.js";
import type { WorkerConfluenceContext } from "./result-file.js";

/** Trailing sentence punctuation a URL picked out of prose commonly drags along ("...see the doc."). */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export function extractCandidateUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'()[\]{}]+/g) ?? [];
  const cleaned = matches.map((url) => url.replace(TRAILING_PUNCTUATION, ""));
  return [...new Set(cleaned)];
}

/**
 * Pre-fetches Confluence context for a headless planning launch (confluence-references-in-planning.md
 * Option B) — a headless worker has no MCP tool access at all, so this runs server-side, before
 * launch, in the orchestrator's own process, and the result is handed to the worker as a file instead
 * of the worker calling `list_guides`/`fetch_confluence_pages` itself. Never throws: either half
 * failing (a misconfigured guide index, a network hiccup) degrades to an empty list for that half
 * rather than aborting the ticket's dispatch entirely — gathering Confluence context must never be
 * able to block planning itself, the same principle `list_guides`'s `configured: false` already
 * applies to a simply-unconfigured index.
 */
export async function buildWorkerConfluenceContext(
  client: ConfluenceClient,
  config: GlobalConfig,
  issue: { summary: string; description: string; comments: { body: string }[] },
): Promise<WorkerConfluenceContext> {
  const text = [issue.summary, issue.description, ...issue.comments.map((c) => c.body)].join("\n");
  const urls = extractCandidateUrls(text);

  const [guideCatalog, referencedPages] = await Promise.all([
    listGuides(client, config)
      .then((result) => result.guides)
      .catch(() => []),
    fetchConfluencePages(client, config, urls).catch(() => []),
  ]);

  return { guideCatalog, referencedPages };
}
