/**
 * Opt-in, real-Jira, real-filesystem end-to-end coverage of the registration wizard
 * (`scripts/register-project.ts`) — the same class of gap `.ai/plans/active/headless-automation-qa.md`
 * Phase C exists to check, but runnable on demand instead of only by a human at a terminal. This is
 * exactly the suite that would have caught the `/rest/api/3/search` → `/rest/api/3/search/jql`
 * migration (see `src/jira/search.ts`) before it showed up as a live 410 during manual QA.
 *
 * SKIPPED BY DEFAULT — `npm test` never runs this. It requires real Jira credentials
 * (`~/.config/ai-intake-mcp/.env`, the same file `npm run health-check` checks) and it writes real
 * state: a throwaway git repo under the OS tmpdir, entries in the real
 * `~/.config/ai-intake-mcp/projects.json`, and (for the collision test) a real, deleted-afterward
 * Jira ticket. Every write uses a random `app:e2e-register-<id>` tag per run so concurrent runs and
 * previous leftovers never collide, and every registry entry this suite adds is removed again in
 * `afterAll` — but it is still real traffic against a real board, hence opt-in.
 *
 * Run it with:
 *   AI_INTAKE_RUN_JIRA_E2E=1 npx vitest run test/e2e/register-project.e2e.test.ts
 *
 * Defaults to this repo's own `DAV` project and a `Task` issue type for the collision-test ticket;
 * override with AI_INTAKE_E2E_PROJECT_KEY / AI_INTAKE_E2E_ISSUE_TYPE if your Jira differs.
 */
import { execFileSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import { plainTextToAdf } from "../../src/jira/adf.js";
import { searchIssues } from "../../src/jira/search.js";
import { loadProjectRegistry, saveProjectRegistry } from "../../src/automation/registry.js";

const execFileAsync = promisify(execFile);

const RUN_E2E = process.env.AI_INTAKE_RUN_JIRA_E2E === "1";
const PROJECT_KEY = process.env.AI_INTAKE_E2E_PROJECT_KEY ?? "DAV";
const ISSUE_TYPE = process.env.AI_INTAKE_E2E_ISSUE_TYPE ?? "Task";

let credentialsAvailable = true;
if (RUN_E2E) {
  try {
    loadGlobalConfig();
  } catch {
    credentialsAvailable = false;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTER_SCRIPT = join(__dirname, "..", "..", "scripts", "register-project.ts");

function runWizard(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execFileAsync("node", ["--import", "tsx", REGISTER_SCRIPT, ...args])
    .then(({ stdout, stderr }) => ({ stdout, stderr, exitCode: 0 }))
    .catch((err: { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? 1,
    }));
}

function makeTempRepo(appTag: string): string {
  const parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-e2e-register-"));
  const repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  mkdirSync(join(repoRoot, ".ai"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".ai", "intake-mcp.json"),
    JSON.stringify({ jiraProjectKeys: [PROJECT_KEY], appTag }, null, 2),
    "utf8",
  );
  return repoRoot;
}

// Everything below that touches credentials/network/the real registry lives inside beforeAll/it/
// afterAll bodies, never directly in the describe factory — vitest still *runs* a skipped suite's
// factory to collect its test names, so anything eagerly evaluated there (e.g. loadGlobalConfig())
// would execute on every `npm test` run, on every machine, even with AI_INTAKE_RUN_JIRA_E2E unset.
describe.skipIf(!RUN_E2E)("register-project wizard (real Jira, opt-in — AI_INTAKE_RUN_JIRA_E2E=1)", () => {
  if (RUN_E2E && !credentialsAvailable) {
    it.skip("skipped: ~/.config/ai-intake-mcp/.env has no usable Jira credentials", () => {});
    return;
  }

  let client: JiraClient;
  const tempDirs: string[] = [];
  const registeredPaths: string[] = [];
  const createdIssueKeys: string[] = [];

  beforeAll(() => {
    client = new JiraClient({ config: loadGlobalConfig() });
  });

  afterAll(async () => {
    // Remove only the entries this run added — never touch anything else already registered.
    if (registeredPaths.length > 0) {
      const registry = loadProjectRegistry();
      saveProjectRegistry({
        projects: registry.projects.filter((p) => !registeredPaths.includes(p.path)),
      });
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    for (const key of createdIssueKeys) {
      try {
        await client.delete(`/rest/api/3/issue/${encodeURIComponent(key)}`);
      } catch (err) {
        console.warn(`e2e cleanup: failed to delete ${key}: ${(err as Error).message}`);
      }
    }
  });

  it("registers a fresh tag end to end via the non-interactive CLI flags", async () => {
    const appTag = `app:e2e-register-${randomUUID().slice(0, 8)}`;
    const repoRoot = makeTempRepo(appTag);
    tempDirs.push(join(repoRoot, ".."));

    const result = await runWizard(["--path", repoRoot, "--name", "e2e-fresh", "--enable"]);
    registeredPaths.push(repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`"${appTag}" is a fresh tag`);
    expect(result.stdout).toContain(`Registered "e2e-fresh"`);
    expect(result.stdout).toContain("confirmed reachable");

    const registry = loadProjectRegistry();
    expect(registry.projects.find((p) => p.path === repoRoot)).toMatchObject({
      name: "e2e-fresh",
      enabled: true,
    });
  });

  it(
    "re-registering the same repo updates the existing entry instead of duplicating it",
    async () => {
      // No ticket ever carries this random tag, so checkAppTagCollision reads "fresh" both times
      // (its "existing-registration" branch only fires once a *ticket* — not just a registry
      // entry — carries the tag; see the collision test below). The invariant worth checking here
      // is upsert-not-duplicate, not which collision message gets printed.
      const appTag = `app:e2e-register-${randomUUID().slice(0, 8)}`;
      const repoRoot = makeTempRepo(appTag);
      tempDirs.push(join(repoRoot, ".."));

      const first = await runWizard(["--path", repoRoot, "--name", "e2e-first", "--enable"]);
      registeredPaths.push(repoRoot);
      expect(first.exitCode).toBe(0);

      const second = await runWizard(["--path", repoRoot, "--name", "e2e-second", "--no-enable"]);
      expect(second.exitCode).toBe(0);

      const registry = loadProjectRegistry();
      const matches = registry.projects.filter((p) => p.path === repoRoot);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ name: "e2e-second", enabled: false });
    },
    15_000,
  );

  it(
    "refuses to register when a ticket already carries the tag but no registry entry claims it",
    async () => {
      const appTag = `app:e2e-register-${randomUUID().slice(0, 8)}`;
      const repoRoot = makeTempRepo(appTag);
      tempDirs.push(join(repoRoot, ".."));

      const created = await client.post<{ key: string }>("/rest/api/3/issue", {
        fields: {
          project: { key: PROJECT_KEY },
          issuetype: { name: ISSUE_TYPE },
          summary: "[e2e] register-project collision-check fixture — safe to delete",
          description: plainTextToAdf(
            "Created by test/e2e/register-project.e2e.test.ts; deleted automatically in afterAll.",
          ),
          labels: ["state:plan", appTag],
        },
      });
      createdIssueKeys.push(created.key);

      // Jira's search index lags label writes by a few seconds (observed during manual QA) — poll
      // the read side directly instead of a fixed sleep, then run the wizard exactly once so a
      // false "fresh" read (index not caught up yet) can't slip a bad entry into the real registry.
      await expect
        .poll(async () => (await searchIssues(client, `labels = "${appTag}"`)).length, {
          timeout: 20_000,
          interval: 2_000,
        })
        .toBeGreaterThan(0);

      const result = await runWizard(["--path", repoRoot, "--name", "e2e-collision", "--enable"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no project in this machine's registry claims that tag");

      const registry = loadProjectRegistry();
      expect(registry.projects.find((p) => p.path === repoRoot)).toBeUndefined();
    },
    30_000,
  );
});
