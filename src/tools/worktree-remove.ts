import { worktreeRemove, type WorktreeRemoveResult } from "../worktree.js";

/** The one genuinely destructive tool in the surface (decision #11) — pure git, no container/DB. */
export function worktreeRemoveTool(
  ticketKey: string,
  options: { force?: boolean; keepBranch?: boolean } = {},
  cwd?: string,
): WorktreeRemoveResult {
  return worktreeRemove(ticketKey, options, cwd);
}
