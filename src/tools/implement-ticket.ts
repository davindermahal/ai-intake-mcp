import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { STATE_LABEL, currentStateLabel, fetchIssue, transitionState } from "../jira/tags.js";
import { findPlanFile, planHasBoundariesSection, readPlanStatus } from "../plan-file.js";
import { worktreeCreateTool } from "./worktree-create.js";

export interface ImplementTicketResult {
  worktreePath: string;
  branch: string;
  planPath: string;
}

/**
 * Orchestrates the *setup* for an implementation session (implementation-phase plan, decisions #4,
 * #8, and the `implement_ticket` tool-surface entry): resolve/resume the worktree first — the plan
 * file this needs to read only exists inside it — then confirm the approval gate from inside it,
 * then transition to `state:working` if this is the first run. The actual implementation work
 * (editing code, running `make` targets, committing, and the final `tracker_add_comment` +
 * `tracker_transition(key, "verify" | "problem")`) happens afterward, driven by the agent following
 * `docs://implementation-procedure` across the rest of the session — not something a single
 * synchronous tool call can determine, so this tool does not return a final outcome.
 */
export async function implementTicketTool(
  client: JiraClient,
  config: GlobalConfig,
  ticketKey: string,
  cwd?: string,
): Promise<ImplementTicketResult> {
  const worktree = await worktreeCreateTool(client, ticketKey, cwd);

  const planPath = findPlanFile(worktree.worktreePath, ticketKey);
  if (!planPath) {
    throw new Error(
      `No plan file found for ${ticketKey} in ${worktree.worktreePath} — run plan_ticket first.`,
    );
  }
  const status = readPlanStatus(planPath);
  if (status !== "ready" && status !== "active") {
    throw new Error(
      `Plan for ${ticketKey} is "${status}" — must be "ready" (call approve_plan first) or "active" ` +
        `(a resumed run) before implementing.`,
    );
  }
  if (!planHasBoundariesSection(planPath)) {
    throw new Error(
      `Plan for ${ticketKey} (${planPath}) has no "## Boundaries" section — refusing to implement. ` +
        `Boundaries are required (docs://planning-procedure); add one via plan_ticket before implementing.`,
    );
  }

  const issue = await fetchIssue(client, ticketKey);
  const currentState = currentStateLabel(issue.labels);
  if (currentState !== STATE_LABEL.implement && currentState !== STATE_LABEL.working) {
    throw new Error(
      `${ticketKey} is currently "${currentState ?? "unlabeled"}", not "${STATE_LABEL.implement}"/` +
        `"${STATE_LABEL.working}" — call approve_plan first.`,
    );
  }
  if (currentState === STATE_LABEL.implement) {
    await transitionState(client, issue, "working", config);
  }

  return { worktreePath: worktree.worktreePath, branch: worktree.branch, planPath };
}
