import { readFileSync } from "node:fs";
import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { fetchIssue } from "../jira/tags.js";
import {
  findPlanFile,
  getQAPlanSectionText,
  planHasBlockingOpenQuestions,
  planHasImplementationOrderSection,
  planHasQAPlanSection,
  planHasTestingStrategySection,
} from "../plan-file.js";
import { findWorktreeForTicket } from "../worktree.js";
import { type DispatchContext, dispatchWorker } from "./dispatch.js";
import { maybeAddComment, maybeDeleteMarker, maybeTransition, maybeWriteMarker } from "./dry-run.js";
import { AUTOMATION_COMMENT_FOOTER } from "./footer.js";
import { listMarkers, type WorkerMarker } from "./markers.js";
import { composeHeartbeat, readProgressSince } from "./progress-log.js";
import {
  progressLogPath,
  readImplementationResult,
  readPlanningResult,
} from "./result-file.js";
import { resolveWatchdogSettings } from "./settings.js";

/**
 * Watchdog pass (decision #12) — sweeps every marker file for a project regardless of `phase`, since
 * there's no Jira-label signal distinguishing "not yet started" from "stalled" either way. This is
 * also where a *cleanly finished* worker's result gets processed (decision #1/#2/#3): a worker runs
 * detached, so nothing else in the sequential per-project loop (decision #10) is checking back on it
 * mid-tick — the watchdog sweep is the only place that later notices a dead PID and a result file
 * together and turns that into the Jira comment/transition decision #2/#3 describe.
 */
export interface WatchdogPassContext extends DispatchContext {
  client: JiraClient;
  config: GlobalConfig;
  now?: () => Date;
}

