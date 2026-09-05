/** Minimal Atlassian Document Format helpers — just enough for plain-text round-tripping. */

interface AdfNode {
  type?: string;
  text?: string;
  version?: number;
  content?: AdfNode[];
}

export function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const lines: string[] = [];

  function walkBlock(node: AdfNode): void {
    if (node.type === "text" && node.text) {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + node.text;
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
