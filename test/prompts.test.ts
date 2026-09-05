import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/automation/prompt-template.js";

// The prompt files' *content* isn't unit-testable (decision #21 — validated by the future dry-run
// and integration test instead), but the placeholder *contract* the orchestrator depends on to
// render them is: both templates must keep using exactly the tokens the orchestrator will fill in.
const REQUIRED_PLACEHOLDERS = ["TICKET_KEY", "CONTEXT_FILE_PATH", "PROGRESS_LOG_PATH", "RESULT_FILE_PATH"];

const VALUES = Object.fromEntries(REQUIRED_PLACEHOLDERS.map((key) => [key, `<${key}>`]));

describe.each([
  ["prompts/headless-planning.md"],
  ["prompts/headless-implementation.md"],
])("%s", (path) => {
  const content = readFileSync(path, "utf8");

  it("contains every required placeholder", () => {
    for (const placeholder of REQUIRED_PLACEHOLDERS) {
      expect(content).toContain(`{{${placeholder}}}`);
    }
  });

  it("renders cleanly with all required values supplied (no leftover/unknown placeholders)", () => {
    const rendered = renderPrompt(content, VALUES);
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });
});
