# Plan: headless automation — end-to-end QA / validation

**Status**: active — not yet executed
**Created**: 2026-09-03

**Related**: `.ai/plans/active/headless-automation.md` (the implementation this validates — all 22
design decisions live there; this plan references them by number rather than re-explaining them),
`docs/headless-automation.md` (the quick-start testing guide this plan expands into a rigorous,
checkable sequence), `.ai/README.md`'s "Verification requirement" (every plan touching a real
external system needs a real verification checkpoint against it — this plan *is* that checkpoint
for headless automation).

## Goal

Answer, with evidence, not assumption: **does headless automation actually work**, end to end,
against a real Jira board and real `claude`/`gemini` CLI processes — before it ever runs unattended
against a production repo. `npm test` (299 tests, including `test/automation/integration.test.ts`'s
multi-tick simulated-cron scenarios) already proves the *code's internal logic* is correct against
mocked Jira and a fake provider adapter. It cannot prove any of the following, all of which this
plan exists to check:

- The real Jira Cloud REST API actually behaves the way the mocks assume (field shapes, label
  semantics, comment size limits, what a posted comment actually renders as in the Jira UI).
- The real `claude`/`gemini` CLI binaries actually accept the flags `src/ai/claude.ts`/
  `src/ai/gemini.ts` construct — the plan doc's own decision #9 already found one such drift once
  (the harness's Gemini permission mechanism, written against 0.56.0, was stale against the
  installed 0.58.0) — nothing here guarantees today's flags are still right by the time you run this.
- The permission sandbox (Claude `--settings`, the Gemini TOML policy) actually blocks what it's
  supposed to when a real model is running, not just that the right flag/file gets constructed.
- Real timing — do plans/implementations actually take the durations decision #12's watchdog numbers
  assume (Gemini implementation observed at 25-40 min)? Do heartbeat/grace intervals feel right?
