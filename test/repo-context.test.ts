import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoConfig, writeRepoConfig } from "../src/repo-context.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-repo-context-test-"));
  execFileSync("git", ["init", "-b", "main", repoRoot]);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeRawConfig(config: Record<string, unknown>): void {
  mkdirSync(join(repoRoot, ".ai"), { recursive: true });
  writeFileSync(join(repoRoot, ".ai", "intake-mcp.json"), JSON.stringify(config), "utf8");
}

describe("readRepoConfig", () => {
  it("returns undefined when no config file exists", () => {
    expect(readRepoConfig(repoRoot)).toBeUndefined();
  });

  it("reads the current jiraProjectKeys array form", () => {
    writeRawConfig({ jiraProjectKeys: ["DAV", "OPS"], appTag: "app:my-repo" });
    expect(readRepoConfig(repoRoot)).toEqual({ jiraProjectKeys: ["DAV", "OPS"], appTag: "app:my-repo" });
  });

  it("reads a legacy singular jiraProjectKey as a one-element list (backward compat)", () => {
    writeRawConfig({ jiraProjectKey: "DAV", appTag: "app:my-repo" });
    expect(readRepoConfig(repoRoot)).toEqual({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo" });
  });

  it("preserves skipTargets alongside either key shape", () => {
    writeRawConfig({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo", skipTargets: ["lint"] });
    expect(readRepoConfig(repoRoot)).toEqual({
      jiraProjectKeys: ["DAV"],
      appTag: "app:my-repo",
      skipTargets: ["lint"],
    });
  });

  it("throws when neither jiraProjectKeys nor jiraProjectKey is present", () => {
    writeRawConfig({ appTag: "app:my-repo" });
    expect(() => readRepoConfig(repoRoot)).toThrow(/malformed/);
  });

  it("throws when jiraProjectKeys is present but not an array of strings", () => {
    writeRawConfig({ jiraProjectKeys: [1, 2], appTag: "app:my-repo" });
    expect(() => readRepoConfig(repoRoot)).toThrow(/malformed/);
  });

  it("throws when appTag is missing", () => {
    writeRawConfig({ jiraProjectKeys: ["DAV"] });
    expect(() => readRepoConfig(repoRoot)).toThrow(/malformed/);
  });
});

describe("writeRepoConfig", () => {
  it("always writes the jiraProjectKeys array form, never the legacy singular", () => {
    const path = writeRepoConfig(repoRoot, { jiraProjectKeys: ["DAV", "OPS"], appTag: "app:my-repo" });
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual({ jiraProjectKeys: ["DAV", "OPS"], appTag: "app:my-repo" });
  });
});