export interface WatchdogPassResult {
  heartbeats: string[];
  completed: string[];
  restarted: string[];
  escalated: string[];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function escalate(
  ctx: WatchdogPassContext,
  marker: WorkerMarker,
  message: string,
  result: WatchdogPassResult,
): Promise<void> {
  await maybeAddComment(
    ctx,
    ctx.client,
    marker.ticketKey,
    `Escalating: ${message} Please check in on this ticket manually.`,
    AUTOMATION_COMMENT_FOOTER,
  );
  maybeWriteMarker(ctx, ctx.project.name, { ...marker, escalated: true }, ctx.stateRoot);
  result.escalated.push(marker.ticketKey);
}

/** Shared by a confirmed stall (dead PID, no result file, past grace) and decision #17's "plan
 * missing a required section" failure — both consume the same per-phase retry budget. */
async function retryOrEscalate(
  ctx: WatchdogPassContext,
  marker: WorkerMarker,
  result: WatchdogPassResult,
  correctionNote: string | undefined,
): Promise<void> {
  const watchdogSettings = resolveWatchdogSettings(ctx.settings, ctx.project.overrides, marker.phase);
  if (marker.attempts >= watchdogSettings.maxAttempts) {
    await escalate(
      ctx,
      marker,
      `${marker.phase} worker did not complete after ${marker.attempts} attempt(s).`,
      result,
    );
    return;
  }

  const worktree = findWorktreeForTicket(marker.ticketKey, ctx.project.path);
  if (!worktree) {
    await escalate(ctx, marker, `Cannot restart — no worktree found for ${marker.ticketKey}.`, result);
    return;
  }

  const issue = await fetchIssue(ctx.client, marker.ticketKey);
  await dispatchWorker(ctx, issue, marker.phase, marker.attempts + 1, correctionNote);
  result.restarted.push(marker.ticketKey);
}

async function maybePostHeartbeat(
  ctx: WatchdogPassContext,
  marker: WorkerMarker,
  now: Date,
  result: WatchdogPassResult,
): Promise<void> {
  const watchdogSettings = resolveWatchdogSettings(ctx.settings, ctx.project.overrides, marker.phase);
  const sinceLastHeartbeatMs = now.getTime() - new Date(marker.lastHeartbeatAt).getTime();
  if (sinceLastHeartbeatMs < watchdogSettings.heartbeatSeconds * 1000) return;

  const logPath = progressLogPath(ctx.project.name, marker.ticketKey, ctx.stateRoot);
  const { entries, readPosition } = readProgressSince(logPath, marker.progressReadPosition);
  const lastKnownNext =
    entries.length > 0 ? undefined : readProgressSince(logPath, 0).entries.at(-1)?.next;

  const body = composeHeartbeat({ entries, lastKnownNext });
  await maybeAddComment(ctx, ctx.client, marker.ticketKey, body, AUTOMATION_COMMENT_FOOTER);

  maybeWriteMarker(
    ctx,
    ctx.project.name,
    { ...marker, lastHeartbeatAt: now.toISOString(), progressReadPosition: readPosition },
    ctx.stateRoot,
  );
  result.heartbeats.push(marker.ticketKey);
}

async function finishPlanningWorker(
  ctx: WatchdogPassContext,
  marker: WorkerMarker,
  result: WatchdogPassResult,
): Promise<void> {
  const worktree = findWorktreeForTicket(marker.ticketKey, ctx.project.path);
  if (!worktree) {
    await escalate(ctx, marker, `Planning worker reported done, but no worktree was found.`, result);
    return;
  }
  const planPath = findPlanFile(worktree.worktreePath, marker.ticketKey);
  if (!planPath) {
    await escalate(ctx, marker, `Planning worker reported done, but no committed plan file was found.`, result);
    return;
  }

  if (
    !planHasImplementationOrderSection(planPath) ||
    !planHasTestingStrategySection(planPath) ||
    !planHasQAPlanSection(planPath)
  ) {
    await retryOrEscalate(
      ctx,
      marker,
      result,
      'Your previous plan was missing a required "## Implementation order", "## Testing strategy", ' +
        'or "## QA Plan" section (or left one empty) — add all three, fully populated, this time.',
    );
    return;
  }

  const planText = readFileSync(planPath, "utf8");
  const hasOpenQuestions = planHasBlockingOpenQuestions(planPath);
  const target = hasOpenQuestions ? "needs-input" : "review";
  const heading = hasOpenQuestions
    ? `Drafted/refined the plan at \`${planPath}\`. I need answers before finalizing — see the ` +
      `"## Open Questions" section below.`
    : `Plan ready for review at \`${planPath}\`.`;

  const issue = await fetchIssue(ctx.client, marker.ticketKey);
  await maybeAddComment(ctx, ctx.client, marker.ticketKey, `${heading}\n\n${planText}`, AUTOMATION_COMMENT_FOOTER);
  await maybeTransition(ctx, ctx.client, issue, target, ctx.config);

  maybeDeleteMarker(ctx, ctx.project.name, marker.ticketKey, ctx.stateRoot);
  result.completed.push(marker.ticketKey);
}

async function finishImplementationWorker(
  ctx: WatchdogPassContext,
  marker: WorkerMarker,
  outcome: "success" | "blocked",
  summary: string | undefined,
  verify: string | undefined,
  whatHappened: string | undefined,
  result: WatchdogPassResult,
): Promise<void> {
  const issue = await fetchIssue(ctx.client, marker.ticketKey);

  if (outcome === "success") {
    // Passing tests proves the code's logic; it doesn't discharge the plan's own ## QA Plan — name
    // it here (decision #1: the orchestrator composes every comment, never the worker) so it's not
    // silently forgotten once the ticket moves to state:verify.
    const worktree = findWorktreeForTicket(marker.ticketKey, ctx.project.path);
    const planPath = worktree && findPlanFile(worktree.worktreePath, marker.ticketKey);
    const qaPlanText = planPath ? getQAPlanSectionText(planPath) : undefined;

    const body =
      `Implementation complete (local — not pushed).\n\n` +
      (summary ? `What changed: ${summary}\n` : "") +
      (verify ? `Verify: ${verify}\n` : "") +
      `\nReady for your review: check out the branch, review the diff, and merge when satisfied.` +
      (qaPlanText ? `\n\nManual QA still needed:\n${qaPlanText}` : "");
    await maybeAddComment(ctx, ctx.client, marker.ticketKey, body, AUTOMATION_COMMENT_FOOTER);
    await maybeTransition(ctx, ctx.client, issue, "verify", ctx.config);
  } else {
    const body =
      `Implementation blocked.\n\n` +
      (whatHappened ? `What happened: ${whatHappened}\n` : "") +
      (summary ? `What's done so far: ${summary}\n` : "");
    await maybeAddComment(ctx, ctx.client, marker.ticketKey, body, AUTOMATION_COMMENT_FOOTER);
    await maybeTransition(ctx, ctx.client, issue, "problem", ctx.config);
  }

  maybeDeleteMarker(ctx, ctx.project.name, marker.ticketKey, ctx.stateRoot);
  result.completed.push(marker.ticketKey);
}

async function handleDeadWorker(
  ctx: WatchdogPassContext,
  marker: WorkerMarker,
  now: Date,
  result: WatchdogPassResult,
): Promise<void> {
  if (marker.phase === "planning") {
    const planningResult = readPlanningResult(ctx.project.name, marker.ticketKey, ctx.stateRoot);
    if (planningResult?.outcome === "done") {
      await finishPlanningWorker(ctx, marker, result);
      return;
    }
    if (planningResult?.outcome === "blocked") {
      await escalate(
        ctx,
        marker,
        `Planning worker reported a blocker: ${planningResult.notes ?? "no details given"}.`,
        result,
      );
      return;
    }
  } else {
    const implResult = readImplementationResult(ctx.project.name, marker.ticketKey, ctx.stateRoot);
    if (implResult?.outcome === "success" || implResult?.outcome === "blocked") {
      await finishImplementationWorker(
        ctx,
        marker,
        implResult.outcome,
        implResult.summary,
        implResult.verify,
        implResult.whatHappened,
        result,
      );
      return;
    }
  }

  // No result file at all — a silently-crashed/stalled worker (decision #12). Grace period is
  // measured from the marker's last known-alive signal (`lastHeartbeatAt`, seeded to launch time);
  // a PID that's still alive never reaches this branch regardless of how long it's been running.
  const watchdogSettings = resolveWatchdogSettings(ctx.settings, ctx.project.overrides, marker.phase);
  const sinceLastAliveMs = now.getTime() - new Date(marker.lastHeartbeatAt).getTime();
  if (sinceLastAliveMs < watchdogSettings.graceSeconds * 1000) return;

  await retryOrEscalate(ctx, marker, result, undefined);
}

export async function runWatchdogPass(ctx: WatchdogPassContext): Promise<WatchdogPassResult> {
  const now = (ctx.now ?? (() => new Date()))();
  const result: WatchdogPassResult = { heartbeats: [], completed: [], restarted: [], escalated: [] };

  for (const marker of listMarkers(ctx.project.name, ctx.stateRoot)) {
    if (marker.escalated) continue;

    if (isPidAlive(marker.pid)) {
      await maybePostHeartbeat(ctx, marker, now, result);
    } else {
      await handleDeadWorker(ctx, marker, now, result);
    }
  }

  return result;
}