- The `flock -n` overlap guard actually prevents two concurrent sweeps on this machine.
- The full human experience: is the Jira comment thread actually sufficient on its own (decision
  #3's "Jira is the sole visibility surface" principle), or does it turn out you still need to open a
  worktree/log file to understand what happened?
- What actually happens on a real crash/kill/hang — restart, escalation, and the manual-recovery
  steps in `docs/headless-automation.md` — not just what the mocked-`process.kill` unit tests assert.

## Who runs this, and what I (the assistant) can/can't do here

This plan is written to be executed by a human at a terminal, largely because it requires: real Jira
credentials with write access to a board, real money/time spent on real `claude`/`gemini` CLI
invocations, and judgment calls (does this comment read well, does this diff look sane) that are the
whole point of a human watching before trusting this unattended. I can drive individual steps if
asked (reading logs, inspecting files, running a specific command) — every step below is written
literally enough for that — but I won't run this end to end unsupervised, and Phase G's failure
injection in particular involves killing real processes and should be watched live.

## Prerequisites — set these up before Phase A

- [ ] A **throwaway Jira project** you don't mind posting test comments/transitions on — not
  production. If you don't have one, create one now (Jira admin → create project; any template).
- [ ] A **throwaway git repo** (can be a fresh empty repo with a `Makefile` defining `test`/`build`,
  even trivially) with its own `.ai/intake-mcp.json` pointing at that test project.
- [ ] `claude` and/or `gemini` CLI installed and already working interactively (you've used it
  before, outside this project) — this plan is not the place to debug a first-time CLI install.
- [ ] `npm run health-check` passes (confirms `~/.config/ai-intake-mcp/.env` credentials are good).
- [ ] `npm run build` succeeds and `npm test` is fully green on the branch you're validating.

## Phase A — Environment & version recording

**Objective**: capture exactly what you tested against, so a later regression can be traced to a
version drift rather than re-discovered from scratch.

1. `claude --version` and `gemini --version` (or equivalent) — record both. If either is newer than
   what `docs/headless-automation.md`/the plan doc assumed at write time, budget extra scrutiny for
   Phase B below — this is exactly the kind of drift decision #9 already hit once.
2. `node --version` (must satisfy `package.json`'s `engines.node >= 24`).
3. Confirm the test Jira project key and the test repo's `.ai/intake-mcp.json` `appTag` — write them
   down; every later phase refers back to "the test project"/"the test repo" using these.

**Pass criteria**: all versions recorded; `health-check` and `npm test` both green.

## Phase B — Provider CLI smoke test, outside the orchestrator entirely

**Objective**: isolate "do the flags this project constructs even work with the installed CLI" from
everything else — the cheapest, fastest possible check, and the one most likely to catch version
drift before you've burned a real planning/implementation run debugging it.

1. Pick (or create) a permission profile file matching what `resolvePermissionProfilePath` would
   resolve for Claude (`~/.config/ai-intake-mcp/permissions/claude.json` — create an empty
   `{"permissions": {"deny": ["Bash(git push:*)"]}}` if you haven't populated one yet).
2. Run, literally, from a scratch directory:
   ```bash
   claude -p "Reply with exactly: OK" --settings ~/.config/ai-intake-mcp/permissions/claude.json
   ```
   **Pass**: exits 0, prints something containing "OK", no flag-parsing error.
3. Same for Gemini:
   ```bash
   gemini -p "Reply with exactly: OK"
   ```
   **Pass**: exits 0, prints something containing "OK".
4. If either fails: the fix is in `src/ai/claude.ts`/`src/ai/gemini.ts` (`buildCommand`'s
   args array) — check `--help` output from the real CLI against what's hardcoded there, fix, re-run
   `npm test`, come back to this step before continuing.

**Do not proceed to Phase E/F until this phase passes for whichever provider(s) you intend to test.**

## Phase C — Registration wizard

**Objective**: validate decision #20's collision check and the wizard flow against the real board.

1. `npm run register-project` — register the test repo. **Pass**: completes without error, prints
   "fresh tag" (or the expected classification), writes an entry to
   `~/.config/ai-intake-mcp/projects.json`.
2. Re-run `npm run register-project` on the **same** repo path. **Pass**: updates the existing entry
   (check the file — still one entry for that path, not two).
3. **Deliberately test the refusal path**: temporarily edit `~/.config/ai-intake-mcp/projects.json`
   by hand to add a second entry with a *different* `path` but pointing at a repo whose
   `.ai/intake-mcp.json` has the *same* `appTag` as your test repo (a second throwaway repo/clone is
   fine). Run the wizard against that second path. **Pass**: refuses with a clear "already claimed by
   a different registered project" message; nothing gets written. Remove the temporary entry
   afterward.

## Phase D — Dry-run validation (no live writes, no processes spawned)

**Objective**: confirm discovery/dispatch logic picks the right tickets and constructs correct
prompts, with zero risk, before anything touches the board or a wallet.

1. In the test Jira project, create three tickets by hand and label them: one `state:plan`
   `app:<your-test-tag>`, one `state:needs-input` `app:<your-test-tag>` with an old automation-style
   comment already on it, one `state:implement` `app:<your-test-tag>`.
2. Run:
   ```bash
   npm run automation-poll -- --dry-run
   ```
3. **Pass criteria**:
   - The `state:plan` ticket appears in the `[dry-run] would launch ...` output.
   - The `state:needs-input` ticket does **not** (no reply after the last automation comment yet —
     decision #18). Add a plain reply comment on it in Jira, re-run; now it **should** appear.
   - The `state:implement` ticket is picked up by the implementation dry-run path.
   - Inspect the actual rendered prompt file it logged the path to
     (`~/.config/ai-intake-mcp/state/<project>/prompts/<KEY>.md`) — confirm `{{TICKET_KEY}}`,
     `{{CONTEXT_FILE_PATH}}`, etc. were substituted with real values, no leftover `{{...}}` tokens.
   - Confirm via the Jira UI that **no comment, no label change** happened on any of the three
     tickets, and `ps aux | grep -E 'claude|gemini'` shows nothing new — dry-run must be a true no-op
     against the live board.

## Phase E — First real planning cycle, watched end to end

**Objective**: the first real, live, billed headless planning run.

1. Using the `state:plan` test ticket from Phase D, run for real:
   ```bash
   npm run automation-poll
   ```
2. **Pass**: output shows a real dispatch; `ps aux | grep -E 'claude|gemini'` shows a live process;
   a marker file exists at `~/.config/ai-intake-mcp/state/<project>/workers/<KEY>.json` with a real
   `pid`.
3. Poll `~/.config/ai-intake-mcp/state/<project>/progress/<KEY>.log` every few minutes — **pass**:
   `Done:`/`Next:` entries actually appear as the worker works (confirms decision #16's progress-log
   instruction is actually being followed by a real model, not just present in the prompt text).
4. Once the process exits (`ps` no longer shows it), run `npm run automation-poll` again — this tick
   is what actually posts the result (the watchdog pass, decision #12).
5. **Pass criteria**:
   - A commit exists in the worktree adding `.ai/plans/active/<KEY>-<slug>.md`.
   - That plan file has `## Boundaries`, `## Implementation order`, `## Testing strategy` sections,
     all non-empty (decision #17/#22's structural gates — if the real model produced a plan missing
     one, this is exactly what should trigger a watchdog retry with a correction note; verify that
     happens rather than a silent failure).
   - The full plan text was posted as a Jira comment (check it actually renders legibly in the Jira
     UI — this is the "comment size limit" risk decision #2 flagged as an open item; if it's long,
     confirm it wasn't truncated/rejected).
   - The ticket transitioned to `state:review` (no open questions) or `state:needs-input` (has some)
     — whichever matches the plan's actual `## Open Questions` content.
   - The marker file is gone.
6. **If the plan had open questions**: reply on the ticket as the "author" with an answer, run
   `npm run automation-poll` again, and confirm re-pickup (decision #18) actually refines the
   existing plan (accumulates the Q&A, doesn't regenerate from scratch) rather than starting over.

## Phase F — Approval + first real implementation cycle

**Objective**: the first real, live, billed headless implementation run — and specifically decision
#17's Status-promotion path, since that's the one branch nothing in Phase E exercises.

1. Approve the plan **by moving the Jira label directly to `state:implement`** (not via
   `approve_plan`) — this deliberately leaves the plan file's `Status: draft`, exercising the
   exact gap decision #17 closes.
2. Run `npm run automation-poll`. **Pass**: the plan file's `Status` flips `draft` → `ready` (check
   the committed file); a start comment naming the ticket/branch/worktree is posted; the ticket
   transitions to `state:working`; a real implementation process is dispatched (`ps` check again).
3. Poll the progress log as in Phase E. Wait for the process to exit — implementation can genuinely
   take 25-40+ minutes for Gemini per the plan doc's own numbers; budget real time for this, don't
   assume something's stuck just because it's slow (that's exactly decision #12's "alive PID is
   never at risk regardless of duration" design point — confirm the watchdog doesn't do anything
   drastic while it's still genuinely running).
4. Run `npm run automation-poll` again once the process has exited.
5. **Pass criteria**:
   - Real commits exist implementing the plan; the plan file moved to `.ai/plans/completed/` with
     `Status: completed`.
   - **Manually read the actual diff.** Does it match the plan's Implementation order? Did it stay
     inside `## Boundaries`? Did it actually run the declared `make` targets (check the completion
     comment's "Verify:" line against what you'd expect, and spot-check by running them yourself)?
     This is the one step in this whole plan that pure automation can never substitute for.
   - A completion comment was posted; the ticket transitioned to `state:verify`.
   - The marker file is gone.
6. **Negative case**: separately, craft a ticket/plan where implementation is expected to fail (e.g.
   a plan step with a command that will genuinely error) and confirm the blocked path: comment
   naming what happened, transition to `state:problem`, marker cleaned up — not a silent hang.

## Phase G — Failure & recovery injection (the "does the safety net actually work" phase)

**Objective**: everything above tests the happy path. This is where you find out whether the parts
that only matter when something goes wrong actually work, before trusting them unattended.

1. **Crash + restart + escalate.** Dispatch a planning run (Phase E style), then once
   `ps` shows the real process, `kill -9 <pid>` it directly — before it writes a result file. To
   make the grace/retry timing practical to actually watch, temporarily lower
   `~/.config/ai-intake-mcp/settings.json`'s `watchdog.planning.graceSeconds`/`maxAttempts` (e.g.
   `graceSeconds: 60, maxAttempts: 2`) for this test only. Run `automation-poll` repeatedly past
   each grace window.
   **Pass**: after the first grace window, the marker's `attempts` increments and a **new** real
   process is dispatched (restart) — verify via `ps` and the marker file. After `maxAttempts` is
   hit, verify an "Escalating: ..." comment posts, the marker gets `"escalated": true`, and a further
   `automation-poll` run never redispatches that ticket (planning-pass must skip escalated markers).
   Restore your real `settings.json` values afterward.
2. **Heartbeat, for real.** Similarly lower `watchdog.<phase>.heartbeatSeconds` temporarily for a
   live, still-running (not killed) worker. **Pass**: once the interval elapses, a heartbeat comment
   actually posts, composed from whatever real `Done:`/`Next:` lines the worker had appended by then
   (not a generic placeholder) — confirms decision #16 end to end with a real model's output, not
   canned test fixtures.
3. **Permission sandbox, for real.** Craft a plan step that would tempt the model to `git push` (or
   otherwise instruct it to try, as a controlled test — the ticket text itself is untrusted input
   per the headless prompts' own guardrails, so word it as a plan step, not ticket-comment
   injection). **Pass**: the push is blocked. Note in your results *which* layer blocked it — the
   worktree's `pre-push` git hook (always present, provider-independent) and/or the AI's own
   permission profile — this is useful defense-in-depth information, not a failure either way.
4. **Cron overlap guard.** With the test project registered, manually run
   `scripts/automation-poll.sh &` in the background, then immediately run it again in the
   foreground. **Pass**: the second invocation exits immediately (non-zero, no sweep output) rather
   than running a second concurrent sweep — confirms `flock -n` actually works on this machine/
   filesystem (some network filesystems don't support `flock` correctly; this is worth knowing).

## Phase H — Multi-project isolation

**Objective**: confirm decision #5's per-project concurrency caps and decision #7/#10's per-project
scoping don't leak across projects — only worth doing once Phases E/F/G pass for one project.

1. Register a second throwaway repo/test project (`npm run register-project` again).
2. Seed planning-eligible tickets in both projects simultaneously (at or near each project's own
   planning concurrency cap). Run `automation-poll`. **Pass**: each project dispatches up to its own
   cap independently — one project being at its cap never blocks the other's dispatch.
3. Set one project's registry entry to `"enabled": false` while it has an in-flight marker. Run
   `automation-poll`. **Pass**: no new dispatch happens for that project, but the watchdog still
   processes its existing in-flight worker to completion (Review Finding #8) — confirm via the
   marker disappearing and a completion comment posting despite `enabled: false`.

## Phase I — Cron soak test

**Objective**: sustained, low-attention operation — the actual target end state — over a period long
enough to surface anything that only shows up after many ticks (state leaks, unbounded log growth,
the poll script itself crashing).

1. Install the real cron entry (`crontab -e`, `*/2 * * * * /path/to/scripts/automation-poll.sh`)
   against the test project(s) only — never point this at a production repo/board for the soak test.
2. Seed a handful of tickets across different states over the run, at different times, including at
   least one you deliberately never answer (should sit correctly in `state:needs-input` for the
   whole soak, never falsely picked up) and one you answer partway through (should re-pick-up
   correctly on the next tick after your reply).
3. Let it run **at least 24 hours**, checking in periodically (not continuously) — that's the point.
4. **Pass criteria**: no duplicate dispatches for the same ticket at any point (check marker files
   never show two workers on one key); no ticket silently stuck outside an expected state for longer
   than a couple of grace/heartbeat cycles; `~/.config/ai-intake-mcp/state/` isn't obviously
   accumulating unbounded stale files (progress logs/prompts for long-completed tickets are fine to
   remain — they're an audit trail, decision #8 — but there should be no marker/lock-file leak);
   `crontab`'s own log (or `syslog`/`journalctl` depending on your system) shows no repeated crashes
   from the poll script itself.
5. Remove the cron entry when done (`crontab -e`, delete the line) unless you're intentionally
   moving straight to production use of the test project.

## Phase J — Sign-off

Go/no-go before pointing this at any real production repo or board. All boxes below should be
checked, with the corresponding phase's evidence (screenshots, comment links, log excerpts) kept
somewhere retrievable — even just this file, edited in place with results, is fine.

- [ ] Phase A: versions recorded, `health-check`/`npm test` green.
- [ ] Phase B: both CLIs' actual flags confirmed working (or: only the provider(s) you intend to use).
- [ ] Phase C: registration wizard's collision check confirmed to both allow and correctly refuse.
- [ ] Phase D: dry-run confirmed zero live side effects, correct ticket discovery, correct rendered
      prompts.
- [ ] Phase E: one full real planning cycle, comment/transition/plan-file all verified by hand.
- [ ] Phase F: one full real implementation cycle, **diff manually reviewed**, Status-promotion path
      specifically exercised.
- [ ] Phase G: crash→restart→escalate, heartbeat, permission sandbox, and flock overlap guard all
      confirmed working for real, not just in mocked tests.
- [ ] Phase H: multi-project isolation and `enabled: false` behavior confirmed.
- [ ] Phase I: 24h+ soak against the test project with no duplicate dispatch, no stuck tickets, no
      poll-script crashes.
- [ ] Every provider/CLI version actually tested is recorded (Phase A) so a future drift is
      traceable.

Only once every box is checked: register a real project, watch its first cycle the same way Phase
E/F did, and only then trust the cron job unattended against it.

## Open items this plan deliberately does not resolve

- **Multiple providers on the same ticket** (Claude for planning, Gemini for implementation, or vice
  versa) isn't exercised by name above — if you use per-phase provider labels (`ai-plan-*`/
  `ai-impl-*`) in production, add one pass through Phase E/F using a non-default profile before
  trusting that combination specifically.
- **Real comment-size limits** (Jira Cloud's actual cap) are only checked opportunistically in Phase
  E (decision #2's own noted open item) — if your plans tend to run very long, deliberately construct
  an oversized one and confirm the failure mode is a clear error, not a silent truncation or a stuck
  worker.
- This plan doesn't cover load/scale beyond a couple of concurrent tickets — decision #5's default
  cap of 3 concurrent planning tickets per project is untested above that.
