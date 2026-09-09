import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderPrompt, resolveIncludes } from "../../src/automation/prompt-template.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// resolveIncludes resolves {{INCLUDE:...}} paths relative to <repo>/docs (../../docs from here).
const DOCS_DIR = join(__dirname, "..", "..", "docs");
const FIXTURE_DIR = join(DOCS_DIR, "_fragments");
const FIXTURE_PATH = join(FIXTURE_DIR, "__test-fixture__.md");

describe("resolveIncludes", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, "fixture content", "utf8");
  });
  afterEach(() => {
    rmSync(FIXTURE_PATH, { force: true });
  });

  it("splices a fixture file's contents in place of the INCLUDE token", () => {
    expect(resolveIncludes("before\n{{INCLUDE:_fragments/__test-fixture__.md}}\nafter")).toBe(
      "before\nfixture content\nafter",
    );
  });

  it("leaves unmatched (non-INCLUDE) tokens untouched", () => {
    expect(resolveIncludes("{{TICKET_KEY}} stays, {curly braces} stay")).toBe(
      "{{TICKET_KEY}} stays, {curly braces} stay",
    );
  });

  it("throws a clear error when the included file doesn't exist", () => {
    expect(() => resolveIncludes("{{INCLUDE:_fragments/does-not-exist.md}}")).toThrow(
      /_fragments\/does-not-exist\.md/,
    );
  });

  it("splices the real confluence-context fragment into both real doc/prompt files exactly once", () => {
    const fragment = readFileSync(join(DOCS_DIR, "_fragments/confluence-context.md"), "utf8");
    const markerLine = fragment.trim().split("\n")[0] as string;

    const planningProcedure = readFileSync(join(DOCS_DIR, "planning-procedure.md"), "utf8");
    const headlessPlanning = readFileSync(join(DOCS_DIR, "..", "prompts", "headless-planning.md"), "utf8");

    for (const raw of [planningProcedure, headlessPlanning]) {
      const resolved = resolveIncludes(raw);
      expect(resolved).not.toContain("{{INCLUDE:");
      expect(resolved.split(markerLine)).toHaveLength(2); // exactly one occurrence
    }
  });
});

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

  it("resolves an INCLUDE token before substituting {{VAR}} placeholders", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, "fixture for {{TICKET_KEY}}", "utf8");
    try {
      expect(renderPrompt("{{INCLUDE:_fragments/__test-fixture__.md}}", { TICKET_KEY: "DAV-5" })).toBe(
        "fixture for DAV-5",
      );
    } finally {
      rmSync(FIXTURE_PATH, { force: true });
    }
  });
});
