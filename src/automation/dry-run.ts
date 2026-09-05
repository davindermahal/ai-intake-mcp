import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { type ShortState, addComment, transitionState } from "../jira/tags.js";
import type { JiraIssue } from "../jira/tags.js";
import { setPlanStatus } from "../plan-file.js";
import { deleteMarker, writeMarker, type WorkerMarker } from "./markers.js";

/**
 * `--dry-run` (decision #21) — the real cron entrypoint, run against a real board with real
 * registered projects, but logging every action (dispatch, comment, transition) instead of taking
 * it. Every place a pass would write to Jira or flip a plan file's `Status` goes through one of
 * these wrappers instead of calling the underlying function directly, so dry-run coverage can never
 * silently regress as new write sites are added elsewhere.
 */
export interface DryRunAware {
  dryRun?: boolean;
}

export async function maybeAddComment(
  ctx: DryRunAware,
  client: JiraClient,
  key: string,
  text: string,
  footer: string,
): Promise<void> {
  if (ctx.dryRun) {
    console.log(`[dry-run] would comment on ${key}:\n${text}\n`);
    return;
  }
  await addComment(client, key, text, footer);
}

export async function maybeTransition(
  ctx: DryRunAware,
  client: JiraClient,
  issue: JiraIssue,
  target: ShortState,
  config: GlobalConfig,
): Promise<void> {
  if (ctx.dryRun) {
    console.log(`[dry-run] would transition ${issue.key} -> state:${target}`);
    return;
  }
  await transitionState(client, issue, target, config);
}

export function maybeSetPlanStatus(ctx: DryRunAware, planPath: string, newStatus: string): void {
  if (ctx.dryRun) {
    console.log(`[dry-run] would set ${planPath}'s Status -> ${newStatus}`);
    return;
  }
  setPlanStatus(planPath, newStatus);
}

/** A dry-run must never mutate marker state either — a real future (non-dry-run) tick reads that
 * same state (concurrency caps, escalation, heartbeat position), so a dry-run "escalating" or
 * "completing" a ticket for real would corrupt it. */
export function maybeWriteMarker(
  ctx: DryRunAware,
  projectName: string,
  marker: WorkerMarker,
  stateRoot?: string,
): void {
  if (ctx.dryRun) {
    console.log(`[dry-run] would update the marker for ${marker.ticketKey} (${JSON.stringify(marker)})`);
    return;
  }
  writeMarker(projectName, marker, stateRoot);
}

export function maybeDeleteMarker(
  ctx: DryRunAware,
  projectName: string,
  ticketKey: string,
  stateRoot?: string,
): void {
  if (ctx.dryRun) {
    console.log(`[dry-run] would delete the marker for ${ticketKey}`);
    return;
  }
  deleteMarker(projectName, ticketKey, stateRoot);
}
