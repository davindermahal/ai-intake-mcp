#!/usr/bin/env node
/**
 * Phase 1 real-Jira verification checkpoint for the implementation-phase plan (see the plan doc's
 * "Verification checkpoints"). Exercises approve_plan, the widened tracker_transition vocabulary
 * (working/verify/problem), the refusal of "implement" as a raw target, and the
 * TRACKER_NATIVE_STATUS_CODE_REVIEW mirror — none of which v1's checkpoint touched — against one
 * real, disposable ticket. Never prints the API token; only non-secret results.
 *
 * Usage: node --import tsx scripts/jira-smoke-check-implementation.ts DAV-5 <worktree-path>
 */
import { loadGlobalConfig } from "../src/config.js";
import { JiraClient } from "../src/jira/client.js";
import { applyLabels, fetchIssue } from "../src/jira/tags.js";
import { approvePlanTool } from "../src/tools/approve-plan.js";
import { trackerTransition } from "../src/tools/tracker-transition.js";
import { readPlanStatus, setPlanStatus, findPlanFile } from "../src/plan-file.js";

const key = process.argv[2];
const worktreePath = process.argv[3];
if (!key || !worktreePath) {
  console.error("Usage: node --import tsx scripts/jira-smoke-check-implementation.ts <TICKET-KEY> <worktree-path>");
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const config = loadGlobalConfig();
  const client = new JiraClient({ config });

  const planPath = findPlanFile(worktreePath, key);
  if (!planPath) throw new Error(`No plan file for ${key} in ${worktreePath}`);
  const originalStatus = readPlanStatus(planPath);
  const originalIssue = await fetchIssue(client, key);
  const originalLabels = originalIssue.labels;

  try {
    section("Setup — force state:review + plan Status: draft");
    await applyLabels(client, key, ["app:ai-intake-mcp", "state:review"]);
    setPlanStatus(planPath, "draft");
    console.log("done");

    section("1. approve_plan — should succeed, plan flips to ready");
    const approved = await approvePlanTool(client, config, key, worktreePath);
    console.log(`plan_path=${approved.planPath} transitioned_to=${approved.transitionedTo}`);
    console.log(`plan Status now: ${readPlanStatus(planPath)}`);
    const afterApprove = await fetchIssue(client, key);
    console.log(`labels now: ${afterApprove.labels.join(", ")}`);

    section('2. tracker_transition(key, "implement") — must be REFUSED (decision #5)');
    try {
      await trackerTransition(client, config, key, "implement");
      throw new Error("FAIL: tracker_transition accepted \"implement\" — vocabulary exclusion broken!");
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("FAIL:")) throw err;
      console.log(`correctly refused: ${msg}`);
    }

    section('3. tracker_transition(key, "working")');
    const working = await trackerTransition(client, config, key, "working");
    console.log(`mirrored=${working.mirrored} note="${working.note}"`);

    section('4. tracker_transition(key, "verify") — new ground: TRACKER_NATIVE_STATUS_CODE_REVIEW');
    const verify = await trackerTransition(client, config, key, "verify");
    console.log(`mirrored=${verify.mirrored} note="${verify.note}"`);
    if (!verify.mirrored) {
      console.warn("WARNING: verify did not mirror — check TRACKER_NATIVE_STATUS_CODE_REVIEW exists on this board.");
    }

    section('5. tracker_transition(key, "problem")');
    const problem = await trackerTransition(client, config, key, "problem");
    console.log(`mirrored=${problem.mirrored} note="${problem.note}"`);

    section("6. Re-fetch to confirm final label state");
    const final = await fetchIssue(client, key);
    console.log(`labels: ${final.labels.join(", ")}`);

    section("Result");
    console.log("Implementation-phase real-Jira smoke check completed without error.");
  } finally {
    section("Cleanup — restoring original labels + plan Status");
    await applyLabels(client, key, originalLabels);
    setPlanStatus(planPath, originalStatus);
    console.log(`labels restored to: ${originalLabels.join(", ")}, plan Status restored to: ${originalStatus}`);
  }
}

main().catch((err: unknown) => {
  console.error("\nSmoke check FAILED:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
