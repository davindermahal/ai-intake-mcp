import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPlanFile,
  getQAPlanSectionText,
  planHasBlockingOpenQuestions,
  planHasBoundariesSection,
  planHasImplementationOrderSection,
  planHasQAPlanSection,
  planHasTestingStrategySection,
  planHasUnresolvedOpenQuestions,
  readPlanStatus,
  setPlanStatus,
} from "../src/plan-file.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-plan-file-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePlan(status: string): string {
  const activeDir = join(dir, ".ai", "plans", "active");
  mkdirSync(activeDir, { recursive: true });
  const path = join(activeDir, "DAV-5-test-ticket.md");
  writeFileSync(
    path,
    `# Plan: DAV-5 Test ticket\n\n**Status**: ${status}\n**Branch**: feature/DAV-5-test-ticket\n**Created**: 2026-01-01\n**Updated**: 2026-01-01\n`,
    "utf8",
  );
  return path;
}

describe("findPlanFile", () => {
  it("finds the plan file by ticket key prefix", () => {
    const path = writePlan("draft");
    expect(findPlanFile(dir, "DAV-5")).toBe(path);
  });

  it("returns undefined when no plans/active dir exists", () => {
    expect(findPlanFile(dir, "DAV-5")).toBeUndefined();
  });

  it("returns undefined when no file matches the ticket key", () => {
    writePlan("draft");
    expect(findPlanFile(dir, "DAV-9")).toBeUndefined();
  });
});

describe("readPlanStatus", () => {
  it("reads the Status field", () => {
    const path = writePlan("draft");
    expect(readPlanStatus(path)).toBe("draft");
  });

  it("throws on a malformed plan file", () => {
    const path = join(dir, "malformed.md");
    writeFileSync(path, "# no status line here\n", "utf8");
    expect(() => readPlanStatus(path)).toThrow(/no \*\*Status\*\*/);
  });
});

describe("planHasBoundariesSection", () => {
  it("returns false when the plan has no Boundaries heading", () => {
    const path = writePlan("ready");
    expect(planHasBoundariesSection(path)).toBe(false);
  });

  it("returns true when the plan has a Boundaries heading", () => {
    const path = writePlan("ready");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n## Boundaries\n\nDo not touch tests/.\n`, "utf8");
    expect(planHasBoundariesSection(path)).toBe(true);
  });

  it("does not match a mid-sentence mention of 'Boundaries'", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\nStay within the Boundaries described in the ticket.\n`,
      "utf8",
    );
    expect(planHasBoundariesSection(path)).toBe(false);
  });
});

describe("planHasImplementationOrderSection", () => {
  it("returns false when the plan has no Implementation order heading", () => {
    const path = writePlan("ready");
    expect(planHasImplementationOrderSection(path)).toBe(false);
  });

  it("returns true when the plan has a non-empty Implementation order section", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Implementation order\n\n1. Do the thing.\n`,
      "utf8",
    );
    expect(planHasImplementationOrderSection(path)).toBe(true);
  });

  it("matches case-insensitively (## Implementation Order)", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Implementation Order\n\n1. Do the thing.\n`,
      "utf8",
    );
    expect(planHasImplementationOrderSection(path)).toBe(true);
  });

  it("returns false when the heading is present but the section is empty", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Implementation order\n\n## Testing strategy\n\nSomething.\n`,
      "utf8",
    );
    expect(planHasImplementationOrderSection(path)).toBe(false);
  });

  it("does not match a mid-sentence mention", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\nFollow the Implementation order described above.\n`,
      "utf8",
    );
    expect(planHasImplementationOrderSection(path)).toBe(false);
  });
});

describe("planHasTestingStrategySection", () => {
  it("returns false when the plan has no Testing strategy heading", () => {
    const path = writePlan("ready");
    expect(planHasTestingStrategySection(path)).toBe(false);
  });

  it("returns true when the plan has a non-empty Testing strategy section", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Testing strategy\n\nRun \`npm test\`.\n`,
      "utf8",
    );
    expect(planHasTestingStrategySection(path)).toBe(true);
  });

  it("returns false when the heading is present but the section is empty", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Testing strategy\n\n## Boundaries\n\nNone.\n`,
      "utf8",
    );
    expect(planHasTestingStrategySection(path)).toBe(false);
  });
});

