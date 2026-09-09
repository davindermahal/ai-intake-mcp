/** Minimal Atlassian Document Format helpers — just enough for plain-text round-tripping. */

interface AdfMark {
  type?: string;
  attrs?: { href?: string };
}

interface AdfNode {
  type?: string;
  text?: string;
  version?: number;
  content?: AdfNode[];
  attrs?: { url?: string };
  marks?: AdfMark[];
}

/** A reporter-pasted URL that Jira "smart-linked" into a card node — carries no visible text of its own. */
function cardUrl(node: AdfNode): string {
  return node.attrs?.url ?? "";
}

export function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const lines: string[] = [];

  function walkBlock(node: AdfNode): void {
    if (node.type === "text" && node.text) {
      const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
      const text = href ? `[${node.text}](${href})` : node.text;
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + text;
      return;
    }
    if (node.type === "inlineCard") {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + cardUrl(node);
      return;
    }
    if (node.type === "blockCard") {
      lines.push(cardUrl(node));
      return;
    }
    const startsNewLine = node.type === "paragraph" || node.type === "heading" || node.type === "listItem";
    if (startsNewLine) lines.push("");
    for (const child of node.content ?? []) walkBlock(child);
  }

  walkBlock(adf as AdfNode);
  return lines.join("\n").trim();
}

export function plainTextToAdf(text: string): AdfNode {
  const paragraphs = text.split("\n\n").map((block) => ({
    type: "paragraph",
    content: [{ type: "text", text: block }],
  }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph", content: [] }],
  } as AdfNode;
}
