import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Result-file protocol (decision #1, headless-automation plan) — how a headless worker (no MCP
 * tools, decision #1) hands information to and from the orchestrator: a context file the
 * orchestrator writes before launch (the ticket data `tracker_get_issue` would otherwise have
 * given an interactive session), and a result file the worker writes before exiting (what the
 * orchestrator reads instead of the worker ever calling `tracker_add_comment`/`tracker_transition`
 * itself). Ported conceptually from the harness's context-file/decision-file/`impl-result.json`
 * pattern, not the bash. All three files live under the state tree (decision #8), never inside the
 * target repo.
 */

const DEFAULT_STATE_ROOT = join(homedir(), ".config", "ai-intake-mcp", "state");

export interface WorkerContext {
  ticketKey: string;
  phase: "planning" | "implementation";
  summary: string;
  description: string;
  comments: { author: string; body: string; created: string }[];
}

/** The orchestrator decides `state:needs-input` vs. `state:review` itself, by reading the committed
 * plan file's `## Open Questions` section (decision #2) — this result only distinguishes a clean
 * run from a genuine, non-recoverable failure to produce a plan at all. */
export interface PlanningResult {
  outcome: "done" | "blocked";
  notes?: string;
}

export interface ImplementationResult {
  outcome: "success" | "blocked";
  summary?: string;
  verify?: string;
  whatHappened?: string;
}

export function contextFilePath(projectName: string, ticketKey: string, stateRoot: string = DEFAULT_STATE_ROOT): string {
  return join(stateRoot, projectName, "context", `${ticketKey}.json`);
}

export function resultFilePath(projectName: string, ticketKey: string, stateRoot: string = DEFAULT_STATE_ROOT): string {
  return join(stateRoot, projectName, "result", `${ticketKey}.json`);
}

export function progressLogPath(projectName: string, ticketKey: string, stateRoot: string = DEFAULT_STATE_ROOT): string {
  return join(stateRoot, projectName, "progress", `${ticketKey}.log`);
}

/** Where a provider adapter (`src/ai/launch.ts`) redirects a launched worker's stdout/stderr. */
export function logDirPath(projectName: string, stateRoot: string = DEFAULT_STATE_ROOT): string {
  return join(stateRoot, projectName, "logs");
}

/** Where the orchestrator writes a launch's fully-rendered prompt text (decision #15's templates,
 * after `renderPrompt` substitution) before handing the path to a provider adapter. */
export function promptFilePath(projectName: string, ticketKey: string, stateRoot: string = DEFAULT_STATE_ROOT): string {
  return join(stateRoot, projectName, "prompts", `${ticketKey}.md`);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function writeWorkerContext(projectName: string, context: WorkerContext, stateRoot?: string): string {
  const path = contextFilePath(projectName, context.ticketKey, stateRoot);
  writeJson(path, context);
  return path;
}

export function readWorkerContext(
  projectName: string,
  ticketKey: string,
  stateRoot?: string,
): WorkerContext | undefined {
  const path = contextFilePath(projectName, ticketKey, stateRoot);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as WorkerContext;
}

function readResult<T>(path: string, isValid: (value: unknown) => value is T): T | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isValid(parsed)) {
    throw new Error(`${path} is malformed — doesn't match the expected result shape.`);
  }
  return parsed;
}

function isPlanningResult(value: unknown): value is PlanningResult {
  if (typeof value !== "object" || value === null) return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "done" || outcome === "blocked";
}

function isImplementationResult(value: unknown): value is ImplementationResult {
  if (typeof value !== "object" || value === null) return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "success" || outcome === "blocked";
}

/** Undefined means "no result yet" — the worker is still running (or its marker's PID is dead and
 * the watchdog, decision #12, needs to decide restart vs. escalate). */
export function readPlanningResult(
  projectName: string,
  ticketKey: string,
  stateRoot?: string,
): PlanningResult | undefined {
  return readResult(resultFilePath(projectName, ticketKey, stateRoot), isPlanningResult);
}

export function readImplementationResult(
  projectName: string,
  ticketKey: string,
  stateRoot?: string,
): ImplementationResult | undefined {
  return readResult(resultFilePath(projectName, ticketKey, stateRoot), isImplementationResult);
}
