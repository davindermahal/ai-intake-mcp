import { resolveRepoRoot, writeRepoConfig } from "../repo-context.js";

/** Creates/overwrites .ai/intake-mcp.json at the resolved repo root (decision #4). */
export function writeRepoConfigTool(
  jiraProjectKey: string,
  appTag: string,
  cwd?: string,
): { path: string } {
  const repoRoot = resolveRepoRoot(cwd);
  const path = writeRepoConfig(repoRoot, { jiraProjectKey, appTag });
  return { path };
}
