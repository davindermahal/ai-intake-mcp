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
  jiraProjectKey: string;
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

/** Per-repo config file (decision #4): committed, auto-bootstrapped, no separate setup command. */
export function readRepoConfig(repoRoot: string): RepoConfig | undefined {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return undefined;

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const jiraProjectKey =
    typeof parsed === "object" && parsed !== null && "jiraProjectKey" in parsed
      ? (parsed as { jiraProjectKey: unknown }).jiraProjectKey
      : undefined;
  const appTag =
    typeof parsed === "object" && parsed !== null && "appTag" in parsed
      ? (parsed as { appTag: unknown }).appTag
      : undefined;
  if (typeof jiraProjectKey !== "string" || typeof appTag !== "string") {
    throw new Error(`${path} is malformed — expected { "jiraProjectKey": string, "appTag": string }.`);
  }
  const rawSkipTargets =
    typeof parsed === "object" && parsed !== null && "skipTargets" in parsed
      ? (parsed as { skipTargets: unknown }).skipTargets
      : undefined;
  if (rawSkipTargets !== undefined) {
    if (!Array.isArray(rawSkipTargets) || !rawSkipTargets.every((t) => typeof t === "string")) {
      throw new Error(`${path} is malformed — "skipTargets" must be an array of strings.`);
    }
    return { jiraProjectKey, appTag, skipTargets: rawSkipTargets };
  }
  return { jiraProjectKey, appTag };
}

export function writeRepoConfig(repoRoot: string, config: RepoConfig): string {
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}
