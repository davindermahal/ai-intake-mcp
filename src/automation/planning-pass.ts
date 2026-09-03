import type { JiraClient } from "../jira/client.js";
import { buildDiscoveryJql, searchIssues } from "../jira/search.js";
import type { JiraIssue } from "../jira/tags.js";
import { type DispatchContext, dispatchWorker } from "./dispatch.js";
import { canDispatchPlanning, readMarker } from "./markers.js";
import type { RepoConfig } from "../repo-context.js";
import { hasAuthorReplySinceLastAutomationComment } from "./repickup.js";
import { resolvePlanningConcurrencyCap } from "./settings.js";

/**
 * Planning pass (decisions #2/#18) — one project, one cron tick. Discovers `state:plan` tickets plus
 * `state:needs-input` tickets with a fresh author reply (decision #18's re-pickup), then dispatches
 * up to the resolved planning concurrency cap (decision #5), skipping any ticket that already has a
 * marker (already running, or escalated — decision #12's "skip any ticket with an escalated marker",
 * satisfied for free here since an escalated marker is still a marker).
 */
export interface PlanningPassContext extends DispatchContext {
  client: JiraClient;
  repoConfig: RepoConfig;
}

export interface PlanningPassResult {
  dispatched: string[];
}

function isReadyForRepickup(issue: JiraIssue): boolean {
  return hasAuthorReplySinceLastAutomationComment(issue);
}

export async function runPlanningPass(ctx: PlanningPassContext): Promise<PlanningPassResult> {
  const planQuery = buildDiscoveryJql({
    projectKeys: ctx.repoConfig.jiraProjectKeys,
    appTag: ctx.repoConfig.appTag,
    stateLabels: ["plan"],
  });
  const needsInputQuery = buildDiscoveryJql({
    projectKeys: ctx.repoConfig.jiraProjectKeys,
    appTag: ctx.repoConfig.appTag,
    stateLabels: ["needs-input"],
  });

  const [planIssues, needsInputIssues] = await Promise.all([
    searchIssues(ctx.client, planQuery),
    searchIssues(ctx.client, needsInputQuery),
  ]);

  const candidates = [...planIssues, ...needsInputIssues.filter(isReadyForRepickup)];
  const cap = resolvePlanningConcurrencyCap(ctx.settings, ctx.project.overrides);

  const dispatched: string[] = [];
  for (const issue of candidates) {
    if (!canDispatchPlanning(ctx.project.name, cap, ctx.stateRoot)) break;
    if (readMarker(ctx.project.name, issue.key, ctx.stateRoot)) continue;

    await dispatchWorker(ctx, issue, "planning", 1);
    dispatched.push(issue.key);
  }

  return { dispatched };
}
