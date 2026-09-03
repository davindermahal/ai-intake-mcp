import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeHeartbeat, readProgressSince } from "../../src/automation/progress-log.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-progress-log-test-"));
  logPath = join(dir, "DAV-5.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readProgressSince", () => {
  it("returns no entries and position 0 when the log file doesn't exist yet", () => {
    const result = readProgressSince(logPath, 0);
    expect(result).toEqual({ entries: [], readPosition: 0 });
  });

  it("parses Done/Next pairs from the start of the file", () => {
    writeFileSync(logPath, "Done: read the ticket\nNext: draft a first pass\n", "utf8");
    const result = readProgressSince(logPath, 0);
    expect(result.entries).toEqual([{ done: "read the ticket", next: "draft a first pass" }]);
    expect(result.readPosition).toBe(2);
  });

  it("only returns lines appended since the given read position", () => {
    writeFileSync(
      logPath,
      "Done: read the ticket\nNext: draft a first pass\nDone: drafted a first pass\nNext: resolve open questions\n",
      "utf8",
    );
    const result = readProgressSince(logPath, 2);
    expect(result.entries).toEqual([{ done: "drafted a first pass", next: "resolve open questions" }]);
    expect(result.readPosition).toBe(4);
  });

  it("returns nothing new when the position is already at the end", () => {
    writeFileSync(logPath, "Done: a\nNext: b\n", "utf8");
    const result = readProgressSince(logPath, 2);
    expect(result.entries).toEqual([]);
    expect(result.readPosition).toBe(2);
  });

  it("parses multiple entries in one read", () => {
    writeFileSync(
      logPath,
      "Done: step one\nNext: step two\nDone: step two\nNext: step three\n",
      "utf8",
    );
    const result = readProgressSince(logPath, 0);
    expect(result.entries).toEqual([
      { done: "step one", next: "step two" },
      { done: "step two", next: "step three" },
    ]);
  });

  it("ignores a trailing Done with no matching Next yet (incomplete entry)", () => {
    writeFileSync(logPath, "Done: step one\nNext: step two\nDone: step two\n", "utf8");
    const result = readProgressSince(logPath, 0);
    expect(result.entries).toEqual([{ done: "step one", next: "step two" }]);
    // readPosition stays before the dangling "Done: step two" line so it's picked up once its
    // matching "Next:" line lands.
    expect(result.readPosition).toBe(2);
  });
});

describe("composeHeartbeat", () => {
  it("bullets every Done line and states the most recent Next line", () => {
    const body = composeHeartbeat({
      entries: [
        { done: "read the ticket", next: "draft a first pass" },
        { done: "drafted a first pass", next: "resolve open questions" },
      ],
      lastKnownNext: undefined,
    });
    expect(body).toBe(
      "Still working. Progress since the last update:\n" +
        "- read the ticket\n" +
        "- drafted a first pass\n\n" +
        "Next: resolve open questions",
    );
  });

  it("falls back to restating the last known Next line when nothing new landed", () => {
    const body = composeHeartbeat({ entries: [], lastKnownNext: "resolve open questions" });
    expect(body).toBe("Still working. Next: resolve open questions");
  });

  it("has a generic fallback when there is no new progress and no prior Next line", () => {
    const body = composeHeartbeat({ entries: [], lastKnownNext: undefined });
    expect(body).toBe("Still working.");
  });
});
