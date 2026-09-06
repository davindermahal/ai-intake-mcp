/**
 * Best-effort conversion of a Confluence storage-format page body into plain text for an agent to
 * read directly — not a general HTML-to-text library, just enough structure (paragraph/list/heading
 * breaks, code blocks) to make a fetched guide readable instead of raw markup. Not used for the
 * index table itself (see index-parser.ts, which needs cell boundaries, not prose).
 */
export function storageToPlainText(storageHtml: string): string {
  const withBreaks = storageHtml
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|tr|div)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");

  return withBreaks
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
