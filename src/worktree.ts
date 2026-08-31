import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveRepoRoot } from "./repo-context.js";

/** Worktree creation is pure git (decision #5) — no DB/container provisioning, no adapter contract. */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** Reuses a matching existing branch for this ticket, if one exists (decision #5). */
function findExistingBranch(repoRoot: string, ticketKey: string): string | undefined {
  const out = git(["branch", "--list", `feature/${ticketKey}-*`, "--format=%(refname:short)"], repoRoot);
  return out.split("\n").map((l) => l.trim()).find((l) => l !== "");
}

/** Base branch resolution ("Resolved: Default base branch") — origin/HEAD, then local main/master. */
function resolveBaseBranch(repoRoot: string): string {
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot);
    const branch = ref.split("/").pop();
    if (branch) return branch;
  } catch {
    // No remote configured, or never fetched — fall through to local fallbacks.
  }
  if (branchExists(repoRoot, "main")) return "main";
  if (branchExists(repoRoot, "master")) return "master";
  throw new Error(
    "Could not resolve a default base branch (no origin/HEAD, no local main or master) — specify one explicitly.",
  );
}

function existingWorktreePathFor(repoRoot: string, branch: string): string | undefined {
  const list = git(["worktree", "list", "--porcelain"], repoRoot);
  for (const entry of list.split("\n\n")) {
    const lines = entry.split("\n");
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (worktreeLine && branchLine === `branch refs/heads/${branch}`) {
      return worktreeLine.slice("worktree ".length);
    }
  }
  return undefined;
}

const HOOK_SCRIPTS: Record<string, string> = {
  "pre-push": [
    "#!/bin/sh",
    `echo "ai-intake-mcp: git push is blocked in this managed worktree — push manually from a normal checkout after review." >&2`,
    "exit 1",
    "",
  ].join("\n"),
  "pre-merge-commit": [
    "#!/bin/sh",
    `echo "ai-intake-mcp: local merge is blocked in this managed worktree (run 'git merge --abort' to clean up if one is in progress) — merge manually from a normal checkout after review." >&2`,
    "exit 1",
    "",
  ].join("\n"),
};

/**
 * Blocks `git push` and any local non-fast-forward merge from inside this one worktree, without
 * touching the developer's main checkout or any other worktree (implementation-phase plan decision
 * #10, revisited by the hardening-phase plan — a settings-based permission deny-list only works for
 * hosts with that model and is easy for a weaker/less-compliant executor to never have enabled).
 *
 * Git resolves a *relative* `core.hooksPath` against the worktree's working-tree root, not its
 * private git dir — verified empirically while designing this — so this always writes an absolute
 * path pointing into the worktree's own `git rev-parse --git-dir` (never the tracked working tree,
 * so the hook scripts never land on the ticket branch itself). Idempotent: safe to call on every
 * `worktreeCreate`, not just first creation.
 *
 * Known, permanent limits: a fast-forward merge creates no merge commit, so `pre-merge-commit` never
 * fires for one (verified empirically) — same for `git merge --squash`. Neither hook can reach a
 * remote-side merge (`gh pr merge`, GitHub's UI) — that was never a local git operation to begin
 * with, so no local hook, in this design or any other, can intercept it.
 */
function installPushMergeGuard(worktreePath: string, repoRoot: string): void {
  git(["config", "extensions.worktreeConfig", "true"], repoRoot);
  const gitDir = resolve(worktreePath, git(["rev-parse", "--git-dir"], worktreePath));
  const hooksDir = join(gitDir, "hooks-block");
  mkdirSync(hooksDir, { recursive: true });
  for (const [name, contents] of Object.entries(HOOK_SCRIPTS)) {
    writeFileSync(join(hooksDir, name), contents, { mode: 0o755 });
  }
  git(["config", "--worktree", "core.hooksPath", hooksDir], worktreePath);
}

export interface WorktreeResult {
  worktreePath: string;
  branch: string;
}

/**
 * Resolves an existing worktree by ticket key alone — not the caller's cwd (implementation-phase
 * plan, decision #5: `approve_plan`/`worktree_remove` can't assume the caller is already sitting in
 * the right directory, since the ticket's plan file only exists inside that specific worktree).
 * Undefined if there's no branch for this ticket yet, or a branch exists but has no live worktree.
 */
