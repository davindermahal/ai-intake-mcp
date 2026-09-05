import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** cwd = project context (decision #1): a local stdio server inherits the calling agent's cwd. */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    throw new Error(`Not inside a git repository (cwd: ${cwd}).`);
  }
}

export interface RepoConfig {
  jiraProjectKeys: string[];
  appTag: string;
  /** Which of the fixed `install`/`build`/`test`/`lint` targets this project's Makefile genuinely
   * doesn't define — an explicit declaration, not a silent inference (hardening-phase plan, decision
   * #3). Optional; a project with no such gaps just omits it. Not written by `write_repo_config` —
   * an agent/developer edits this file directly, the same way `.ai/intake-mcp.md` is hand-maintained. */
  skipTargets?: string[];
}

function configPath(repoRoot: string): string {
  return join(repoRoot, ".ai", "intake-mcp.json");
}

/**
 * Per-repo config file (decision #4): committed, auto-bootstrapped, no separate setup command.
 * `jiraProjectKeys` (decision #6, headless-automation plan) is the current field — a list, so one
 * repo can be scoped to several Jira project keys. The legacy singular `jiraProjectKey` string is
 * still accepted and normalized to a one-element list, so already-committed `.ai/intake-mcp.json`
 * files from before this migration keep working without edits.
 */
const RepoConfigFileSchema = z.object({
  jiraProjectKeys: z.array(z.string()).min(1).optional(),
  jiraProjectKey: z.string().optional(),
  appTag: z.string(),
  skipTargets: z.array(z.string()).optional(),
});

export function readRepoConfig(repoRoot: string): RepoConfig | undefined {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  const result = RepoConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${path} is malformed — expected { "jiraProjectKeys": string[], "appTag": string } (or the ` +
        `legacy { "jiraProjectKey": string, "appTag": string }): ${result.error.message}`,
    );
  }

  const { jiraProjectKeys, jiraProjectKey, appTag, skipTargets } = result.data;
  if (!jiraProjectKeys && !jiraProjectKey) {
    throw new Error(`${path} is malformed — missing both "jiraProjectKeys" and "jiraProjectKey".`);
  }

  return { jiraProjectKeys: jiraProjectKeys ?? [jiraProjectKey as string], appTag, skipTargets };
}

export function writeRepoConfig(repoRoot: string, config: RepoConfig): string {
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}
