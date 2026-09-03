# Headless automation — testing guide

**Status: implemented, not yet validated against a live board.** Everything below has full unit and
integration test coverage (`npm test` — see `test/automation/integration.test.ts` for the multi-tick
simulated-cron scenarios), but no real headless `claude`/`gemini` process has ever actually run
against a real Jira ticket yet. Treat every step here as first-time validation, not routine
operation, until you've watched it work end to end at least once.

For the full design record (all 22 decisions, why each piece exists), see
[`.ai/plans/active/headless-automation.md`](../.ai/plans/active/headless-automation.md). This doc is
just the practical "how do I actually try this" path. It assumes the interactive setup in
[`setup.md`](setup.md) is already done and working (`npm run health-check` passes).

## What this adds

Everything in [`usage.md`](usage.md) still works unchanged — headless automation is a second,
separate way to drive the same planning/implementation pipeline, on a cron, across one or more
registered repos, with no developer present. A repo is **never** touched by it just because
`.ai/intake-mcp.json` exists; it also has to be explicitly registered on *this machine*
(`~/.config/ai-intake-mcp/projects.json`) via the wizard below. Nothing runs unattended until you've
both registered a project *and* installed the cron job.

## Before you start: use a low-stakes test repo and Jira project

Don't point the first run at a real production repo or board. Use (or create) a throwaway repo with
its own `.ai/intake-mcp.json` and a Jira project/board you don't mind posting test comments and
transitions on. Once you've watched a full cycle succeed, register a real project.

## 1. Register a project

```bash
npm run register-project
```

Interactive wizard (decision #20): prompts for the repo path, reads or creates its
`.ai/intake-mcp.json`, runs a live Jira check for any ticket already carrying that repo's `app:<tag>`
label (refuses if it looks like a different tool/registration already owns that tag), then asks for a
display name and whether to enable it immediately. Writes an entry to
`~/.config/ai-intake-mcp/projects.json`. Safe to re-run — it updates the existing entry for the same
repo path rather than duplicating it.

## 2. Dry-run — read this output carefully before doing anything else

```bash
npm run automation-poll -- --dry-run
```

Runs the full sweep — planning, implementation, and watchdog passes, for every registered project —
but every Jira comment/transition, every plan-file `Status` write, every marker file change, and
every `claude`/`gemini` process launch is **logged instead of taken** (`[dry-run] would ...` lines;
see `src/automation/dry-run.ts`). This still makes **read** calls to your real Jira board (searches,
issue fetches) — it needs real credentials to run at all — it just never writes anything or spawns
anything.

Run this repeatedly as you iterate. If a ticket you expected to show up doesn't (or one shows up you
didn't expect), that's the JQL scoping (`jiraProjectKeys`/`appTag` in `.ai/intake-mcp.json`,
`labels = "state:..."`) — check those before moving on.

## 3. A real, manual run — watch it end to end once, without cron

Once dry-run output looks right, run it for real, still by hand (not via cron yet), against one test
ticket in `state:plan`:

```bash
npm run automation-poll
```

This one call **will**: create/resume a git worktree, spawn a real headless `claude`/`gemini`
process (billed, takes real time — planning is typically fast; implementation can run 25-40+
minutes unattended per the plan doc's own numbers), and — once that process exits — the *next*
`npm run automation-poll` invocation (the watchdog pass) will post the resulting plan as a Jira
comment and transition the ticket. Headless workers run **detached**: a single invocation dispatches
work but doesn't wait for it to finish, so you'll need to run this command again (or wait for cron)
to see the follow-up comment/transition land. Watch:

- The ticket's Jira comment history — every transition is accompanied by a human-readable comment
  (decision #3's "Jira is the sole visibility surface" principle); you should never need to read a
  log file to know what happened.
- `~/.config/ai-intake-mcp/state/<project-name>/logs/<TICKET-KEY>.log` — the launched process's raw
  stdout/stderr, if a comment doesn't show up when you expect one.
- `~/.config/ai-intake-mcp/state/<project-name>/workers/<TICKET-KEY>.json` — the running-slot marker
  (decision #8); it disappears on clean completion, stays with `"escalated": true` if the retry
  budget was exhausted.

Repeat for a ticket through implementation (`approve_plan` it, or move the label to
`state:implement` directly, then run `automation-poll` again) before trusting this on a cron.

## 4. Install the cron job

Once you've watched a full plan → review → approve → implement → verify cycle succeed manually,
install the real cron entry — **use the `.sh` wrapper, not the bare `.ts` script**, to get the
non-blocking overlap guard (decision #19: a still-running previous tick makes the next invocation
exit immediately rather than piling up):

```bash
crontab -e
# Add (every 2 minutes matches the harness's own cadence, and is at least as fine as the
# tightest watchdog heartbeat interval, decision #12):
*/2 * * * * /path/to/ai-intake-mcp/scripts/automation-poll.sh
```

## Monitoring and troubleshooting

- **Everything lives under `~/.config/ai-intake-mcp/state/<project-name>/`** — `workers/` (markers),
  `context/` and `result/` (what each worker was given / reported back), `progress/` (the worker's
  own `Done:`/`Next:` log, what heartbeat comments are composed from), `prompts/` (the exact rendered
  prompt a worker was launched with), `logs/` (raw process output). Nothing here is inside the target
  repo.
- **A ticket stuck with no progress**: check its marker file's `pid` against `ps -p <pid>` — if dead
  with no result file, the watchdog will restart it (up to the configured `maxAttempts`) or escalate
  with a comment once exhausted; you don't need to intervene manually, but the logs above explain why.
- **An escalated ticket** (`"escalated": true` in its marker, an "Escalating: ..." Jira comment):
  automation has given up on it — fix whatever the comment/logs point at, then delete the marker file
  by hand to let it be picked up again.
- **Pause one project without unregistering it**: set `"enabled": false` on its entry in
  `~/.config/ai-intake-mcp/projects.json`. New dispatch stops immediately; the watchdog still sweeps
  any already-in-flight worker to completion rather than abandoning it.
- **Tune concurrency/watchdog timing/permission profiles**: `~/.config/ai-intake-mcp/settings.json`
  (global defaults) and a project's own `"overrides"` block in `projects.json` (decision #7/#13) — see
  the plan doc for the full schema and defaults.

## Current limitations

- Only Claude and Gemini adapters exist (decision #14) — no Codex/Antigravity/local-LLM yet.
- Gemini's permission sandboxing is machine-global, not per-project (`~/.gemini/policies/`) — an
  upstream gemini-cli limitation (issue #18186), not something this project can fix.
- A project's `overrides.worktreeRoot` is accepted in the registry schema but not yet wired into
  worktree creation — every project still uses the standard sibling-directory convention.
- No headless run has been validated against a real board yet — that's exactly what steps 2-3 above
  are for. Report anything that looks wrong before relying on the cron job unattended.
