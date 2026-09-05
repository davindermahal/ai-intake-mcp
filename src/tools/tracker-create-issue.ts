import type { GlobalConfig } from "../config.js";
import type { JiraClient } from "../jira/client.js";
import { bootstrapIfNeeded, createIssue, fetchIssue } from "../jira/tags.js";
import { readRepoConfig, resolveRepoRoot } from "../repo-context.js";

export interface TrackerCreateIssueResult {
  key: string;
  url: string;
}

/**
 * Creates a ticket in this repo's configured project, then bootstraps it the same way an existing
 * untouched ticket gets bootstrapped on first tracker_get_issue (state:plan + this repo's app tag)
 * — without this a freshly created ticket would sit unlabeled and invisible to the rest of the
 * harness's state-based flow until someone happened to touch it.
 *
 * A repo can be scoped to several `jiraProjectKeys` (headless-automation plan); new tickets are
 * created in the first one, matching the pre-list behavior of the single `jiraProjectKey` field it
 * replaced.
 */
export async function trackerCreateIssue(
  client: JiraClient,
  config: GlobalConfig,
  summary: string,
  description: string | undefined,
  issueType: string | undefined,
  cwd?: string,
): Promise<TrackerCreateIssueResult> {
  const repoRoot = resolveRepoRoot(cwd);
  const repoConfig = readRepoConfig(repoRoot);
  if (!repoConfig) {
    throw new Error(
      "This repo isn't configured yet — no .ai/intake-mcp.json found. Ask the developer for the " +
        "Jira project key and app tag, then call write_repo_config to create it.",
    );
  }

  const projectKey = repoConfig.jiraProjectKeys[0];
  if (!projectKey) {
    throw new Error(`${repoRoot}'s .ai/intake-mcp.json has an empty "jiraProjectKeys" list.`);
  }
  const { key } = await createIssue(client, projectKey, summary, description, issueType ?? "Task");

  const issue = await fetchIssue(client, key);
  await bootstrapIfNeeded(client, issue, repoConfig.appTag);

  return { key, url: `${config.jiraSiteUrl}/browse/${key}` };
}
