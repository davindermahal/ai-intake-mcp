import type { JiraClient } from "../jira/client.js";
import { fetchIssue } from "../jira/tags.js";
import { worktreeCreate, type WorktreeResult } from "../worktree.js";

/** `worktree_create(ticket_key)` — the summary needed to mint a new branch, if any, comes from Jira. */
export async function worktreeCreateTool(
  client: JiraClient,
  ticketKey: string,
  cwd?: string,
): Promise<WorktreeResult> {
  return worktreeCreate(ticketKey, async () => (await fetchIssue(client, ticketKey)).summary, cwd);
}
