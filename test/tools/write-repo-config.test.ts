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
  it("writes jiraProjectKey and appTag with no skipTargets on a fresh repo", () => {
    const { path } = writeRepoConfigTool("DAV", "app:my-repo", repoRoot);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual({ jiraProjectKey: "DAV", appTag: "app:my-repo" });
  });

  it("preserves an existing skipTargets when overwriting jiraProjectKey/appTag", () => {
    const first = writeRepoConfigTool("DAV", "app:my-repo", repoRoot);
    const withSkip = { jiraProjectKey: "DAV", appTag: "app:my-repo", skipTargets: ["lint"] };
    writeFileSync(first.path, JSON.stringify(withSkip), "utf8");

    writeRepoConfigTool("DAV2", "app:renamed", repoRoot);
    const written = JSON.parse(readFileSync(first.path, "utf8"));
    expect(written).toEqual({ jiraProjectKey: "DAV2", appTag: "app:renamed", skipTargets: ["lint"] });
  });
});
