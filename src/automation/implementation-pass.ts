import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { buildDiscoveryJql, searchIssues } from "../jira/search.js";
import { STATE_LABEL, addComment, currentStateLabel, fetchIssue, transitionState } from "../jira/tags.js";
import {
  findPlanFile,
  planHasImplementationOrderSection,
  planHasTestingStrategySection,
  planHasUnresolvedOpenQuestions,
  readPlanStatus,
  setPlanStatus,
} from "../plan-file.js";
import type { RepoConfig } from "../repo-context.js";
import { worktreeCreate } from "../worktree.js";
import { type DispatchContext, dispatchWorker } from "./dispatch.js";
import { AUTOMATION_COMMENT_FOOTER } from "./footer.js";
import { canDispatchImplementation, readMarker } from "./markers.js";

/**
 * Implementation pass (decisions #3/#17) — one project, one cron tick, at most one dispatch (the
 * fixed structural concurrency cap, decision #4/#5). Finds a `state:implement` ticket with an
 * approved plan; if the plan is still `Status: draft` (a human approved by moving the Jira label
 * directly rather than calling `approve_plan`), runs the same gates `approve_plan` runs and either
 * promotes it to `ready` or bounces the ticket back to `state:review` with an explanation — never a
 * watchdog retry or escalation, since this is a human's mistake to notice and fix, not a stalled
 * worker (decision #17, Review Finding #3.2).
 */
export interface ImplementationPassContext extends DispatchContext {
  client: JiraClient;
  config: GlobalConfig;
  repoConfig: RepoConfig;
}

export interface ImplementationPassResult {
  dispatched: string | undefined;
  bounced: string[];
}

function bounceMessage(missing: string[]): string {
  return (
    `This ticket was moved to state:implement, but its plan still has unresolved gates: ` +
    `${missing.join(", ")}. Bouncing back to state:review — fix the plan (or re-approve properly) ` +
    `before implementation can start.`
  );
}

function startMessage(branch: string, worktreePath: string, planPath: string): string {
  return (
    `Implementation starting on branch \`${branch}\` (worktree: \`${worktreePath}\`).\n\n` +
    `Plan: \`${planPath}\`.`
  );
}

export async function runImplementationPass(ctx: ImplementationPassContext): Promise<ImplementationPassResult> {
  const bounced: string[] = [];
  if (!canDispatchImplementation(ctx.project.name, ctx.stateRoot)) {
    return { dispatched: undefined, bounced };
  }

  const query = buildDiscoveryJql({
    projectKeys: ctx.repoConfig.jiraProjectKeys,
    appTag: ctx.repoConfig.appTag,
    stateLabels: ["implement"],
  });
  const candidates = await searchIssues(ctx.client, query);

  for (const candidate of candidates) {
    if (readMarker(ctx.project.name, candidate.key, ctx.stateRoot)) continue;

    const worktree = await worktreeCreate(candidate.key, async () => candidate.summary, ctx.project.path);
    const planPath = findPlanFile(worktree.worktreePath, candidate.key);
    if (!planPath) continue;

    const status = readPlanStatus(planPath);
    if (status === "draft") {
      const missing: string[] = [];
      if (planHasUnresolvedOpenQuestions(planPath)) missing.push('unresolved "## Open Questions" items');
      if (!planHasImplementationOrderSection(planPath)) missing.push('no "## Implementation order" section');
      if (!planHasTestingStrategySection(planPath)) missing.push('no "## Testing strategy" section');

      if (missing.length > 0) {
        const freshIssue = await fetchIssue(ctx.client, candidate.key);
        await addComment(ctx.client, candidate.key, bounceMessage(missing), AUTOMATION_COMMENT_FOOTER);
        await transitionState(ctx.client, freshIssue, "review", ctx.config);
        bounced.push(candidate.key);
        continue;
      }
      setPlanStatus(planPath, "ready");
    } else if (status !== "ready" && status !== "active") {
      continue;
    }

    const freshIssue = await fetchIssue(ctx.client, candidate.key);
    const currentState = currentStateLabel(freshIssue.labels);
    if (currentState === STATE_LABEL.implement) {
      await addComment(
        ctx.client,
        candidate.key,
        startMessage(worktree.branch, worktree.worktreePath, planPath),
        AUTOMATION_COMMENT_FOOTER,
      );
      await transitionState(ctx.client, freshIssue, "working", ctx.config);
    }

    await dispatchWorker(ctx, freshIssue, "implementation", 1);
    return { dispatched: candidate.key, bounced };
  }

  return { dispatched: undefined, bounced };
}