describe("planHasQAPlanSection", () => {
  it("returns false when the plan has no QA Plan heading", () => {
    const path = writePlan("ready");
    expect(planHasQAPlanSection(path)).toBe(false);
  });

  it("returns true when the plan has a non-empty QA Plan section", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## QA Plan\n\nNone — automated coverage above is sufficient.\n`,
      "utf8",
    );
    expect(planHasQAPlanSection(path)).toBe(true);
  });

  it("matches case-insensitively (## QA plan)", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## QA plan\n\nManually verify X.\n`,
      "utf8",
    );
    expect(planHasQAPlanSection(path)).toBe(true);
  });

  it("returns false when the heading is present but the section is empty", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## QA Plan\n\n## Boundaries\n\nNone.\n`,
      "utf8",
    );
    expect(planHasQAPlanSection(path)).toBe(false);
  });

  it("does not match a mid-sentence mention", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\nFollow the QA Plan described above.\n`,
      "utf8",
    );
    expect(planHasQAPlanSection(path)).toBe(false);
  });
});

describe("getQAPlanSectionText", () => {
  it("returns undefined when there is no QA Plan section", () => {
    const path = writePlan("ready");
    expect(getQAPlanSectionText(path)).toBeUndefined();
  });

  it("returns the trimmed section text", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## QA Plan\n\nManually verify X against the real API.\n\n## Boundaries\n\nNone.\n`,
      "utf8",
    );
    expect(getQAPlanSectionText(path)).toBe("Manually verify X against the real API.");
  });
});

describe("planHasUnresolvedOpenQuestions", () => {
  it("returns false when there is no Open Questions heading", () => {
    const path = writePlan("ready");
    expect(planHasUnresolvedOpenQuestions(path)).toBe(false);
  });

  it("returns false when the section has only checked items", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Open Questions\n\n- [x] Confirmed default retry count.\n`,
      "utf8",
    );
    expect(planHasUnresolvedOpenQuestions(path)).toBe(false);
  });

  it("returns true when an unchecked item remains", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Open Questions\n\n- [x] Resolved one.\n- [ ] Still open.\n`,
      "utf8",
    );
    expect(planHasUnresolvedOpenQuestions(path)).toBe(true);
  });

  it("returns false when the section is empty", () => {
    const path = writePlan("ready");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n## Open Questions\n\nNone.\n`, "utf8");
    expect(planHasUnresolvedOpenQuestions(path)).toBe(false);
  });

  it("ignores an unchecked item that appears after a later heading", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Open Questions\n\n- [x] Resolved.\n\n## Boundaries\n\n- [ ] not a real task item, just prose that happens to look like one\n`,
      "utf8",
    );
    expect(planHasUnresolvedOpenQuestions(path)).toBe(false);
  });

  // headless-automation-qa.md Phase E found this live: a plan with only a non-blocking
  // "confirm at review" note left unchecked still bounced the ticket to state:needs-input with a
  // misleading "I need answers" comment. planHasUnresolvedOpenQuestions (this function — used by
  // approve_plan's refusal gate, which must NOT weaken) now also scans "## Confirm at Review", so
  // a human still can't slip a plan past approve_plan with one of these left unresolved.
  it("returns true when only Confirm at Review has an unresolved item (approve_plan's gate must still catch it)", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Open Questions\n\n- [x] Resolved.\n\n` +
        `## Confirm at Review\n\n- [ ] Recommend defaulting to 3 retries — confirm at review.\n`,
      "utf8",
    );
    expect(planHasUnresolvedOpenQuestions(path)).toBe(true);
  });

  it("returns false when Confirm at Review is fully resolved too", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Open Questions\n\n- [x] Resolved.\n\n` +
        `## Confirm at Review\n\n- [x] Confirmed.\n`,
      "utf8",
    );
    expect(planHasUnresolvedOpenQuestions(path)).toBe(false);
  });
});

describe("planHasBlockingOpenQuestions", () => {
  // The routing fix itself (src/automation/watchdog-pass.ts): unlike
  // planHasUnresolvedOpenQuestions, this only ever looks at "## Open Questions" — a non-blocking
  // "confirm at review" note living in its own section must never make a plan look blocked.
  it("returns false when there is no Open Questions heading", () => {
    const path = writePlan("ready");
    expect(planHasBlockingOpenQuestions(path)).toBe(false);
  });

  it("returns true when Open Questions has an unchecked item", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Open Questions\n\n- [ ] Still genuinely blocking.\n`,
      "utf8",
    );
    expect(planHasBlockingOpenQuestions(path)).toBe(true);
  });

  it("returns false when Open Questions is fully resolved, even with an unresolved Confirm at Review item", () => {
    const path = writePlan("ready");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n## Open Questions\n\n- [x] Resolved.\n\n` +
        `## Confirm at Review\n\n- [ ] Recommend as-is — confirm at review.\n`,
      "utf8",
    );
    expect(planHasBlockingOpenQuestions(path)).toBe(false);
  });

  it("returns false when both sections are absent", () => {
    const path = writePlan("ready");
    expect(planHasBlockingOpenQuestions(path)).toBe(false);
  });
});

describe("setPlanStatus", () => {
  it("updates Status and bumps Updated", () => {
    const path = writePlan("draft");
    setPlanStatus(path, "ready");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("**Status**: ready");
    expect(content).not.toContain("**Status**: draft");
    const today = new Date().toISOString().slice(0, 10);
    expect(content).toContain(`**Updated**: ${today}`);
  });
});
