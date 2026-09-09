import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/automation/prompt-template.js";

// The prompt files' *content* isn't unit-testable (decision #21 — validated by the future dry-run
// and integration test instead), but the placeholder *contract* the orchestrator depends on to
// render them is: both templates must keep using exactly the tokens the orchestrator will fill in.
const REQUIRED_PLACEHOLDERS = ["TICKET_KEY", "CONTEXT_FILE_PATH", "PROGRESS_LOG_PATH", "RESULT_FILE_PATH"];

describe.each([
  // CONFLUENCE_CONTEXT_FILE_PATH is planning-only (confluence-references-in-planning.md Option B) —
  // headless-implementation.md never gathers Confluence context, so it doesn't get this placeholder.
  ["prompts/headless-planning.md", ["CONFLUENCE_CONTEXT_FILE_PATH"]],
  ["prompts/headless-implementation.md", []],
] as const)("%s", (path, extraPlaceholders) => {
  const content = readFileSync(path, "utf8");
  const placeholders = [...REQUIRED_PLACEHOLDERS, ...extraPlaceholders];
  const values = Object.fromEntries(placeholders.map((key) => [key, `<${key}>`]));

  it("contains every required placeholder", () => {
    for (const placeholder of placeholders) {
      expect(content).toContain(`{{${placeholder}}}`);
    }
  });

  it("renders cleanly with all required values supplied (no leftover/unknown placeholders)", () => {
    const rendered = renderPrompt(content, values);
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });
});
