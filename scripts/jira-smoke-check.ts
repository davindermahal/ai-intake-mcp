#!/usr/bin/env node
/**
 * Phase 1 real-Jira verification checkpoint (see the plan doc's "Verification checkpoints").
 *
 * Exercises tracker_get_issue / tracker_add_comment / tracker_transition against one real,
 * throwaway ticket — not a mock — confirming the label-driven transition, the assignee-gate
 * (including the unassigned-auto-assign case), and the native-status mirror actually behave as
 * designed against live Jira. Never prints the API token; only non-secret results.
 *
 * Usage: npm run smoke:jira -- DAV-5
 */
import { loadGlobalConfig } from "../src/config.js";
import { JiraClient } from "../src/jira/client.js";
import { addComment, currentAccountId, fetchIssue, transitionState } from "../src/jira/tags.js";

const key = process.argv[2];
if (!key) {
  console.error("Usage: npm run smoke:jira -- <TICKET-KEY>  (e.g. DAV-5)");
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const config = loadGlobalConfig();
  const client = new JiraClient({ config });

  section("1. tracker_get_issue equivalent — fetchIssue");
  const before = await fetchIssue(client, key);
  console.log(`summary: ${before.summary}`);
  console.log(`status:  ${before.statusName}`);
  console.log(`labels:  ${before.labels.join(", ") || "(none)"}`);
  console.log(`assignee accountId: ${before.assigneeAccountId ?? "(unassigned)"}`);

  section("2. Assignee identity");
  const me = await currentAccountId(client);
  console.log(`Authenticated account: ${me}`);

  section("3. tracker_add_comment equivalent — addComment");
  const comment = await addComment(
    client,
    key,
    "ai-intake-mcp Phase 1 real-Jira smoke check.",
    "🤖 _Posted by ai-intake-mcp smoke check_",
  );
  console.log(`Comment posted: id=${comment.id}`);

  section("4. tracker_transition equivalent — transitionState(needs-input)");
  const t1 = await transitionState(client, before, "needs-input", config);
  console.log(`label swap applied. mirrored=${t1.mirrored} note="${t1.note}"`);
  const afterT1 = await fetchIssue(client, key);
  console.log(`labels now: ${afterT1.labels.join(", ") || "(none)"}`);
  console.log(`assignee accountId now: ${afterT1.assigneeAccountId ?? "(unassigned)"}`);

  section("5. tracker_transition equivalent — transitionState(review)");
  const t2 = await transitionState(client, afterT1, "review", config);
  console.log(`label swap applied. mirrored=${t2.mirrored} note="${t2.note}"`);
  const after = await fetchIssue(client, key);
  console.log(`labels now: ${after.labels.join(", ") || "(none)"}`);

  section("6. Cleanup — deleting the smoke-check comment");
  await client.delete(`/rest/api/3/issue/${encodeURIComponent(key)}/comment/${comment.id}`);
  console.log("Comment deleted.");

  section("Result");
  console.log("Real-Jira smoke check completed without error.");
}

main().catch((err: unknown) => {
  console.error("\nSmoke check FAILED:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
