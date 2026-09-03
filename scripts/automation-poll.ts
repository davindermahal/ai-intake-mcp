#!/usr/bin/env node
/**
 * Headless automation's cron entrypoint (decisions #10/#21) — one sequential sweep over every
 * registered project, three sub-passes each (planning, implementation, watchdog), in order. Run
 * directly for manual testing/`--dry-run`; the real cron line should invoke
 * `scripts/automation-poll.sh` instead, which wraps this in decision #19's non-blocking `flock -n`
 * overlap guard (a plain `node --import tsx scripts/automation-poll.ts` here has no such guard —
 * two overlapping cron ticks would both run at once).
 */
import { syncGeminiPolicy } from "../src/ai/gemini-policy.js";
import { loadGlobalConfig } from "../src/config.js";
import { runProjectPasses } from "../src/automation/orchestrator.js";
import { loadProjectRegistry } from "../src/automation/registry.js";
import { loadAutomationSettings } from "../src/automation/settings.js";
import { JiraClient } from "../src/jira/client.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const config = loadGlobalConfig();
  const client = new JiraClient({ config });
  const settings = loadAutomationSettings();
  const registry = loadProjectRegistry();

  // Machine-global, idempotent, and not a "write against the live board" (decision #9) — safe to
  // run on every sweep, dry-run included, so the deny-list is never stale by the time a real Gemini
  // launch happens. Previously this was implemented and unit-tested but never actually called from
  // anywhere, so the sandbox it describes didn't exist on disk (found during headless-automation QA
  // Phase B/G). Best-effort: a sync failure (e.g. an unwritable ~/.gemini) shouldn't block Claude-
  // only sweeps.
  try {
    const { path } = syncGeminiPolicy();
    console.log(`Gemini permission policy synced: ${path}`);
  } catch (err) {
    console.warn(`WARNING: failed to sync Gemini permission policy: ${err instanceof Error ? err.message : err}`);
  }

  if (registry.projects.length === 0) {
    console.log("No projects registered (see `npm run register-project`) — nothing to do.");
    return;
  }

  if (dryRun) {
    console.log(
      "--dry-run: logging every action instead of taking it — no Jira writes, no AI processes " +
        "spawned, no marker state changed.\n",
    );
  }

  for (const project of registry.projects) {
    console.log(`--- ${project.name} (${project.path}) — enabled: ${project.enabled} ---`);
    try {
      const result = await runProjectPasses({ client, config, project, settings, dryRun });
      console.log(
        `planning: dispatched ${result.planning.dispatched.length} ticket(s); ` +
          `implementation: dispatched ${result.implementation.dispatched ? 1 : 0}, ` +
          `bounced ${result.implementation.bounced.length}; ` +
          `watchdog: ${result.watchdog.heartbeats.length} heartbeat(s), ` +
          `${result.watchdog.completed.length} completed, ${result.watchdog.restarted.length} restarted, ` +
          `${result.watchdog.escalated.length} escalated.`,
      );
    } catch (err) {
      console.error(`ERROR in project "${project.name}": ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
