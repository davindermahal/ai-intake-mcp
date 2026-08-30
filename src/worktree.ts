import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

  const existingPath = existingWorktreePathFor(repoRoot, branch);
  if (existingPath) return { worktreePath: existingPath, branch };

  const worktreePath = join(dirname(repoRoot), branch.replace(/\//g, "-"));
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

  return { worktreePath, branch };
}
