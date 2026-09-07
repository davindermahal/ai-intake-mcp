/**
 * Best-effort conversion of a Confluence storage-format page body into plain text for an agent to
 * read directly — not a general HTML-to-text library, just enough structure (paragraph/list/heading
 * breaks, code blocks) to make a fetched guide readable instead of raw markup. Not used for the
 * index table itself (see index-parser.ts, which needs cell boundaries, not prose).
 */
export function storageToPlainText(storageHtml: string): string {
  // Extract Confluence's code-macro CDATA bodies BEFORE the generic tag strip below — the blanket
  // `<[^>]*>` regex has no concept of `<![CDATA[...]]>` and matches from the opening `<![CDATA[`
  // clean through to the *first* `>` it finds, which is the one inside the CDATA section's own
  // closing `]]>` — so it swallows the entire CDATA payload (real commands, not markup) as if it
  // were one giant tag. Confirmed live: a real guide's fenced code blocks came back as the literal
  // word "none" (the macro's leftover `language` parameter) with every actual command silently
  // deleted. Pull each code body out first and reinsert it untouched afterward.
  const codeBlocks: string[] = [];
  const withCodePlaceholders = storageHtml.replace(
    /<ac:structured-macro\s+ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g,
    (_, code: string) => {
      codeBlocks.push(code);
      return `\n CODE_BLOCK_${codeBlocks.length - 1} \n`;
    },
  );

  const withBreaks = withCodePlaceholders
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|tr|div)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");

  const stripped = withBreaks
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
    .replace(/&amp;/g, "&");

  const restored = stripped.replace(/ CODE_BLOCK_(\d+) /g, (_, i: string) => codeBlocks[Number(i)] ?? "");

  return restored.replace(/\n{3,}/g, "\n\n").trim();
}
