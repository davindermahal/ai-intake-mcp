import { join } from "node:path";
import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { fetchIssue, isTransitionTarget, transitionState } from "../jira/tags.js";
import { contradictedSkipTargets } from "../makefile.js";
import { readRepoConfig } from "../repo-context.js";
import { findWorktreeForTicket } from "../worktree.js";

export interface TrackerTransitionResult {
  mirrored: boolean;
  note: string;
}

/**
 * Checked only on a transition to `verify` (hardening-phase plan, decision #3): if the ticket has a
 * worktree with a `.ai/intake-mcp.json` declaring `skipTargets`, and the Makefile there actually
 * defines one of those targets, that's a real, catchable contradiction — the project both has the
 * target and someone declared it doesn't apply, likely stale or wrong. No worktree, no config, or no
 * `skipTargets` at all → nothing to check, silently. This is *not* a check that a non-skipped target
 * was actually run and passed — no code here executes `make` on the agent's behalf, so that remains
 * entirely dependent on the agent following `docs://implementation-procedure` §4.
 */
function checkSkipTargetsAgainstMakefile(key: string, cwd: string | undefined): void {
  const worktree = findWorktreeForTicket(key, cwd);
  if (!worktree) return;
  const repoConfig = readRepoConfig(worktree.worktreePath);
  if (!repoConfig?.skipTargets?.length) return;

  const makefilePath = join(worktree.worktreePath, "Makefile");
  const contradictions = contradictedSkipTargets(makefilePath, repoConfig.skipTargets);
  if (contradictions.length > 0) {
    throw new Error(
      `${key}'s Makefile defines ${contradictions.map((t) => `"${t}"`).join(", ")}, but ` +
        `.ai/intake-mcp.json's "skipTargets" claims it doesn't apply — refusing to transition to ` +
        `"verify". Fix the contradiction (run the target, or correct skipTargets) before retrying.`,
    );
  }
}

/**
 * States: `needs-input`, `review`, `working`, `verify`, `problem`. `plan` is bootstrap-only and
 * `implement` is reachable only via `approve_plan` (implementation-phase plan, decision #5) — both
 * excluded here. Assignee-gated, auto-assigning first if unassigned (see `transitionState`).
 */
export async function trackerTransition(
  client: JiraClient,
  config: GlobalConfig,
  key: string,
  state: string,
  cwd?: string,
): Promise<TrackerTransitionResult> {
  if (!isTransitionTarget(state)) {
    throw new Error(
      `Invalid transition target "${state}" — must be one of: needs-input, review, working, verify, problem.`,
    );
  }
  if (state === "verify") {
    checkSkipTargetsAgainstMakefile(key, cwd);
  }
  const issue = await fetchIssue(client, key);
  return transitionState(client, issue, state, config);
}
