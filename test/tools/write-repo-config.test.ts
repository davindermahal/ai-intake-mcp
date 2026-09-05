import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRepoConfigTool } from "../../src/tools/write-repo-config.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-write-repo-config-test-"));
  execFileSync("git", ["init", "-b", "main", repoRoot]);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("writeRepoConfigTool", () => {
  it("writes jiraProjectKeys and appTag with no skipTargets on a fresh repo", () => {
    const { path } = writeRepoConfigTool(["DAV"], "app:my-repo", repoRoot);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo" });
  });

  it("preserves an existing skipTargets when overwriting jiraProjectKeys/appTag", () => {
    const first = writeRepoConfigTool(["DAV"], "app:my-repo", repoRoot);
    const withSkip = { jiraProjectKeys: ["DAV"], appTag: "app:my-repo", skipTargets: ["lint"] };
    writeFileSync(first.path, JSON.stringify(withSkip), "utf8");

    writeRepoConfigTool(["DAV2", "OPS"], "app:renamed", repoRoot);
    const written = JSON.parse(readFileSync(first.path, "utf8"));
    expect(written).toEqual({
      jiraProjectKeys: ["DAV2", "OPS"],
      appTag: "app:renamed",
      skipTargets: ["lint"],
    });
  });
});
