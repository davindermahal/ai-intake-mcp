#!/usr/bin/env node
/**
 * Registration wizard (decision #20) — the interactive flow around the app-tag collision check,
 * mirroring the harness's own `install.sh`. Registers a repo into
 * `~/.config/ai-intake-mcp/projects.json` so headless automation is allowed to drive it (decision
 * #7's "resolved: registration alone is the opt-in" — nothing runs unattended against a repo just
 * because it has `.ai/intake-mcp.json`; it also has to be added here, on this machine).
 *
 * Idempotent on repo path (`upsertProject`) — safe to re-run to update an already-registered repo.
 */
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadGlobalConfig } from "../src/config.js";
import { JiraClient } from "../src/jira/client.js";
import { checkAppTagCollision, verifyProjectKeysReachable } from "../src/automation/registration.js";
import { loadProjectRegistry, saveProjectRegistry, upsertProject, type ProjectEntry } from "../src/automation/registry.js";
import { readRepoConfig, resolveRepoRoot, writeRepoConfig } from "../src/repo-context.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function main(): Promise<void> {
  // Step 1: repo path, verify it's a git repo.
  const rawPath = await ask("Repo path to register");
  if (!rawPath) throw new Error("A repo path is required.");
  const repoRoot = resolveRepoRoot(rawPath);
  console.log(`Resolved git repo root: ${repoRoot}`);

  // Step 2: read (or create) .ai/intake-mcp.json.
  let repoConfig = readRepoConfig(repoRoot);
  if (!repoConfig) {
    console.log("No .ai/intake-mcp.json found — let's create one.");
    const keysRaw = await ask('Jira project key(s), comma-separated (e.g. "DAV" or "DAV,OPS")');
    const jiraProjectKeys = keysRaw.split(",").map((k) => k.trim()).filter(Boolean);
    if (jiraProjectKeys.length === 0) throw new Error("At least one Jira project key is required.");
    const appTag = await ask('App tag (e.g. "app:my-repo")', `app:${basename(repoRoot)}`);
    writeRepoConfig(repoRoot, { jiraProjectKeys, appTag });
    repoConfig = { jiraProjectKeys, appTag };
  }
  console.log(`Using jiraProjectKeys=${JSON.stringify(repoConfig.jiraProjectKeys)}, appTag="${repoConfig.appTag}".`);

  const config = loadGlobalConfig();
  const client = new JiraClient({ config });

  // Step 3: app-tag collision check.
  const registry = loadProjectRegistry();
  const collision = await checkAppTagCollision(client, repoConfig.appTag, repoRoot, registry);
  if (collision.outcome === "collision") {
    throw new Error(`Refusing to register — ${collision.reason}`);
  }
  if (collision.outcome === "query-failed") {
    throw new Error(`Refusing to register — the Jira collision check itself failed: ${collision.error}`);
  }
  console.log(
    collision.outcome === "fresh"
      ? `"${repoConfig.appTag}" is a fresh tag — no existing tickets found.`
      : `Re-registering an already-registered repo at "${repoRoot}".`,
  );

  // Step 4: the few registry-level fields that need a human choice.
  const defaultName = basename(repoRoot);
  const name = await ask("Display name for this project", defaultName);
  const enabledRaw = await ask("Enable headless automation for this project now? (y/n)", "y");

  const entry: ProjectEntry = {
    path: repoRoot,
    name,
    enabled: enabledRaw.toLowerCase().startsWith("y"),
    overrides: undefined,
  };

  // Step 5: write/update the registry entry.
  saveProjectRegistry(upsertProject(registry, entry));
  console.log(`Registered "${name}" at ${repoRoot}.`);

  // Step 6: live reachability check.
  const reachability = await verifyProjectKeysReachable(client, repoConfig.jiraProjectKeys);
  if (!reachability.reachable) {
    console.warn(
      `WARNING: registered, but the Jira project key(s) ${JSON.stringify(repoConfig.jiraProjectKeys)} ` +
        `could not be reached with these credentials: ${reachability.error}`,
    );
  } else {
    console.log("Jira project key(s) confirmed reachable.");
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
