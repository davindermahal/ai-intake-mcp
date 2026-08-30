import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorktreeForTicket, worktreeCreate, worktreeRemove } from "../src/worktree.js";

let repoRoot: string;
let parentDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-worktree-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  git(["config", "user.email", "test@example.com"], repoRoot);
  git(["config", "user.name", "Test"], repoRoot);
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

describe("worktreeCreate", () => {
  it("mints a new branch + sibling worktree off the local main when there's no origin", async () => {
    const result = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    expect(result.branch).toBe("feature/DAV-5-fix-the-thing");
    expect(result.worktreePath).toBe(join(parentDir, "feature-DAV-5-fix-the-thing"));

    const worktrees = git(["worktree", "list", "--porcelain"], repoRoot);
    expect(worktrees).toContain("branch refs/heads/feature/DAV-5-fix-the-thing");
  });

  it("resumes an existing worktree instead of failing", async () => {
    const first = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    const second = await worktreeCreate("DAV-5", async () => "Fix the thing (renamed)", repoRoot);
    expect(second).toEqual(first);
  });

  it("reuses a matching existing branch without needing the summary again", async () => {
    const first = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    git(["worktree", "remove", first.worktreePath], repoRoot);

    let summaryFetched = false;
    const second = await worktreeCreate(
      "DAV-5",
      async () => {
        summaryFetched = true;
        return "should not be used";
      },
      repoRoot,
    );
    expect(second.branch).toBe(first.branch);
    expect(summaryFetched).toBe(false);
  });
});

describe("findWorktreeForTicket", () => {
  it("returns undefined when no branch exists for the ticket", () => {
    expect(findWorktreeForTicket("DAV-5", repoRoot)).toBeUndefined();
  });

  it("returns undefined when the branch exists but has no live worktree", async () => {
    const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    git(["worktree", "remove", created.worktreePath], repoRoot);
    expect(findWorktreeForTicket("DAV-5", repoRoot)).toBeUndefined();
  });

  it("returns the worktree path + branch when both exist", async () => {
    const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    expect(findWorktreeForTicket("DAV-5", repoRoot)).toEqual(created);
  });
});

describe("worktreeRemove", () => {
  it("throws when no worktree exists for the ticket", () => {
    expect(() => worktreeRemove("DAV-5", {}, repoRoot)).toThrow(/No worktree found/);
  });

  it("refuses an unmerged branch without force", async () => {
    const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: created.worktreePath });
    expect(() => worktreeRemove("DAV-5", {}, repoRoot)).toThrow(/not merged/);
  });

  it("removes an unmerged branch's worktree + branch with force", async () => {
    const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    execFileSync("git", ["commit", "--allow-empty", "-m", "work"], { cwd: created.worktreePath });
    const result = worktreeRemove("DAV-5", { force: true }, repoRoot);
    expect(result.worktree).toEqual({ path: created.worktreePath, removed: true });
    expect(result.branch).toEqual({ name: created.branch, removed: true });
    expect(findWorktreeForTicket("DAV-5", repoRoot)).toBeUndefined();
  });

  it("removes a merged branch's worktree + branch without force", async () => {
    const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    git(["merge", "--no-ff", "-m", "merge it", created.branch], repoRoot);

    const result = worktreeRemove("DAV-5", {}, repoRoot);
    expect(result.branch.removed).toBe(true);
  });

  it("keeps the branch when keepBranch is set", async () => {
    const created = await worktreeCreate("DAV-5", async () => "Fix the thing", repoRoot);
    const result = worktreeRemove("DAV-5", { force: true, keepBranch: true }, repoRoot);
    expect(result.branch).toEqual({ name: created.branch, removed: false });
    expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${created.branch}`], repoRoot)).toBeTruthy();
  });
});
