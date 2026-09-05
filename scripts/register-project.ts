#!/usr/bin/env node
/**
 * Registration wizard (decision #20) — the interactive flow around the app-tag collision check,
 * mirroring the harness's own `install.sh`. Registers a repo into
 * `~/.config/ai-intake-mcp/projects.json` so headless automation is allowed to drive it (decision
 * #7's "resolved: registration alone is the opt-in" — nothing runs unattended against a repo just
 * because it has `.ai/intake-mcp.json`; it also has to be added here, on this machine).
 *
 * Idempotent on repo path (`upsertProject`) — safe to re-run to update an already-registered repo.
 *
 * Non-interactive mode: pass --path to skip every readline prompt and use flags/defaults instead
 * (see docs/headless-automation.md's "Scripting the registration wizard" section for why this
 * exists — piping answers at a plain `readline` prompt races the wizard's own `await`s and can
 * throw "readline was closed"). Useful for CI, the `test/e2e/register-project.e2e.test.ts` suite,
 * and anyone else who wants to register a repo from a script instead of a terminal.
 *
 *   node --import tsx scripts/register-project.ts --path <repo> [--name <name>] \
 *     [--enable|--no-enable] [--jira-keys DAV,OPS] [--app-tag app:my-repo]
 *
 * --jira-keys/--app-tag are only consulted when the repo has no `.ai/intake-mcp.json` yet — same as
 * the interactive prompts, an existing file always wins.
 */
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadGlobalConfig } from "../src/config.js";
import { JiraClient } from "../src/jira/client.js";
import { checkAppTagCollision, registerResolvedProject } from "../src/automation/registration.js";
import { loadProjectRegistry, type ProjectRegistry } from "../src/automation/registry.js";
import { readRepoConfig, resolveRepoRoot, writeRepoConfig, type RepoConfig } from "../src/repo-context.js";

interface Flags {
  path?: string;
  name?: string;
  enable?: boolean;
  jiraKeys?: string;
  appTag?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--path":
        flags.path = argv[++i];
        break;
      case "--name":
        flags.name = argv[++i];
        break;
      case "--enable":
        flags.enable = true;
        break;
      case "--no-enable":
        flags.enable = false;
        break;
      case "--jira-keys":
        flags.jiraKeys = argv[++i];
        break;
      case "--app-tag":
        flags.appTag = argv[++i];
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

interface Resolved {
  repoRoot: string;
  repoConfig: RepoConfig;
  name: string;
  enable: boolean;
}

function printCollisionOutcome(outcome: "fresh" | "existing-registration", appTag: string, repoRoot: string): void {
  console.log(
    outcome === "fresh"
      ? `"${appTag}" is a fresh tag — no existing tickets found.`
      : `Re-registering an already-registered repo at "${repoRoot}".`,
  );
}

/**
 * Interactive path: the wizard's original prompts, unchanged — including checking collision
 * *before* asking for a display name/enable choice, so a refusal doesn't waste the human's time
 * answering questions for a registration that's about to be rejected.
 */
async function resolveInteractively(client: JiraClient, registry: ProjectRegistry): Promise<Resolved> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback?: string): Promise<string> => {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback || "";
  };

  try {
    const rawPath = await ask("Repo path to register");
    if (!rawPath) throw new Error("A repo path is required.");
    const repoRoot = resolveRepoRoot(rawPath);
    console.log(`Resolved git repo root: ${repoRoot}`);

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

    const collision = await checkAppTagCollision(client, repoConfig.appTag, repoRoot, registry);
    if (collision.outcome === "collision") throw new Error(`Refusing to register — ${collision.reason}`);
    if (collision.outcome === "query-failed") {
      throw new Error(`Refusing to register — the Jira collision check itself failed: ${collision.error}`);
    }
    printCollisionOutcome(collision.outcome, repoConfig.appTag, repoRoot);

    const defaultName = basename(repoRoot);
    const name = await ask("Display name for this project", defaultName);
    const enabledRaw = await ask("Enable headless automation for this project now? (y/n)", "y");

    return { repoRoot, repoConfig, name, enable: enabledRaw.toLowerCase().startsWith("y") };
  } finally {
    rl.close();
  }
}

/** Non-interactive path: same decisions, sourced from flags/defaults instead of prompts. The
 * collision check is left to `registerResolvedProject` below — there's no prompting to skip. */
function resolveFromFlags(flags: Flags): Resolved {
  const repoRoot = resolveRepoRoot(flags.path);
  console.log(`Resolved git repo root: ${repoRoot}`);

  let repoConfig = readRepoConfig(repoRoot);
  if (!repoConfig) {
    if (!flags.jiraKeys || !flags.appTag) {
      throw new Error(
        `${repoRoot} has no .ai/intake-mcp.json — pass --jira-keys and --app-tag to create one ` +
          `non-interactively.`,
      );
    }
    const jiraProjectKeys = flags.jiraKeys.split(",").map((k) => k.trim()).filter(Boolean);
    if (jiraProjectKeys.length === 0) throw new Error("--jira-keys must name at least one project key.");
    writeRepoConfig(repoRoot, { jiraProjectKeys, appTag: flags.appTag });
    repoConfig = { jiraProjectKeys, appTag: flags.appTag };
  }
  console.log(`Using jiraProjectKeys=${JSON.stringify(repoConfig.jiraProjectKeys)}, appTag="${repoConfig.appTag}".`);

  return {
    repoRoot,
    repoConfig,
    name: flags.name ?? basename(repoRoot),
    enable: flags.enable ?? true,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const interactive = flags.path === undefined;

  const config = loadGlobalConfig();
  const client = new JiraClient({ config });
  const registry = loadProjectRegistry();

  const resolved = interactive ? await resolveInteractively(client, registry) : resolveFromFlags(flags);

  const result = await registerResolvedProject(client, registry, {
    repoRoot: resolved.repoRoot,
    repoConfig: resolved.repoConfig,
    displayName: resolved.name,
    enable: resolved.enable,
  });

  if (result.status === "refused") {
    throw new Error(
      `Refusing to register — ${"reason" in result.collision ? result.collision.reason : result.collision.error}`,
    );
  }
  // Interactive mode already printed this (and exited early) before the name/enable prompts.
  if (!interactive) printCollisionOutcome(result.collision.outcome, resolved.repoConfig.appTag, resolved.repoRoot);

  console.log(`Registered "${result.entry.name}" at ${resolved.repoRoot}.`);

  if (!result.reachability.reachable) {
    console.warn(
      `WARNING: registered, but the Jira project key(s) ${JSON.stringify(resolved.repoConfig.jiraProjectKeys)} ` +
        `could not be reached with these credentials: ${result.reachability.error}`,
    );
  } else {
    console.log("Jira project key(s) confirmed reachable.");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
