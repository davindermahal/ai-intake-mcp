import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { worktreeRemoveTool } from "../../src/tools/worktree-remove.js";
import { findWorktreeForTicket, worktreeCreate } from "../../src/worktree.js";

let repoRoot: string;
let parentDir: string;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-worktree-remove-tool-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

describe("worktreeRemoveTool", () => {
  it("is a thin passthrough to worktreeRemove", async () => {
    await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    execFileSync("git", ["merge", "--no-ff", "-m", "merge it", "feature/DAV-5-fix-the-thing"], { cwd: repoRoot });

    const result = worktreeRemoveTool("DAV-5", {}, repoRoot);
    expect(result.worktree.removed).toBe(true);
    expect(findWorktreeForTicket("DAV-5", repoRoot)).toBeUndefined();
  });

  it("propagates a refusal for an unmerged branch without force", async () => {
    const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: created.worktreePath });
    expect(() => worktreeRemoveTool("DAV-5", {}, repoRoot)).toThrow(/not merged/);
  });
});
