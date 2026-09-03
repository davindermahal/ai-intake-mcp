import { basename } from "node:path";
import type { JiraClient } from "../jira/client.js";
import { searchIssues } from "../jira/search.js";
import { STATE_LABEL } from "../jira/tags.js";
import { readRepoConfig, type RepoConfig } from "../repo-context.js";
import { saveProjectRegistry, upsertProject, type ProjectEntry, type ProjectRegistry } from "./registry.js";

/**
 * App-tag collision check (decision #20) — resolves Review Finding #4 and decision #7's "still
 * open" registration-validation question. Before a new `projects.json` entry is written, query Jira
 * for any ticket already carrying `labels = "app:<appTag>"` and classify what's found. A real check,
 * not just a documented warning — the double-dispatch risk this guards against is a separate
 * `ai-intake-harness` install (or a misconfigured second registry entry) already claiming that tag.
 */
export type CollisionCheckResult =
  | { outcome: "fresh" }
  | { outcome: "existing-registration" }
  | { outcome: "collision"; reason: string }
  | { outcome: "query-failed"; error: string };

const KNOWN_STATE_LABELS = new Set<string>(Object.values(STATE_LABEL));

export async function checkAppTagCollision(
  client: JiraClient,
  appTag: string,
  repoPath: string,
  registry: ProjectRegistry,
): Promise<CollisionCheckResult> {
  let issues;
  try {
    issues = await searchIssues(client, `labels = "${appTag}"`);
  } catch (err) {
    // Jira query itself couldn't run — fail closed rather than silently skip the safety check.
    return { outcome: "query-failed", error: (err as Error).message };
  }

  if (issues.length === 0) return { outcome: "fresh" };

  const foreignVocabulary = issues.some((issue) => {
    const stateLabel = issue.labels.find((l) => l.startsWith("state:"));
    return stateLabel !== undefined && !KNOWN_STATE_LABELS.has(stateLabel);
  });
  if (foreignVocabulary) {
    return {
      outcome: "collision",
      reason:
        `Found ticket(s) tagged "${appTag}" carrying a state label outside ai-intake-mcp's own ` +
        `vocabulary — a strong signal a different tool (e.g. ai-intake-harness) already claims this tag.`,
    };
  }

  const existingProjectWithTag = registry.projects.find((p) => readRepoConfig(p.path)?.appTag === appTag);

  if (!existingProjectWithTag) {
    return {
      outcome: "collision",
      reason:
        `Found ticket(s) tagged "${appTag}" using ai-intake-mcp's own state vocabulary, but no ` +
        `project in this machine's registry claims that tag — refusing rather than guessing why.`,
    };
  }
  if (existingProjectWithTag.path !== repoPath) {
    return {
      outcome: "collision",
      reason:
        `"${appTag}" is already claimed by a different registered project at ` +
        `"${existingProjectWithTag.path}".`,
    };
  }

  return { outcome: "existing-registration" };
}

export interface ReachabilityResult {
  reachable: boolean;
  error?: string;
}

/** Registration wizard's final sanity check (decision #20, step 6) — a live query, not just config
 * validation, confirming the Jira project key(s) are actually reachable with these credentials. */
export async function verifyProjectKeysReachable(
  client: JiraClient,
  projectKeys: string[],
): Promise<ReachabilityResult> {
  try {
    await searchIssues(client, `project in (${projectKeys.map((k) => `"${k}"`).join(", ")})`);
    return { reachable: true };
  } catch (err) {
    return { reachable: false, error: (err as Error).message };
  }
}

export interface RegisterResolvedInput {
  repoRoot: string;
  repoConfig: RepoConfig;
  /** Defaults to `basename(repoRoot)`, matching the wizard's own prompt default. */
  displayName?: string;
  /** Defaults to true, matching the wizard's own prompt default. */
  enable?: boolean;
}

export type RegisterResolvedResult =
  | { status: "refused"; collision: Extract<CollisionCheckResult, { outcome: "collision" | "query-failed" }> }
  | {
      status: "registered";
      collision: Extract<CollisionCheckResult, { outcome: "fresh" | "existing-registration" }>;
      entry: ProjectEntry;
      reachability: ReachabilityResult;
    };

/**
 * The registration wizard's steps 3-6 (collision check, registry write, reachability check) with
 * every human decision already resolved to a concrete value — no readline involved. Extracted so
 * `scripts/register-project.ts`'s interactive prompts and non-interactive `--flag` mode share one
 * code path, and so tests (including the opt-in real-Jira e2e suite, `test/e2e/`) can drive the
 * exact same logic the CLI runs without spawning a subprocess or feeding a readline prompt.
 */
export async function registerResolvedProject(
  client: JiraClient,
  registry: ProjectRegistry,
  input: RegisterResolvedInput,
): Promise<RegisterResolvedResult> {
  const collision = await checkAppTagCollision(client, input.repoConfig.appTag, input.repoRoot, registry);
  if (collision.outcome === "collision" || collision.outcome === "query-failed") {
    return { status: "refused", collision };
  }

  const entry: ProjectEntry = {
    path: input.repoRoot,
    name: input.displayName ?? basename(input.repoRoot),
    enabled: input.enable ?? true,
    overrides: undefined,
  };
  saveProjectRegistry(upsertProject(registry, entry));

  const reachability = await verifyProjectKeysReachable(client, input.repoConfig.jiraProjectKeys);
  return { status: "registered", collision, entry, reachability };
}
