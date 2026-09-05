import type { JiraClient } from "../jira/client.js";
import { bootstrapIfNeeded, fetchIssue } from "../jira/tags.js";
import { readRepoConfig, resolveRepoRoot } from "../repo-context.js";

export interface TrackerGetIssueResult {
  summary: string;
  status: string;
  description: string;
  comments: { author: string; body: string; created: string }[];
}

/** Refuses with a clear error if unconfigured or if the issue's project/app-tag don't match. */
export async function trackerGetIssue(
  client: JiraClient,
  key: string,
  cwd?: string,
): Promise<TrackerGetIssueResult> {
  const repoRoot = resolveRepoRoot(cwd);
  const repoConfig = readRepoConfig(repoRoot);
  if (!repoConfig) {
    throw new Error(
      "This repo isn't configured yet — no .ai/intake-mcp.json found. Ask the developer for the " +
        "Jira project key and app tag, then call write_repo_config to create it.",
    );
  }

  const issue = await fetchIssue(client, key);
  if (!repoConfig.jiraProjectKeys.includes(issue.projectKey)) {
    throw new Error(
      `${key} belongs to Jira project "${issue.projectKey}", not one of ` +
        `[${repoConfig.jiraProjectKeys.join(", ")}] — wrong repo?`,
    );
  }

  // Cross-repo ticket safety check + bootstrap (decision #4) — throws if tagged for a different repo.
  await bootstrapIfNeeded(client, issue, repoConfig.appTag);

  return {
    summary: issue.summary,
    status: issue.statusName,
    description: issue.description,
    comments: issue.comments,
  };
}
