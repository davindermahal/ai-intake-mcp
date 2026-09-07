export interface GuideIndexEntry {
  title: string;
  description: string;
  link: string;
  tags: string[];
  lastModified?: string;
}

/**
 * Confluence's storage format doesn't just escape XML metacharacters -- it also autoformats plain
 * Unicode typographic characters (an arrow typed as "->") into named HTML entities on save,
 * confirmed live against a real Confluence Cloud page (documentation-mcp's sync_guide produced
 * "Symfony 4→5 Upgrade"; Confluence stored it as "Symfony 4&rarr;5 Upgrade"). This must decode the
 * same entity set documentation-mcp's index-table.ts does, or the two parsers disagree on a real
 * page despite agreeing on every mocked test fixture.
 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&rarr;/g, "→")
    .replace(/&larr;/g, "←")
    .replace(/&harr;/g, "↔")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&amp;/g, "&")
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
 * parser. The first row is assumed to be a header (Title | Description | Link | Tags[ | Last
 * Modified]) and skipped as data.
 *
 * The first four columns stay positional (their contract isn't changing) — only the optional 5th
 * `Last Modified` column is located by header text, so a legacy 4-column table (no such header at
 * all) still parses cleanly with `lastModified` `undefined` on every row
 * (2026-09-07-ai-intake-mcp-read-the-guide-index-s-last-modified-column-2.md Key decision #1).
 */
export function parseGuideIndex(storageHtml: string): GuideIndexEntry[] {
  const tableMatch = storageHtml.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  const tableBody = tableMatch?.[1];
  if (!tableBody) return [];

  const rows = captureAll(tableBody, /<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (rows.length === 0) return [];

  const headerCells = captureAll(rows[0] ?? "", /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi).map(stripTags);
  const lastModifiedIndex = headerCells.indexOf("Last Modified");

  const entries: GuideIndexEntry[] = [];
  // Skip the header row (first <tr>) — it's column labels, not data.
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
    const lastModifiedCell = lastModifiedIndex >= 0 ? cells[lastModifiedIndex] : undefined;
    const lastModified = lastModifiedCell !== undefined ? stripTags(lastModifiedCell) || undefined : undefined;

    if (!title) continue;
    entries.push({ title, description, link, tags, lastModified });
  }
  return entries;
}
