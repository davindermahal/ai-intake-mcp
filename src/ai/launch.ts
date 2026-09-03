import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type WorkerMarker, writeMarker } from "../automation/markers.js";

/**
 * Provider adapter contract (decision #14, headless-automation plan) — every place that spawns a
 * headless worker does so through this seam, ported conceptually from the harness's `lib/ai/<name>.sh`
 * into TS. `launchProvider` holds the mechanics every provider shares (open the log file, spawn
 * detached, write the running-slot marker); each provider file only supplies its own
 * command/args via `buildCommand`.
 */
export interface LaunchOptions {
  projectName: string;
  ticketKey: string;
  phase: "planning" | "implementation";
  /** Path to the headless prompt file (decision #15) — its content is read and passed to the CLI. */
  promptPath: string;
  worktreePath: string;
  /** Resolved via `src/automation/settings.ts`'s `resolvePermissionProfilePath` (decision #9). Not
   * every provider turns this into a CLI flag — Gemini's policy engine is applied globally,
   * out-of-band (see `src/ai/gemini-policy.ts`) — but every adapter receives it for uniformity/audit. */
  permissionProfilePath: string;
  model?: string;
  logDir: string;
  /** How many times this ticket/phase has been launched so far, including this one — the caller
   * (orchestrator/watchdog, decision #12) owns the retry count; the adapter just records it. */
  attempts: number;
  /** Test-only override for the marker state root (see `src/automation/markers.ts`). */
  stateRoot?: string;
}

export interface LaunchResult {
  pid: number;
  logPath: string;
}

export interface ProviderCommand {
  command: string;
  args: string[];
}

export function launchProvider(
  options: LaunchOptions,
  buildCommand: (promptContent: string, options: LaunchOptions) => ProviderCommand,
): LaunchResult {
  const promptContent = readFileSync(options.promptPath, "utf8");
  const { command, args } = buildCommand(promptContent, options);

  mkdirSync(options.logDir, { recursive: true });
  const logPath = join(options.logDir, `${options.ticketKey}.log`);
  const logFd = openSync(logPath, "a");

  let pid: number | undefined;
  try {
    const child = spawn(command, args, {
      cwd: options.worktreePath,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (pid === undefined) {
    throw new Error(`Failed to launch "${command}" for ${options.ticketKey} — no pid returned.`);
  }

  const now = new Date().toISOString();
  const marker: WorkerMarker = {
    ticketKey: options.ticketKey,
    phase: options.phase,
    pid,
    launchedAt: now,
    lastHeartbeatAt: now,
    progressReadPosition: 0,
    attempts: options.attempts,
    escalated: false,
  };
  writeMarker(options.projectName, marker, options.stateRoot);

  return { pid, logPath };
}