export function findWorktreeForTicket(ticketKey: string, cwd: string = process.cwd()): WorktreeResult | undefined {
  const repoRoot = resolveRepoRoot(cwd);
  const branch = findExistingBranch(repoRoot, ticketKey);
  if (!branch) return undefined;
  const worktreePath = existingWorktreePathFor(repoRoot, branch);
  return worktreePath ? { worktreePath, branch } : undefined;
}

function isMergedInto(repoRoot: string, branch: string, base: string): boolean {
  const merged = git(["branch", "--merged", base, "--format=%(refname:short)"], repoRoot);
  return merged.split("\n").map((l) => l.trim()).includes(branch);
}

export interface WorktreeRemoveResult {
  worktree: { path: string; removed: boolean };
  branch: { name: string; removed: boolean };
}

/**
 * Pure git, no container/DB (implementation-phase plan, decision #11 — there never was one to tear
 * down). Guarded the same way the harness's `worktree-remove.sh` guards it: only `feature/*`
 * branches, and only merged into the resolved base branch unless `force`.
 */
export function worktreeRemove(
  ticketKey: string,
  options: { force?: boolean; keepBranch?: boolean } = {},
  cwd: string = process.cwd(),
): WorktreeRemoveResult {
  const repoRoot = resolveRepoRoot(cwd);
  const found = findWorktreeForTicket(ticketKey, cwd);
  if (!found) {
    throw new Error(`No worktree found for ${ticketKey} — nothing to remove.`);
  }
  const { worktreePath, branch } = found;

  if (!branch.startsWith("feature/")) {
    throw new Error(`Refusing to remove "${branch}" — only feature/* branches are removable.`);
  }

  const base = resolveBaseBranch(repoRoot);
  if (!options.force && !isMergedInto(repoRoot, branch, base)) {
    throw new Error(
      `"${branch}" is not merged into "${base}" — pass force:true to remove it anyway (uncommitted work will be lost).`,
    );
  }

  try {
    git(["worktree", "remove", "--force", worktreePath], repoRoot);
  } catch (err) {
    throw new Error(`Failed to remove worktree at ${worktreePath}: ${(err as Error).message}`);
  }
  git(["worktree", "prune"], repoRoot);

  let branchRemoved = false;
  if (!options.keepBranch) {
    try {
      git(["branch", options.force ? "-D" : "-d", branch], repoRoot);
      branchRemoved = true;
    } catch {
      branchRemoved = false;
    }
  }

  return {
    worktree: { path: worktreePath, removed: true },
    branch: { name: branch, removed: branchRemoved },
  };
}

/**
 * Resumes rather than errors: an existing worktree for the ticket's branch is returned, not refused.
 * `resolveSummary` is only called (i.e. Jira is only hit) when a brand-new branch actually needs to
 * be minted — reusing an existing branch/worktree needs no ticket summary at all.
 */
export async function worktreeCreate(
  ticketKey: string,
  resolveSummary: () => Promise<string>,
  cwd: string = process.cwd(),
): Promise<WorktreeResult> {
  const repoRoot = resolveRepoRoot(cwd);
  const branch = findExistingBranch(repoRoot, ticketKey) ?? `feature/${ticketKey}-${slugify(await resolveSummary())}`;

  let worktreePath = existingWorktreePathFor(repoRoot, branch);
  if (!worktreePath) {
    worktreePath = join(dirname(repoRoot), branch.replace(/\//g, "-"));
    if (existsSync(worktreePath)) {
      throw new Error(
        `${worktreePath} already exists but isn't a registered worktree for ${branch} — refusing to overwrite.`,
      );
    }

    if (branchExists(repoRoot, branch)) {
      git(["worktree", "add", worktreePath, branch], repoRoot);
    } else {
      const base = resolveBaseBranch(repoRoot);
      git(["worktree", "add", "-b", branch, worktreePath, base], repoRoot);
    }
  }

  installPushMergeGuard(worktreePath, repoRoot);
  return { worktreePath, branch };
}
