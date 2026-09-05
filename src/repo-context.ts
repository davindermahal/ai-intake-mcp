import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
export function readRepoConfig(repoRoot: string): RepoConfig | undefined {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return undefined;

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const malformed = (detail: string): Error =>
    new Error(
      `${path} is malformed — ${detail}. Expected { "jiraProjectKeys": string[], "appTag": string } ` +
        `(or the legacy { "jiraProjectKey": string, "appTag": string }).`,
    );

  let jiraProjectKeys: string[];
  if ("jiraProjectKeys" in obj) {
    const raw = obj.jiraProjectKeys;
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((k) => typeof k === "string")) {
      throw malformed('"jiraProjectKeys" must be a non-empty array of strings');
    }
    jiraProjectKeys = raw as string[];
  } else if ("jiraProjectKey" in obj) {
    if (typeof obj.jiraProjectKey !== "string") {
      throw malformed('"jiraProjectKey" must be a string');
    }
    jiraProjectKeys = [obj.jiraProjectKey];
  } else {
    throw malformed('missing both "jiraProjectKeys" and "jiraProjectKey"');
  }

  if (typeof obj.appTag !== "string") {
    throw malformed('"appTag" must be a string');
  }
  const appTag = obj.appTag;

  if (obj.skipTargets !== undefined) {
    const rawSkipTargets = obj.skipTargets;
    if (!Array.isArray(rawSkipTargets) || !rawSkipTargets.every((t) => typeof t === "string")) {
      throw malformed('"skipTargets" must be an array of strings');
    }
    return { jiraProjectKeys, appTag, skipTargets: rawSkipTargets as string[] };
  }
  return { jiraProjectKeys, appTag };
}

export function writeRepoConfig(repoRoot: string, config: RepoConfig): string {
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}
