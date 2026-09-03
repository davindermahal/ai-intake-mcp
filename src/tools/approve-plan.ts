import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { STATE_LABEL, currentStateLabel, fetchIssue, transitionState } from "../jira/tags.js";
import {
  findPlanFile,
  planHasImplementationOrderSection,
  planHasTestingStrategySection,
  planHasUnresolvedOpenQuestions,
  readPlanStatus,
  setPlanStatus,
} from "../plan-file.js";
import { findWorktreeForTicket } from "../worktree.js";

export interface ApprovePlanResult {
  planPath: string;
  transitionedTo: "implement";
}

/**
 * The only way to reach `state:implement` (implementation-phase plan, decision #5) — keeps the
 * plan file's `Status` field and the Jira label from drifting apart. Order matters: the Jira
 * transition (which has real gating logic — the ticket must currently be `state:review`) happens
 * *before* the plan file is touched, so a failed/refused Jira call never leaves a plan file that
 * claims approval Jira never actually recorded.
 */
export async function approvePlanTool(
  client: JiraClient,
  config: GlobalConfig,
  ticketKey: string,
  cwd?: string,
): Promise<ApprovePlanResult> {
  const worktree = findWorktreeForTicket(ticketKey, cwd);
  if (!worktree) {
    throw new Error(`No worktree found for ${ticketKey} — run worktree_create (or plan_ticket) first.`);
  }

  const planPath = findPlanFile(worktree.worktreePath, ticketKey);
  if (!planPath) {
    throw new Error(`No plan file found for ${ticketKey} in ${worktree.worktreePath}.`);
  }
  const status = readPlanStatus(planPath);
  if (status !== "draft") {
    throw new Error(`Plan for ${ticketKey} is "${status}", not "draft" — refusing to approve.`);
  }
  if (planHasUnresolvedOpenQuestions(planPath)) {
    throw new Error(
      `Plan for ${ticketKey} (${planPath}) has unresolved "- [ ]" items under "## Open Questions" ` +
        `— refusing to approve. Resolve or explicitly check off each one (flip to "- [x]") first.`,
    );
  }
  if (!planHasImplementationOrderSection(planPath)) {
    throw new Error(
      `Plan for ${ticketKey} (${planPath}) has no "## Implementation order" section (or it's empty) ` +
        `— refusing to approve. Required on every plan (docs://planning-procedure).`,
    );
  }
  if (!planHasTestingStrategySection(planPath)) {
    throw new Error(
      `Plan for ${ticketKey} (${planPath}) has no "## Testing strategy" section (or it's empty) — ` +
        `refusing to approve. Required on every plan, TDD-style (docs://planning-procedure).`,
    );
  }

  const issue = await fetchIssue(client, ticketKey);
  const currentState = currentStateLabel(issue.labels);
  if (currentState !== STATE_LABEL.review) {
    throw new Error(
      `${ticketKey} is currently "${currentState ?? "unlabeled"}", not "${STATE_LABEL.review}" — refusing to approve.`,
    );
  }

  await transitionState(client, issue, "implement", config);
  setPlanStatus(planPath, "ready");

  return { planPath, transitionedTo: "implement" };
}
