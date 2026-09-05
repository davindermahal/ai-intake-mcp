import type { JiraIssue } from "../jira/tags.js";

/**
 * Comment-driven re-pickup for `state:needs-input` (decision #18, headless-automation plan).
 * Resolves the dead end where nothing ever transitions a ticket back to `state:plan`: the planning
 * pass instead runs a second discovery query for `state:needs-input` tickets, and this check decides
 * which of those are actually ready — an author replied after automation's own last comment.
 *
 * Matches on the stable `"via ai-intake-mcp_"` substring of `commentFooter`'s output (`src/footer.ts`
 * — its exact text varies by calling client, e.g. Claude vs. Gemini), the same
 * constant-portion-fingerprint approach `ai-intake-harness`'s `JIRA_AI_COMMENT_FOOTER` already uses.
 *
 * Accepted tradeoff (decision #18): this doesn't judge whether the reply actually *answers* the
 * blocking question — any non-automation comment after the last automation comment counts. A
 * tangential reply just causes a wasted re-pickup that bounces back to `needs-input` again with a
 * fresh comment (and a fresh fingerprint to wait past) — self-correcting, occasionally wasteful.
 */
const AUTOMATION_FOOTER_FINGERPRINT = "via ai-intake-mcp_";

export function hasAuthorReplySinceLastAutomationComment(issue: JiraIssue): boolean {
  const comments = issue.comments;
  let lastAutomationIndex = -1;
  for (let i = 0; i < comments.length; i++) {
    if (comments[i]?.body.includes(AUTOMATION_FOOTER_FINGERPRINT)) lastAutomationIndex = i;
  }
  if (lastAutomationIndex === -1) return false;

  return comments
    .slice(lastAutomationIndex + 1)
    .some((c) => !c.body.includes(AUTOMATION_FOOTER_FINGERPRINT));
}
