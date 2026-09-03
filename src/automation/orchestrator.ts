import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { readRepoConfig } from "../repo-context.js";
import type { LaunchFn } from "./dispatch.js";
import { type ImplementationPassResult, runImplementationPass } from "./implementation-pass.js";
import { type PlanningPassResult, runPlanningPass } from "./planning-pass.js";
import type { ProjectEntry } from "./registry.js";
import type { AutomationSettings } from "./settings.js";
import { type WatchdogPassResult, runWatchdogPass } from "./watchdog-pass.js";

/**
 * One project, one cron tick, three sub-passes back-to-back (decision #10) — not two separate
 * whole-registry loops. A disabled project (`enabled: false`, decision #7) skips new dispatch
 * (planning + implementation) but the watchdog still sweeps it, so an already-in-flight worker is
 * still heartbeat-monitored, completed, restarted, or escalated rather than silently abandoned
 * (Review Finding #8).
 */
export interface OrchestratorContext {
  client: JiraClient;
  config: GlobalConfig;
  project: ProjectEntry;
  settings: AutomationSettings;
  stateRoot?: string;
  launch?: LaunchFn;
  now?: () => Date;
}

export interface ProjectPassesResult {
  planning: PlanningPassResult;
  implementation: ImplementationPassResult;
  watchdog: WatchdogPassResult;
}

export async function runProjectPasses(ctx: OrchestratorContext): Promise<ProjectPassesResult> {
  const repoConfig = readRepoConfig(ctx.project.path);
  if (!repoConfig) {
    throw new Error(
      `${ctx.project.path} has no .ai/intake-mcp.json — cannot run automation for "${ctx.project.name}".`,
    );
  }

  let planning: PlanningPassResult = { dispatched: [] };
  let implementation: ImplementationPassResult = { dispatched: undefined, bounced: [] };

  if (ctx.project.enabled) {
    planning = await runPlanningPass({ ...ctx, repoConfig });
    implementation = await runImplementationPass({ ...ctx, repoConfig });
  }

  const watchdog = await runWatchdogPass(ctx);

  return { planning, implementation, watchdog };
}
