import type { GlobalConfig } from "../config.js";
import { adfToPlainText, plainTextToAdf } from "./adf.js";
import type { JiraClient } from "./client.js";

/**
 * jira-tags mode (decision #3): the abstract pipeline state lives in a single `state:<step>` label,
 * not Jira's native status field. Reimplemented from `lib/tracker/jira-tags.sh`'s contract, with
 * ai-intake-mcp's own shortened label vocabulary — see the plan doc's mapping table.
 */

export type ShortState =
  | "plan"
  | "needs-input"
  | "review"
  | "implement"
  | "working"
  | "verify"
  | "problem";

export const STATE_LABEL: Record<ShortState, string> = {
  plan: "state:plan",
  "needs-input": "state:needs-input",
  review: "state:review",
  implement: "state:implement",
  working: "state:working",
  verify: "state:verify",
  problem: "state:problem",
};

/**
 * `plan` is bootstrap-only; `implement` is reachable only via `approve_plan`, never a raw
 * `tracker_transition` target (implementation-phase plan, decision #5 — keeps the plan-file
 * `Status` flip and the Jira label from drifting apart). Both excluded here the same way v1
 * excluded `plan`.
 */
export const TRANSITION_TARGETS: readonly ShortState[] = [
  "needs-input",
  "review",
  "working",
  "verify",
  "problem",
];

export function isTransitionTarget(value: string): value is (typeof TRANSITION_TARGETS)[number] {
  return (TRANSITION_TARGETS as readonly string[]).includes(value);
}

export interface JiraIssue {
  key: string;
  projectKey: string;
  summary: string;
  statusName: string;
  description: string;
  comments: { author: string; body: string; created: string }[];
  labels: string[];
  assigneeAccountId: string | null;
}

export function currentStateLabel(labels: string[]): string | undefined {
  return labels.find((label) => label.startsWith("state:"));
}

export function currentAppTag(labels: string[]): string | undefined {
  return labels.find((label) => label.startsWith("app:"));
}

export class AssigneeConflictError extends Error {
  constructor(key: string, assignedTo: string) {
    super(`${key} is currently assigned to ${assignedTo}, not you — refusing to write.`);
  }
}

export class AppTagConflictError extends Error {
  constructor(key: string, existingTag: string, expectedTag: string) {
    super(`${key} is tagged ${existingTag}, not ${expectedTag} — wrong repo?`);
  }
}

interface RawJiraComment {
  author?: { displayName?: string };
  body?: unknown;
  created?: string;
}

export interface RawJiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    description: unknown;
    comment?: { comments: RawJiraComment[] };
    labels?: string[];
    assignee?: { accountId: string } | null;
  };
}

/** Shared by `fetchIssue` (one ticket) and `searchIssues` (`src/jira/search.ts`, many tickets from
 * one JQL query) — both return the Jira API's issue shape, just via different endpoints. */
export function rawIssueToJiraIssue(raw: RawJiraIssue): JiraIssue {
  return {
    key: raw.key,
    projectKey: raw.key.split("-")[0] ?? "",
    summary: raw.fields.summary,
    statusName: raw.fields.status.name,
    description: adfToPlainText(raw.fields.description),
    comments: (raw.fields.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? "Unknown",
      body: adfToPlainText(c.body),
      created: c.created ?? "",
    })),
    labels: raw.fields.labels ?? [],
    assigneeAccountId: raw.fields.assignee?.accountId ?? null,
  };
}

