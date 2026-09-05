#!/usr/bin/env node
/**
 * Real-Jira verification for tracker_create_issue — creates one real, clearly-labeled test ticket
 * in this repo's configured project (not a mock), confirming the create call + immediate
 * state:plan/app:<tag> bootstrap actually work against live Jira. Never prints the API token.
 *
 * Usage: npm run smoke:jira:create-issue
 *
 * Leaves the created ticket in place for manual inspection/deletion — no delete-issue tool exists
 * here, and it's the developer's board to curate, not this script's to clean up.
 */
import { loadGlobalConfig } from "../src/config.js";
import { JiraClient } from "../src/jira/client.js";
import { trackerCreateIssue } from "../src/tools/tracker-create-issue.js";

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const config = loadGlobalConfig();
  const client = new JiraClient({ config });

  section("tracker_create_issue equivalent — trackerCreateIssue");
  const result = await trackerCreateIssue(
    client,
    config,
    "[TEST] tracker_create_issue smoke test — safe to delete",
    "Created by scripts/jira-smoke-check-create-issue.ts to verify the create-issue tool against real Jira. Safe to delete.",
    undefined,
  );
  console.log(`Created: ${result.key}`);
  console.log(`URL:     ${result.url}`);

  section("Result");
  console.log("Real-Jira create-issue smoke check completed without error.");
  console.log(`Ticket ${result.key} was left in place — inspect or delete it on the board yourself.`);
}

main().catch((err: unknown) => {
  console.error("\nSmoke check FAILED:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
