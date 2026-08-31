import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlanFile, planHasBoundariesSection, readPlanStatus, setPlanStatus } from "../src/plan-file.js";

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
