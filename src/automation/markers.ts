import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-ticket running-slot marker (decision #8, headless-automation plan) — one file for as long as
 * a headless worker is dispatched on that ticket, deleted on clean completion. This is the only
 * source of truth for "something is currently running on this ticket": there's no Jira-label signal
 * that distinguishes "not yet started" from "actively being planned" (tickets sit in `state:plan`
 * either way), so the watchdog (decision #12) and both concurrency checks below key off this file,
 * not the tracker.
 */
export interface WorkerMarker {
  ticketKey: string;
  phase: "planning" | "implementation";
  pid: number;
  launchedAt: string;
  lastHeartbeatAt: string;
  progressReadPosition: number;
  attempts: number;
  /** Set once the watchdog's retry budget is exhausted (decision #12) — the marker is kept, not
   * deleted, as the audit record, but an escalated marker no longer occupies a concurrency slot
   * (it isn't actively running or waiting to be retried) and the planning-pass dispatch query must
   * skip it (decision #12's "escalation marks the ticket" note). */
  escalated: boolean;
}

/** Implementation's cap is fixed at exactly 1 in-flight ticket per project — a structural
 * consequence of the shared dev container/DB (decision #4), never a config value. */
export const IMPLEMENTATION_CONCURRENCY_CAP = 1;

const DEFAULT_STATE_ROOT = join(homedir(), ".config", "ai-intake-mcp", "state");

function workersDir(projectName: string, stateRoot: string = DEFAULT_STATE_ROOT): string {
  return join(stateRoot, projectName, "workers");
}

function markerPath(projectName: string, ticketKey: string, stateRoot?: string): string {
  return join(workersDir(projectName, stateRoot), `${ticketKey}.json`);
}

export function readMarker(
  projectName: string,
  ticketKey: string,
  stateRoot?: string,
): WorkerMarker | undefined {
  const path = markerPath(projectName, ticketKey, stateRoot);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as WorkerMarker;
}

export function writeMarker(projectName: string, marker: WorkerMarker, stateRoot?: string): void {
  const dir = workersDir(projectName, stateRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${marker.ticketKey}.json`), JSON.stringify(marker, null, 2), "utf8");
}

/** Deletes a ticket's marker (clean completion). Idempotent — deleting an already-gone marker is
 * not an error, since two passes racing to clean up the same ticket is a normal, harmless outcome. */
export function deleteMarker(projectName: string, ticketKey: string, stateRoot?: string): void {
  const path = markerPath(projectName, ticketKey, stateRoot);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Every marker currently on file for a project. Empty (not an error) when the project has never
 * had a worker dispatched yet — same "nothing yet" convention as a missing config file. */
export function listMarkers(projectName: string, stateRoot?: string): WorkerMarker[] {
  const dir = workersDir(projectName, stateRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as WorkerMarker);
}

export function countMarkersByPhase(
  projectName: string,
  phase: WorkerMarker["phase"],
  stateRoot?: string,
): number {
  return listMarkers(projectName, stateRoot).filter((m) => m.phase === phase).length;
}

/** Markers that currently occupy a concurrency slot — everything except an escalated one, which is
 * kept only as an audit record and is no longer in flight or awaiting retry. */
function countActiveMarkersByPhase(
  projectName: string,
  phase: WorkerMarker["phase"],
  stateRoot?: string,
): number {
  return listMarkers(projectName, stateRoot).filter((m) => m.phase === phase && !m.escalated).length;
}

/** `cap` is the already-resolved planning concurrency cap for this project (global default plus any
 * per-project override — see `src/automation/settings.ts`'s `resolvePlanningConcurrencyCap`). */
export function canDispatchPlanning(projectName: string, cap: number, stateRoot?: string): boolean {
  return countActiveMarkersByPhase(projectName, "planning", stateRoot) < cap;
}

export function canDispatchImplementation(projectName: string, stateRoot?: string): boolean {
  return countActiveMarkersByPhase(projectName, "implementation", stateRoot) < IMPLEMENTATION_CONCURRENCY_CAP;
}
