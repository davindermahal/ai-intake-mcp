import { existsSync, readFileSync } from "node:fs";

/**
 * Progress log reader + heartbeat composer (decision #16, headless-automation plan) — how a
 * provider-agnostic heartbeat gets real content for either phase. Both headless prompts instruct the
 * worker to append a two-line `Done:`/`Next:` entry to a well-known log path after each meaningful
 * step; the orchestrator's watchdog reads whatever's new since the marker's `progressReadPosition`
 * (a line count, not a timestamp) and turns it into a heartbeat comment.
 */
export interface ProgressEntry {
  done: string;
  next: string;
}

export interface ProgressReadResult {
  entries: ProgressEntry[];
  /** New value to store as the marker's `progressReadPosition` (decision #8). A count of fully
   * consumed lines — a dangling `Done:` with no `Next:` line yet is left unconsumed so it's picked
   * up whole once its `Next:` lands. */
  readPosition: number;
}

const DONE_PREFIX = "Done: ";
const NEXT_PREFIX = "Next: ";

/** Reads every complete `Done:`/`Next:` pair appended to `logPath` since line `position`. A missing
 * log file (the worker hasn't written anything yet) is not an error — just nothing new. */
export function readProgressSince(logPath: string, position: number): ProgressReadResult {
  if (!existsSync(logPath)) return { entries: [], readPosition: position };

  const raw = readFileSync(logPath, "utf8").split("\n");
  const lines = raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;

  const entries: ProgressEntry[] = [];
  let readPosition = position;
  let i = position;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith(DONE_PREFIX)) {
      i += 1;
      readPosition = i;
      continue;
    }
    const nextLine = lines[i + 1];
    if (nextLine === undefined || !nextLine.startsWith(NEXT_PREFIX)) {
      // Dangling "Done:" with no matching "Next:" yet — stop before it, don't advance past it.
      break;
    }
    entries.push({ done: line.slice(DONE_PREFIX.length), next: nextLine.slice(NEXT_PREFIX.length) });
    i += 2;
    readPosition = i;
  }
  return { entries, readPosition };
}

export interface HeartbeatInput {
  entries: ProgressEntry[];
  /** The most recent `Next:` line known before this read (from the previous heartbeat) — used for
   * the fallback when nothing new was appended (decision #16). */
  lastKnownNext: string | undefined;
}

/** Composes a heartbeat comment body: every `Done:` line since the last heartbeat, bulleted, plus
 * the most recent `Next:` line. Falls back to restating the last known `Next:` line (or a bare
 * "still working" note) when nothing new landed, rather than posting an empty-feeling comment. */
export function composeHeartbeat(input: HeartbeatInput): string {
  if (input.entries.length === 0) {
    return input.lastKnownNext ? `Still working. Next: ${input.lastKnownNext}` : "Still working.";
  }
  const doneLines = input.entries.map((e) => `- ${e.done}`).join("\n");
  const lastEntry = input.entries[input.entries.length - 1] as ProgressEntry;
  return `Still working. Progress since the last update:\n${doneLines}\n\nNext: ${lastEntry.next}`;
}
