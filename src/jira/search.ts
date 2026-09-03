import type { JiraClient } from "./client.js";
import { STATE_LABEL, type JiraIssue, type RawJiraIssue, type ShortState, rawIssueToJiraIssue } from "./tags.js";

/**
 * Ticket-discovery JQL builder (decision #6's "new work" item, headless-automation plan) — nothing
 * like this exists in the interactive tools yet (a ticket key is always given by the human there).
 * Spans a repo's whole `jiraProjectKeys` collection in one query, so headless polling of a
 * multi-key repo is still one query per project per pass, not one per key. Ported from
 * `jira-tags.sh`'s JQL pattern.
 */
export interface DiscoveryQuery {
  projectKeys: string[];
  appTag: string;
  /** One or more `ShortState`s, OR'd together — e.g. the planning pass's `state:plan` search, or a
   * combined `state:plan`/`state:needs-input` sweep. */
  stateLabels: ShortState[];
  /** Default true — automation only ever picks up tickets assigned to its own account, same
   * assignee-scoping the interactive tools already rely on (decision #3 in the v1 plan). */
  assignedToCurrentUser?: boolean;
}

export function buildDiscoveryJql(query: DiscoveryQuery): string {
  if (query.projectKeys.length === 0) {
    throw new Error("buildDiscoveryJql: projectKeys must be non-empty.");
  }
  if (query.stateLabels.length === 0) {
    throw new Error("buildDiscoveryJql: stateLabels must be non-empty.");
  }

  const projectClause = `project in (${query.projectKeys.map((k) => `"${k}"`).join(", ")})`;
  const appTagClause = `labels = "${query.appTag}"`;
  const stateClause =
    query.stateLabels.length === 1
      ? `labels = "${STATE_LABEL[query.stateLabels[0] as ShortState]}"`
      : `(${query.stateLabels.map((s) => `labels = "${STATE_LABEL[s]}"`).join(" OR ")})`;

  const clauses = [projectClause, appTagClause, stateClause];
  if (query.assignedToCurrentUser !== false) clauses.push("assignee = currentUser()");

  return `${clauses.join(" AND ")} ORDER BY created ASC`;
}

/** `tracker_search` equivalent (decision #6's "new work" item) — runs a JQL query and maps every
 * result the same way `fetchIssue` maps a single ticket. */
export async function searchIssues(client: JiraClient, jql: string): Promise<JiraIssue[]> {
  const result = await client.post<{ issues: RawJiraIssue[] }>("/rest/api/3/search", {
    jql,
    fields: ["summary", "status", "description", "comment", "labels", "assignee"],
  });
  return result.issues.map(rawIssueToJiraIssue);
}
