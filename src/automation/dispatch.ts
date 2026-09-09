import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfluenceClient } from "@davindermahal/confluence-client";
import { launchClaude } from "../ai/claude.js";
import { launchGemini } from "../ai/gemini.js";
import type { LaunchOptions, LaunchResult } from "../ai/launch.js";
import type { GlobalConfig } from "../config.js";
import { resolveConfluenceAuthOrThrow } from "../confluence/auth.js";
import type { JiraIssue } from "../jira/tags.js";
import { buildWorkerConfluenceContext } from "./confluence-context.js";
import type { WorkerConfluenceContext } from "./result-file.js";
import { renderPrompt } from "./prompt-template.js";
import { type PromptName, promptTemplatePath } from "./prompts.js";
import type { ProjectEntry } from "./registry.js";
import {
  type WorkerContext,
  contextFilePath,
  logDirPath,
  progressLogPath,
  promptFilePath,
  resultFilePath,
  writeConfluenceContext,
  writeWorkerContext,
} from "./result-file.js";
import { resolveProvider } from "./provider-selection.js";
import { type AutomationSettings, resolvePermissionProfilePath } from "./settings.js";
import { worktreeCreate, type WorktreeResult } from "../worktree.js";

/**
 * Shared launch wiring for both the planning and implementation passes (decisions #2/#3) — resolve/
 * resume the worktree, write the worker's context file (decision #1), render and write the correct
 * headless prompt (decision #15), resolve the provider (decision #14) and its permission profile
 * (decision #9), then hand off to that provider's adapter (decision #14). Everything downstream of
 * "which ticket, which phase, how many attempts so far" lives here exactly once.
 */
export type LaunchFn = (provider: "claude" | "gemini", options: LaunchOptions) => LaunchResult;

export const defaultLaunch: LaunchFn = (provider, options) =>
  provider === "claude" ? launchClaude(options) : launchGemini(options);

export interface DispatchContext {
  project: ProjectEntry;
  /** Needed to pre-fetch Confluence context for a planning-phase launch (see below) — the same
   * config `ConfluenceClient` and `list_guides`/`fetch_confluence_pages` already use interactively. */
  config: GlobalConfig;
  settings: AutomationSettings;
  stateRoot?: string;
  /** Test seam (decision #21) — defaults to actually spawning `claude`/`gemini`. */
  launch?: LaunchFn;
  /** Test seam — defaults to a real `ConfluenceClient` built from `config`. */
  confluenceClient?: ConfluenceClient;
  /** `--dry-run` (decision #21) — logs what would launch instead of actually spawning a provider. */
  dryRun?: boolean;
}

export interface DispatchResult {
  worktree: WorktreeResult;
  launchResult: LaunchResult;
  provider: "claude" | "gemini";
}

export async function dispatchWorker(
  ctx: DispatchContext,
  issue: JiraIssue,
  phase: "planning" | "implementation",
  attempts: number,
  /** A restart's correction note (decision #17) — e.g. "your previous plan was missing a required
   * '## Implementation Order' section" — prepended to the rendered prompt so a retried worker sees
   * exactly what went wrong last time. Undefined for a first dispatch. */
  correctionNote?: string,
): Promise<DispatchResult> {
  const worktree = await worktreeCreate(issue.key, async () => issue.summary, ctx.project.path);

  const context: WorkerContext = {
    ticketKey: issue.key,
    phase,
    summary: issue.summary,
    description: issue.description,
    comments: issue.comments,
  };
  writeWorkerContext(ctx.project.name, context, ctx.stateRoot);

  // Pre-fetched here, not called as a tool by the worker (confluence-references-in-planning.md
  // Option B) — a headless worker has no MCP tool access at all, so this runs server-side, before
  // launch, in the orchestrator's own (credentialed) process. Planning-phase only: this feature's
  // scope is gathering context for a plan, not for implementation.
  const confluenceContextValues: Record<string, string> = {};
  if (phase === "planning") {
    // Constructing the client can now throw (incomplete Confluence auth — the shared package
    // validates at construction, unlike this repo's old client, which only failed lazily on first
    // request). Wrapped alongside the fetch itself so this degrades to an empty context rather than
    // ever blocking the ticket's dispatch, same principle as buildWorkerConfluenceContext's own
    // per-half resilience.
    let confluenceContext: WorkerConfluenceContext = { guideCatalog: [], referencedPages: [] };
    try {
      const confluenceClient = ctx.confluenceClient ?? new ConfluenceClient(resolveConfluenceAuthOrThrow(ctx.config));
      confluenceContext = await buildWorkerConfluenceContext(confluenceClient, ctx.config, issue);
    } catch {
      // Confluence auth incomplete or unreachable — leave confluenceContext at its empty default.
    }
    confluenceContextValues.CONFLUENCE_CONTEXT_FILE_PATH = writeConfluenceContext(
      ctx.project.name,
      issue.key,
      confluenceContext,
      ctx.stateRoot,
    );
  }

  const promptName: PromptName = phase === "planning" ? "headless-planning" : "headless-implementation";
  const template = readFileSync(promptTemplatePath(promptName), "utf8");
  const rendered = renderPrompt(template, {
    ...confluenceContextValues,
    TICKET_KEY: issue.key,
    CONTEXT_FILE_PATH: contextFilePath(ctx.project.name, issue.key, ctx.stateRoot),
    PROGRESS_LOG_PATH: progressLogPath(ctx.project.name, issue.key, ctx.stateRoot),
    RESULT_FILE_PATH: resultFilePath(ctx.project.name, issue.key, ctx.stateRoot),
  });
  const promptText = correctionNote
    ? `## Correction from your previous attempt\n\n${correctionNote}\n\n---\n\n${rendered}`
    : rendered;

  const promptPath = promptFilePath(ctx.project.name, issue.key, ctx.stateRoot);
  mkdirSync(dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, promptText, "utf8");

  const resolvedProvider = resolveProvider(issue.labels, phase, ctx.settings, ctx.project.overrides);
  const permissionProfilePath = resolvePermissionProfilePath(
    ctx.settings,
    ctx.project.overrides,
    resolvedProvider.provider,
  );

  if (ctx.dryRun) {
    console.log(
      `[dry-run] would launch ${resolvedProvider.provider} for ${issue.key} (${phase}, attempt ${attempts}) ` +
        `— prompt written to ${promptPath}`,
    );
    return {
      worktree,
      launchResult: { pid: -1, logPath: promptPath },
      provider: resolvedProvider.provider,
    };
  }

  const launchFn = ctx.launch ?? defaultLaunch;
  const launchResult = launchFn(resolvedProvider.provider, {
    projectName: ctx.project.name,
    ticketKey: issue.key,
    phase,
    promptPath,
    worktreePath: worktree.worktreePath,
    permissionProfilePath,
    model: resolvedProvider.model,
    logDir: logDirPath(ctx.project.name, ctx.stateRoot),
    attempts,
    stateRoot: ctx.stateRoot,
  });

  return { worktree, launchResult, provider: resolvedProvider.provider };
}
