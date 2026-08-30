import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { fetchIssue, isTransitionTarget, transitionState } from "../jira/tags.js";

export interface TrackerTransitionResult {
  mirrored: boolean;
  note: string;
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
): Promise<TrackerTransitionResult> {
  if (!isTransitionTarget(state)) {
    throw new Error(
      `Invalid transition target "${state}" — must be one of: needs-input, review, working, verify, problem.`,
    );
  }
  const issue = await fetchIssue(client, key);
  return transitionState(client, issue, state, config);
}
