import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { promptTemplatePath } from "../../src/automation/prompts.js";

describe("promptTemplatePath", () => {
  it("resolves to an existing file for headless-planning", () => {
    const path = promptTemplatePath("headless-planning");
    expect(path.endsWith("prompts/headless-planning.md")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("resolves to an existing file for headless-implementation", () => {
    const path = promptTemplatePath("headless-implementation");
    expect(path.endsWith("prompts/headless-implementation.md")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});
