import { describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/automation/prompt-template.js";

describe("renderPrompt", () => {
  it("substitutes every known placeholder", () => {
    const rendered = renderPrompt("Ticket: {{TICKET_KEY}}, context at {{CONTEXT_FILE_PATH}}.", {
      TICKET_KEY: "DAV-5",
      CONTEXT_FILE_PATH: "/state/my-app/context/DAV-5.json",
    });
    expect(rendered).toBe("Ticket: DAV-5, context at /state/my-app/context/DAV-5.json.");
  });

  it("substitutes the same placeholder wherever it repeats", () => {
    const rendered = renderPrompt("{{TICKET_KEY}} ... {{TICKET_KEY}}", { TICKET_KEY: "DAV-5" });
    expect(rendered).toBe("DAV-5 ... DAV-5");
  });

  it("leaves non-placeholder text untouched", () => {
    const rendered = renderPrompt("No placeholders here, just {curly braces}.", {});
    expect(rendered).toBe("No placeholders here, just {curly braces}.");
  });

  it("throws when the template references a placeholder with no provided value", () => {
    expect(() => renderPrompt("Missing {{UNKNOWN}}.", {})).toThrow(/UNKNOWN/);
  });
});
