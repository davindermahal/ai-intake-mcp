export interface GuideIndexEntry {
  title: string;
  description: string;
  link: string;
  tags: string[];
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function extractHref(cellHtml: string): string {
  const match = cellHtml.match(/<a\s[^>]*href="([^"]+)"/i);
  const href = match?.[1];
  return href ?? stripTags(cellHtml);
}

/** Extracts every regex-group-1 capture from a global match, skipping any (impossible) empty capture. */
function captureAll(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(pattern)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/**
 * Parses the `{title, description, link, tags}` table out of a Confluence page's storage-format
 * body (curated-guide-retrieval.md's index page shape). Hand-rolled against the small, known
 * subset Confluence's storage format actually produces for a simple table — not a general HTML
 * parser. The first row is assumed to be a header (Title | Description | Link | Tags) and skipped.
 */
export function parseGuideIndex(storageHtml: string): GuideIndexEntry[] {
  const tableMatch = storageHtml.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  const tableBody = tableMatch?.[1];
  if (!tableBody) return [];

  const rows = captureAll(tableBody, /<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (rows.length === 0) return [];

  const entries: GuideIndexEntry[] = [];
  // Skip the header row (first <tr>) — it's Title/Description/Link/Tags column labels, not data.
  for (const row of rows.slice(1)) {
    const cells = captureAll(row, /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
    const [titleCell, descriptionCell, linkCell, tagsCell] = cells;
    if (titleCell === undefined || descriptionCell === undefined || linkCell === undefined || tagsCell === undefined) {
      continue;
    }

    const title = stripTags(titleCell);
    const description = stripTags(descriptionCell);
    const link = extractHref(linkCell);
    const tags = stripTags(tagsCell)
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (!title) continue;
    entries.push({ title, description, link, tags });
  }
  return entries;
}