export async function fetchIssue(client: JiraClient, key: string): Promise<JiraIssue> {
  const raw = await client.get<RawJiraIssue>(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,description,comment,labels,assignee,project`,
  );
  return rawIssueToJiraIssue(raw);
}

export async function createIssue(
  client: JiraClient,
  projectKey: string,
  summary: string,
  description: string | undefined,
  issueType: string,
): Promise<{ key: string }> {
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary,
    issuetype: { name: issueType },
  };
  if (description) fields.description = plainTextToAdf(description);
  return client.post<{ key: string }>("/rest/api/3/issue", { fields });
}

export async function currentAccountId(client: JiraClient): Promise<string> {
  const me = await client.get<{ accountId: string }>("/rest/api/3/myself");
  return me.accountId;
}

/**
 * Assignee gate (decision #3): a state-changing write requires the ticket be assigned to the
 * authenticated account. Unassigned auto-assigns first (naming the ticket to `plan_ticket` is
 * already the explicit signal of intent); assigned to someone else is a hard refusal.
 */
export async function assertAssigneeOrAutoAssign(client: JiraClient, issue: JiraIssue): Promise<void> {
  const myAccountId = await currentAccountId(client);
  if (issue.assigneeAccountId === myAccountId) return;
  if (issue.assigneeAccountId === null) {
    await client.put(`/rest/api/3/issue/${encodeURIComponent(issue.key)}/assignee`, {
      accountId: myAccountId,
    });
    return;
  }
  throw new AssigneeConflictError(issue.key, issue.assigneeAccountId);
}

export async function applyLabels(client: JiraClient, key: string, labels: string[]): Promise<void> {
  await client.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: { labels } });
}

/**
 * Bootstraps an untouched ticket (decision #4): applies `state:plan` if no `state:*` label exists
 * yet, and this repo's `app:<appTag>` if no `app:*` label exists yet. Refuses instead if the ticket
 * already carries a *different* app tag. Returns the label set actually written, or undefined if no
 * write was needed.
 */
export async function bootstrapIfNeeded(
  client: JiraClient,
  issue: JiraIssue,
  appTag: string,
): Promise<string[] | undefined> {
  const existingAppTag = currentAppTag(issue.labels);
  if (existingAppTag && existingAppTag !== appTag) {
    throw new AppTagConflictError(issue.key, existingAppTag, appTag);
  }

  const additions: string[] = [];
  if (!currentStateLabel(issue.labels)) additions.push(STATE_LABEL.plan);
  if (!existingAppTag) additions.push(appTag);

  if (additions.length === 0) return undefined;
  const newLabels = [...issue.labels, ...additions];
  await applyLabels(client, issue.key, newLabels);
  return newLabels;
}

/**
 * `verify` mirrors to the code-review column (implementation-phase plan, decision #7 — finally
 * reachable, v1 explicitly left it unbuilt). Every other target — including the new `problem` —
 * mirrors to the in-progress column; `problem` doesn't get its own native-status variable, the
 * `state:problem` label itself is the authoritative signal.
 */
function nativeStatusNameFor(target: ShortState, config: GlobalConfig): string {
  if (target === "verify") return config.trackerNativeStatusCodeReview;
  return config.trackerNativeStatusInProgress;
}

interface JiraTransition {
  id: string;
  to: { name: string };
}

/**
 * Best-effort mirror onto Jira's native status column so the board looks right to a human glancing
 * at it (decision #3). A failed mirror is logged but never thrown — the label write already
 * succeeded and is the authoritative source of truth.
 */
export async function mirrorNativeStatus(
  client: JiraClient,
  key: string,
  target: ShortState,
  config: GlobalConfig,
): Promise<{ mirrored: boolean; note: string }> {
  const desiredStatusName = nativeStatusNameFor(target, config);
  try {
    const { transitions } = await client.get<{ transitions: JiraTransition[] }>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    const match = transitions.find((t) => t.to.name === desiredStatusName);
    if (!match) {
      return {
        mirrored: false,
        note: `No transition to native status "${desiredStatusName}" available from the current status.`,
      };
    }
    await client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: match.id },
    });
    return { mirrored: true, note: `Mirrored to native status "${desiredStatusName}".` };
  } catch (err) {
    return { mirrored: false, note: `Native status mirror failed: ${(err as Error).message}` };
  }
}

/** Removes the ticket's current `state:*` label and applies the target's, then mirrors best-effort. */
export async function transitionState(
  client: JiraClient,
  issue: JiraIssue,
  target: ShortState,
  config: GlobalConfig,
): Promise<{ mirrored: boolean; note: string }> {
  await assertAssigneeOrAutoAssign(client, issue);
  const withoutState = issue.labels.filter((l) => !l.startsWith("state:"));
  await applyLabels(client, issue.key, [...withoutState, STATE_LABEL[target]]);
  return mirrorNativeStatus(client, issue.key, target, config);
}

/**
 * `tracker_add_comment` is not assignee-gated by default (decision #3) — a worker's only channel to
 * report back should survive a mid-flight reassignment.
 */
export async function addComment(
  client: JiraClient,
  key: string,
  text: string,
  footer: string,
): Promise<{ id: string }> {
  return client.post<{ id: string }>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    body: plainTextToAdf(`${text}\n\n${footer}`),
  });
}
