import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contextFilePath,
  progressLogPath,
  readImplementationResult,
  readPlanningResult,
  readWorkerContext,
  resultFilePath,
  writeWorkerContext,
  type WorkerContext,
} from "../../src/automation/result-file.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-result-file-test-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("path helpers", () => {
  it("computes context/result/progress paths under state/<project>/<kind>/<KEY>", () => {
    expect(contextFilePath("my-app", "DAV-5", stateRoot)).toBe(join(stateRoot, "my-app", "context", "DAV-5.json"));
    expect(resultFilePath("my-app", "DAV-5", stateRoot)).toBe(join(stateRoot, "my-app", "result", "DAV-5.json"));
    expect(progressLogPath("my-app", "DAV-5", stateRoot)).toBe(join(stateRoot, "my-app", "progress", "DAV-5.log"));
  });
});

describe("writeWorkerContext / readWorkerContext", () => {
  const context: WorkerContext = {
    ticketKey: "DAV-5",
    phase: "planning",
    summary: "Fix the thing",
    description: "It's broken.",
    comments: [{ author: "Dev", body: "Please prioritize.", created: "2026-01-01" }],
  };

  it("returns undefined when no context file exists yet", () => {
    expect(readWorkerContext("my-app", "DAV-5", stateRoot)).toBeUndefined();
  });

  it("round-trips a written context", () => {
    writeWorkerContext("my-app", context, stateRoot);
    expect(readWorkerContext("my-app", "DAV-5", stateRoot)).toEqual(context);
  });
});

function writeRawResult(projectName: string, ticketKey: string, data: unknown): void {
  const path = resultFilePath(projectName, ticketKey, stateRoot);
  mkdirSync(join(stateRoot, projectName, "result"), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf8");
}

describe("readPlanningResult", () => {
  it("returns undefined when no result file exists yet (still running)", () => {
    expect(readPlanningResult("my-app", "DAV-5", stateRoot)).toBeUndefined();
  });

  it("reads a done outcome", () => {
    writeRawResult("my-app", "DAV-5", { outcome: "done" });
    expect(readPlanningResult("my-app", "DAV-5", stateRoot)).toEqual({ outcome: "done" });
  });

  it("reads a blocked outcome with notes", () => {
    writeRawResult("my-app", "DAV-5", { outcome: "blocked", notes: "repo doesn't match the ticket" });
    expect(readPlanningResult("my-app", "DAV-5", stateRoot)).toEqual({
      outcome: "blocked",
      notes: "repo doesn't match the ticket",
    });
  });

  it("throws on a malformed result file", () => {
    writeRawResult("my-app", "DAV-5", { outcome: "not-a-real-outcome" });
    expect(() => readPlanningResult("my-app", "DAV-5", stateRoot)).toThrow(/malformed/);
  });
});

describe("readImplementationResult", () => {
  it("returns undefined when no result file exists yet", () => {
    expect(readImplementationResult("my-app", "DAV-5", stateRoot)).toBeUndefined();
  });

  it("reads a success outcome", () => {
    writeRawResult("my-app", "DAV-5", {
      outcome: "success",
      summary: "Added the endpoint.",
      verify: "make test passed",
    });
    expect(readImplementationResult("my-app", "DAV-5", stateRoot)).toEqual({
      outcome: "success",
      summary: "Added the endpoint.",
      verify: "make test passed",
    });
  });

  it("reads a blocked outcome", () => {
    writeRawResult("my-app", "DAV-5", { outcome: "blocked", whatHappened: "make test fails, can't fix" });
    expect(readImplementationResult("my-app", "DAV-5", stateRoot)).toEqual({
      outcome: "blocked",
      whatHappened: "make test fails, can't fix",
    });
  });

  it("throws on a malformed result file", () => {
    writeRawResult("my-app", "DAV-5", { notAnOutcomeField: true });
    expect(() => readImplementationResult("my-app", "DAV-5", stateRoot)).toThrow(/malformed/);
  });
});
