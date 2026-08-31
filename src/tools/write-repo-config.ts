import { readRepoConfig, resolveRepoRoot, writeRepoConfig } from "../repo-context.js";

/** Creates/overwrites .ai/intake-mcp.json at the resolved repo root (decision #4). Preserves an
 * existing `skipTargets` on overwrite — this tool only ever sets jiraProjectKey/appTag, so a blind
 * overwrite would otherwise silently drop skip declarations a developer/agent had hand-added. */
export function writeRepoConfigTool(
  jiraProjectKey: string,
  appTag: string,
  cwd?: string,
): { path: string } {
  const repoRoot = resolveRepoRoot(cwd);
  const existing = readRepoConfig(repoRoot);
  const path = writeRepoConfig(repoRoot, { jiraProjectKey, appTag, skipTargets: existing?.skipTargets });
  return { path };
}
