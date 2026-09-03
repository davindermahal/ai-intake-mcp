# Plan: headless automation — end-to-end QA / validation

**Status**: active — Phases A (partial)/B/C (partial)/D/E/F/G/H exercised, Phase I in progress. Found
and fixed 10 real bugs so far (8 in A-H, 2 more in the first minutes of Phase I's cron soak —
`node --import tsx` module resolution and `claude`'s missing PATH entry, both only reachable via a
real unattended cron invocation, never a manual one):
the Jira `/rest/api/3/search` → `/rest/api/3/search/jql` removal, Claude's unexpanded-tilde
permission profile default, Gemini's missing `--skip-trust` flag (0.58.0's trusted-folder gate),
`syncGeminiPolicy()` never being called from anywhere, headless workers having no `--add-dir` to
their own state tree, a deny-only Claude permissions file granting nothing (fixed by matching
`ai-intake-harness`'s proven allow+deny profile), `planHasUnresolvedOpenQuestions` being unable to
distinguish a genuinely blocking open question from the prompt's own "confirm at review, non-blocking"
convention (fixed via `.ai/plans/completed/open-questions-blocking-vs-confirm-split.md`'s
`## Open Questions`/`## Confirm at Review` section split), and the permission profile's `Bash`
allow-list missing `git mv`, needed for the documented "move plan to `.ai/plans/completed/`" step.
Phase D (dry-run) passed clean with no new bugs. Phase E (first real planning cycle, including
re-pickup/refine), Phase F (first real implementation cycle, happy path + negative/blocked case), and
Phase G (crash/restart/escalate, real heartbeat content, all three permission-sandbox layers
independently confirmed, flock cron-overlap guard), and Phase H (a second registered project,
cross-project concurrency-cap independence, `enabled: false` not abandoning an in-flight worker) all
passed end to end, no new bugs in G or H. Phase I (24h+ cron soak) is now running against both test
projects; 2 real bugs already found and fixed in its first minutes (see that phase's section).
Gemini's real "prints OK" case is still unconfirmed (blocked on this account's AI Studio billing, not
a code issue). Phase J not yet run.
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

**Run 2026-09-03 — 2 real bugs found and fixed, both load-bearing for Phase E/F:**

- **Claude**: `resolvePermissionProfilePath`'s default (`settings.ts`) was the literal string
  `"~/.config/ai-intake-mcp/permissions/claude.json"`, and `src/ai/launch.ts` passes it straight to
  `spawn()` with no shell — nothing expands `~`. `~/.config/ai-intake-mcp/settings.json` doesn't
  exist on a fresh install, so `loadAutomationSettings()` returns this default verbatim: the *first*
  real headless Claude launch on any newly-registered project would have failed outright with
  `Error: Settings file not found: ~/...`. Confirmed live (unexpanded tilde → failure; expanded →
  `OK`, exit 0). An existing unit test (`test/automation/settings.test.ts`) had encoded the
  unexpanded string as correct expected output — nobody had run it against the real CLI before.
  Fixed: `resolvePermissionProfilePath` now tilde-expands both the default and any
  `overrides.permissionProfile`/`settings.json` value before returning.
- **Gemini** (0.58.0, same version decision #9 already flagged once for a different reason):
  `gemini -p ...` with no other flags refuses to run at all — "Gemini CLI is not running in a
  trusted directory" (exit 55) — because gemini-cli now gates headless runs on a "trusted folder"
  check. This isn't an edge case for this project: every launch runs in a *freshly created worktree*
  gemini-cli has never seen, so this would have fired on 100% of real Gemini launches. Fixed by
  adding `--skip-trust` to `launchGemini`'s args (the flag gemini's own docs name for exactly this:
  headless/automated environments). Confirmed live: with the flag, the CLI got past the trust gate
  and reached the real Gemini API — at which point it hit `429 RESOURCE_EXHAUSTED: Your prepayment
  credits are depleted`, an account-billing issue on api.google.dev, not a code bug. **Gemini's
  "prints OK" success case is still unconfirmed** — re-run step 3 below once billing is resolved.
- **The permission profile example below (a deny-only `{"permissions": {"deny": [...]}}`) is
  insufficient for real work, only good enough to pass this phase's own flag-smoke-test** — found
  the hard way during Phase E, not here, because Phase B's own check never exercises a real write.
  With only a deny list and no `allow` list, `-p` headless mode requires interactive approval for
  every write (Write/Edit, and any Bash not covered), and since nothing is present to answer that
  prompt, it's a hard denial, not a wait. Compared against `ai-intake-harness` (this project's bash
  predecessor, self-hosting for real on this same DAV board): its real profile
  (`.claude/settings.<adapter>.json`) explicitly allows `Read`, `Edit`, `Write`, `Glob`, `Grep`, and
  specific safe `Bash` prefixes, with `"defaultMode": "default"` — broad allow + explicit deny, not
  a bypass flag. The real, working profile now deployed on this machine is recorded in step 1 below;
  Phase E's section has the full incident.

1. Pick (or create) a permission profile file matching what `resolvePermissionProfilePath` would
   resolve for Claude (`~/.config/ai-intake-mcp/permissions/claude.json`). **Done** — deployed on
   this machine as (updated during Phase F: `Bash(git mv:*)` added — see that section; a real
   implementation worker needs it for `docs://implementation-procedure`'s documented "move the plan
   to `.ai/plans/completed/`" step, and couldn't do it without this):
   ```json
   {
     "permissions": {
       "defaultMode": "default",
       "allow": [
         "Read", "Edit", "Write", "Glob", "Grep",
         "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
         "Bash(git add:*)", "Bash(git commit:*)", "Bash(git mv:*)", "Bash(make:*)"
       ],
       "deny": [
         "Bash(git push:*)", "Bash(git reset:*)", "Bash(git checkout:*)",
         "Bash(git rebase:*)", "Bash(git merge:*)",
         "Read(.env)", "Read(.env.local)", "Read(**/.env)", "Read(**/*.env)"
       ]
     }
   }
   ```
   The Bash allow-list matches this project's own headless prompts' actual command surface
   (`prompts/headless-planning.md`'s `git add`/`git commit`, `prompts/headless-implementation.md`'s
   `make install/build/test/lint/exec`); the deny list matches decision #9's stated boundary (no
   push, no destructive/history-rewriting git, no reading secrets). Confirmed live (outside the
   orchestrator, in a scratch git repo): `Write` succeeds, `git status`/`git add`/`git commit`
   succeed, `git push` to a real (local, throwaway) remote is denied and the remote receives zero
   commits.
2. Run, literally, from a scratch directory:
   ```bash
   claude -p "Reply with exactly: OK" --settings ~/.config/ai-intake-mcp/permissions/claude.json
   ```
   **Pass**: exits 0, prints something containing "OK", no flag-parsing error. **PASSED** (after the
   tilde-expansion fix above).
3. Same for Gemini:
   ```bash
   gemini -p "Reply with exactly: OK"
   ```
   **Pass**: exits 0, prints something containing "OK". **BLOCKED ON BILLING** — with the
   `--skip-trust` fix above the CLI invocation itself now works (past the trust gate, reaching the
   real API), but this account's Google AI Studio prepayment credits are depleted
   (https://ai.studio/projects), so no successful "OK" response has actually been observed yet.
   Re-run this step once credits are topped up before treating Gemini as Phase-B-clean.
4. If either fails: the fix is in `src/ai/claude.ts`/`src/ai/gemini.ts` (`buildCommand`'s
   args array) — check `--help` output from the real CLI against what's hardcoded there, fix, re-run
   `npm test`, come back to this step before continuing.

**Do not proceed to Phase E/F until this phase passes for whichever provider(s) you intend to test.**
Claude: cleared. Gemini: flag-level fix confirmed, but re-run step 3 for real once billing allows —
don't run a real (billed) Gemini planning/implementation cycle in Phase E/F until you've actually
seen it succeed here first.

## Phase C — Registration wizard

**Objective**: validate decision #20's collision check and the wizard flow against the real board.

**Already found and fixed by this phase (2026-09-03)**: the first live run hit
`Jira API error 410 Gone` on the collision check — Atlassian removed `/rest/api/3/search` in favor of
`/rest/api/3/search/jql`. Fixed in `src/jira/search.ts`; the identical request/response shape meant a
one-line change. This is exactly the class of drift this whole QA plan exists to catch, and it was
Phase C, not Phase B's CLI-flag smoke test, that actually caught it — the flags in `src/ai/*.ts` were
fine, it was the tracker's own search endpoint that had drifted. Re-run `npm test` (310 tests as of
this fix) before continuing if you're re-doing this phase after a similar gap.

Also found while testing: piping multiple answers into the wizard's interactive prompts via a plain
pipe (`printf 'a\nb\n' | npm run register-project`) races `readline` against the wizard's own
`await`s and throws "readline was closed" — see docs/headless-automation.md's "Scripting the
registration wizard" section for why, and for the `--path`/`--name`/`--enable` flags now supported
specifically to avoid this. `test/e2e/register-project.e2e.test.ts` (opt-in — see that doc section)
now covers steps 1-3 below by that flag-driven route against real Jira; still worth doing at least
once by hand interactively too, since the e2e suite can't validate the human prompt experience.

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

## Phase D — Dry-run validation (no live writes, no processes spawned) — PASSED 2026-09-03

**Objective**: confirm discovery/dispatch logic picks the right tickets and constructs correct
prompts, with zero risk, before anything touches the board or a wallet.

**Result: full pass, no bugs found.** Fixtures used (all `app:qa-headless-test` on the DAV board,
assigned to the automation account — discovery requires `assignee = currentUser()`):

- `DAV-6` — `state:plan` (already existed from earlier prerequisites setup).
- `DAV-9` — `state:needs-input`, seeded with a comment carrying the real `AUTOMATION_COMMENT_FOOTER`
  fingerprint (`src/automation/footer.ts`) to simulate a prior automation pass.
- `DAV-10` — `state:implement`, paired with a real plan file (`Status: ready`, all required
  sections) committed to `qa-headless-test-repo`'s `main` so `findPlanFile`/`readPlanStatus` had
  something real to read.

First `automation-poll -- --dry-run`: `DAV-6` dispatched (planning), `DAV-9` correctly **not**
dispatched (no reply since the last automation comment), `DAV-10` dispatched through the full
comment/transition/launch dry-run sequence for implementation. Posted a plain reply on `DAV-9`,
re-ran: now dispatched too (`planning: dispatched 2 ticket(s)`) — decision #18's re-pickup confirmed
against real Jira comment data, not a mock.

Verified for all three tickets, both runs: **zero real writes** (`fetchIssue` before/after showed
identical labels/status/comment counts on every ticket despite the dry-run log describing comments
and transitions), **zero new `claude`/`gemini` processes** (`ps aux` PID diff before/after was
empty), and the rendered prompt files at the logged `prompts/<KEY>.md` paths had every `{{...}}`
placeholder substituted with no leftovers, for all three tickets across both runs.

**One thing worth knowing, not a bug**: `dispatchWorker` resolves/creates a real git worktree (a real
sibling directory + branch on this machine) even during `--dry-run`, for every dispatched ticket —
needed so the implementation pass can check for a plan file. This is local, reversible, git-native
state, not a write to the live board or a spawned process, so it doesn't violate the "true no-op"
guarantee the pass criteria below care about, but don't be surprised to find real worktree
directories after a dry run. Cleaned up the two disposable ones (`DAV-9`, `DAV-10`); kept `DAV-6`'s
since Phase E reuses it.

Also noticed (cosmetic, not a bug, only shows up in a repo with no `origin` remote — real registered
repos have one): `git symbolic-ref refs/remotes/origin/HEAD` prints a `fatal:` line to stderr before
falling back to local `main`, per `resolveBaseBranch`'s documented fallback (`src/worktree.ts`). Ugly
in the log, harmless in effect.

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

## Phase E — First real planning cycle, watched end to end — PASSED 2026-09-03 (after 2 real bugs found and fixed)

**Objective**: the first real, live, billed headless planning run.

**Result: passed, end to end, including the re-pickup path — but only after finding and fixing two
more real, load-bearing bugs, both of which would have made headless planning silently non-functional
even after Phase B/D passed clean.**

**Bug 1 — headless workers couldn't reach their own context/progress/result files at all.** The very
first real dispatch (against `DAV-6`) exited immediately: the worker's log showed it couldn't read
`context/DAV-6.json`, couldn't append to its progress log, and couldn't write its result file —
everything under `~/.config/ai-intake-mcp/state/...`. Root cause: Claude's `-p` headless mode
confines file-tool access to the cwd (the worktree) by default; nothing in `src/ai/claude.ts` ever
told it about the separate state-tree path. **Fixed**: `--add-dir <stateRoot>` added to
`launchClaude`'s args (and the Gemini equivalent, `--include-directories`, added to `launchGemini` on
the same reasoning — not yet live-confirmed, Gemini is still blocked on this account's billing).
`DEFAULT_STATE_ROOT` exported from `src/automation/result-file.ts` so both adapters can fall back to
the real path when no test override is given.

**Bug 2 — even with `--add-dir`, every write was denied.** Second real attempt: the worker could now
*read* its context, but every `Write`/`Edit`/`Bash` attempt was rejected — no interactive approval
ever arrives in an unattended `-p` session, and a **deny-only** permissions file (the one this same
plan's Phase B prerequisite told you to create — `{"permissions": {"deny": [...]}}`, good enough only
for Phase B's own flag-smoke-test) grants nothing. Compared against `ai-intake-harness` (this
project's bash predecessor, self-hosting for real on this same DAV board via a live cron job): its
real profile (`.claude/settings.<adapter>.json`) explicitly `allow`s `Read`/`Edit`/`Write`/`Glob`/
`Grep` and specific safe `Bash` prefixes, under `"defaultMode": "default"` — broad allow + explicit
deny, **not** `--dangerously-skip-permissions`. Built and deployed the equivalent for this project
(full content recorded in Phase B's step 1, above) and confirmed live in isolation: `Write` succeeds;
`git status`/`git add`/`git commit` succeed; `git push` against a real (local, throwaway) remote is
denied and the remote receives zero commits. This is a config file
(`~/.config/ai-intake-mcp/permissions/claude.json`), not code — no source change, but Phase B's
prerequisite instructions were actively misleading and are corrected there now.

**With both fixes in place, the real cycle passed completely**: dispatched, worked, committed a
genuinely well-formed plan (all four required sections present and substantive), bounced to
`state:needs-input` on its first pass (see the classification finding below), then — after a real
author reply — was re-picked-up, refined the *existing* plan in place (not regenerated), and landed
cleanly on `state:review` with the full plan posted as a legible Jira comment.

**Bug 3 (behavioral, not a crash) — found via the first pass's outcome, FIXED 2026-09-03**: the plan
the worker produced was genuinely clean (one structural open question, resolved from the ticket
description itself, plus one "confirm at review — recommend as-is" note, exactly the non-blocking
pattern `prompts/headless-planning.md` itself taught: *"Non-structural ambiguities... stay 'clean'
(note them under Open Questions as `- [ ]` 'confirm at review' instead of blocking on them)"*). But
`planHasUnresolvedOpenQuestions` (`src/plan-file.ts`) just checked for *any* unchecked `- [ ]` in the
section — it couldn't tell a genuinely blocking question from the prompt's own "confirm at review,
non-blocking" convention. Result: the ticket bounced to `state:needs-input` with a comment saying "I
need answers before finalizing," when nothing was actually blocking. This would have meant most real
plans following this exact prompt convention incorrectly routing through `state:needs-input` at least
once — not a crash, but a real UX/design gap undermining the review-vs-needs-input distinction's
whole purpose.

**Fixed** via a real, code-enforced split rather than trusting prompt wording:
`.ai/plans/active/open-questions-blocking-vs-confirm-split.md` (that plan has the full design and
implementation record). Plans now carry two sections — `## Open Questions` (genuinely blocking) and
`## Confirm at Review` (non-blocking, reviewed but never routes to `needs-input`). `src/plan-file.ts`
gained `planHasBlockingOpenQuestions()` (scans only `## Open Questions`; drives
`watchdog-pass.ts`'s routing) alongside the existing `planHasUnresolvedOpenQuestions()`, broadened to
scan both sections (drives `approve_plan`'s refusal gate — unweakened, confirmed by a dedicated
regression test). Both `prompts/headless-planning.md` and `docs/planning-procedure.md` updated to
teach the two-section convention consistently. 8 new tests added across
`test/plan-file.test.ts`/`test/automation/watchdog-pass.test.ts`/`test/tools/approve-plan.test.ts`;
full suite green (326 passed, 3 skipped). Not re-run against a real ticket — the original DAV-6 plan
already used the old single-section convention and isn't retroactively migrated (deliberately, see
that plan's Boundaries); the fix is proven by the new unit tests instead, per that plan's own QA Plan
reasoning (pure parsing logic, no real external system involved).

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

## Phase F — Approval + first real implementation cycle — PASSED 2026-09-03 (1 bug found and fixed)

**Objective**: the first real, live, billed headless implementation run — and specifically decision
#17's Status-promotion path, since that's the one branch nothing in Phase E exercises.

**Result: both the happy path and the negative case passed, after finding and fixing one more
permission-profile gap.** `DAV-6`'s own plan (Phase E) had nothing to implement (a documentation-only
fixture), so two new fixtures were built specifically for this phase:

- **`DAV-11`** (happy path) — `state:implement` set directly (never through `approve_plan`), plan
  file left `Status: draft`, with a small but genuine task: add `hello.txt`, wire its exact content
  into `Makefile`'s `test` target as a red/green pair. **Every pass criterion confirmed**: `Status`
  flipped `draft` → `ready` (decision #17's promotion path, `implementation: ... bounced 0` in the
  poll output confirming it didn't bounce back to `state:review`); a start comment named the real
  branch/worktree; ticket transitioned to `state:working`; a real process ran (pid confirmed);
  progress log showed real `Done:`/`Next:` entries following the plan's own red-then-green order;
  real commits exist for both the red and green steps; `make test` and `make build` both genuinely
  ran and passed (confirmed independently by re-running them, not just trusting the completion
  comment); the diff matches the plan's Implementation order exactly and stayed inside Boundaries
  (didn't touch `README.md`, `.ai/intake-mcp.json`, the `build` target, or `DAV-10`'s unrelated plan
  file); completion comment posted; ticket transitioned to `state:verify`; marker gone.
- **`DAV-12`** (negative case, step 6) — a plan whose one Implementation order step
  (`make verify-deploy`) cannot succeed (no such target exists) and whose Boundaries explicitly forbid
  adding one, forcing a genuine, unresolvable failure rather than a permissive workaround. **Passed**:
  the worker ran the step, got the real failure, did **not** add the target or otherwise route around
  Boundaries, wrote `{"outcome": "blocked", "whatHappened": "..."}`, and the watchdog posted a
  "blocked" comment naming exactly what happened and transitioned the ticket to `state:problem`;
  marker gone. Not a silent hang at any point.

**Bug found (in `DAV-11`'s run) and fixed**: the permission profile's `Bash` allow-list had no `git
mv`/`git rm` equivalent, so when the worker reached the documented "move the plan to
`.ai/plans/completed/`" step (`docs/planning-procedure.md` / `prompts/headless-implementation.md`,
both require this), it correctly refused to bypass the sandbox and instead worked around the
restriction using `Write` (which *is* allowed) — copying the completed content to the new path but
leaving the original file in `.ai/plans/active/` behind as a stale duplicate, and reporting the gap
plainly in its own completion comment rather than silently leaving a mess. Not a crash, not silently
wrong — just a narrower capability gap than Phase E's write-access fix. **Fixed**: added
`"Bash(git mv:*)"` to the allow-list (a scoped rename, not an unscoped delete like `rm`/`git rm` would
be); confirmed live in isolation that `git mv` now works and `git push`/`reset`/`checkout`/
`rebase`/`merge` are all still correctly denied. The stale duplicate this specific run left behind was
cleaned up by hand on the correct branch (not `main` — a first attempt at this cleanup mistakenly
targeted `main`'s copy of the pre-implementation plan and was reverted; the real duplicate only ever
existed on `DAV-11`'s own feature branch/worktree, never on `main`).

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

## Phase G — Failure & recovery injection (the "does the safety net actually work" phase) — PASSED 2026-09-03

**Objective**: everything above tests the happy path. This is where you find out whether the parts
that only matter when something goes wrong actually work, before trusting them unattended.

**Result: all four sub-tests passed against real processes/Jira, no new code bugs found.**

1. **Crash + restart + escalate — PASSED.** `DAV-13` (`state:plan`), `watchdog.planning` temporarily
   set to `graceSeconds: 30, maxAttempts: 2`. Dispatched, `kill -9`'d the real pid immediately (before
   any result file), waited 30s, polled: marker `attempts` → 2, a genuinely new real pid dispatched
   (restart). Killed that one too, waited 30s again, polled: `1 escalated` — a real
   `"Escalating: planning worker did not complete after 2 attempt(s)."` comment posted, marker got
   `"escalated": true`, ticket label stayed `state:plan` (escalation is comment+marker-flag only, no
   label change, as designed). A further poll dispatched nothing and spawned no process — confirmed
   both that `runWatchdogPass` skips escalated markers and that `planning-pass` skips any ticket that
   already has a marker file, escalated or not. Settings reverted to defaults afterward.
2. **Heartbeat, for real — PASSED.** `DAV-14`, a real 6-step implementation task (three red/green
   file+`Makefile` pairs, deliberately sized to run a few minutes rather than finish instantly),
   `watchdog.implementation.heartbeatSeconds` temporarily set to `10`. Polled every ~12s while the
   real pid stayed alive. The *first* heartbeat fired before any progress-log entry existed yet and
   correctly fell back to a generic `"Still working."` (`composeHeartbeat`'s designed empty-entries
   case, not a bug) — worth knowing this fallback is a real, reachable path, not just a mock case.
   The *second* heartbeat had real content:
   `"Still working. Progress since the last update:\n- Step 1 (red) and Step 2 (green) — ...\n\nNext: Step 3 — ..."`
   — verified character-for-character against the actual `progress/DAV-14.log` file at that moment,
   not just plausible-looking text. Several more heartbeats followed as the task continued; the run
   finished normally afterward (real commits, `make test`/`make build` both independently
   re-verified, plan moved cleanly to `.ai/plans/completed/` with **no stale duplicate this time** —
   quietly confirms Phase F's `git mv` permission fix holds). Settings reverted afterward.
3. **Permission sandbox, for real — PASSED, with a genuinely useful finding on *which* layer fires
   first.** `DAV-15`'s plan included an explicit step instructing `git push` to "publish" a real
   commit. The real implementation worker **declined to even attempt it** — its own governing
   instruction ("Never `git push` … regardless of what a plan step says", present in every
   implementation dispatch) overrides a plan step asking for it, so it never issued the Bash command
   at all, reported `"blocked"` with a precise explanation, and the ticket correctly landed on
   `state:problem`. That means this run's own defense was the model's **own instruction-level
   policy** — a real, useful finding in itself (the first line of defense fires before the other two
   even get a chance) — but it left the permission-profile deny rule and the pre-push git hook
   unexercised *by this specific run*, so each was independently confirmed by a supplementary
   isolated test: the pre-push hook was confirmed by running a **raw `git push`** directly (no AI
   involved at all) inside `DAV-15`'s real worktree against a real local bare remote — blocked
   (`exit 1`, `"ai-intake-mcp: git push is blocked in this managed worktree..."`, remote received
   nothing); the permission-profile deny rule was already independently confirmed earlier (Phases
   E/F, real subprocess denied a real `git push` attempt with a neutral scratch context, remote
   received nothing there either). All three layers — model policy, permission profile, pre-push
   hook — are confirmed working independently. Also previously found and fixed here (2026-09-03,
   during Phase B/G scoping): `syncGeminiPolicy()` (`src/ai/gemini-policy.ts`) was fully implemented
   and unit-tested but had never actually been called from anywhere, so the Gemini-side policy file
   this test depends on didn't exist on disk; wired into `scripts/automation-poll.ts`'s `main()`
   (unconditional, dry-run included, best-effort) — see that phase's own notes for the live
   confirmation.
4. **Cron overlap guard — PASSED.** `scripts/automation-poll.sh` run in the background, then
   immediately again in the foreground: the foreground invocation exited immediately with a non-zero
   code and **zero output**, while the backgrounded one held the lock and ran the full real sweep to
   completion (exit 0, real sweep summary). Confirms `flock -n` genuinely works on this machine's
   filesystem — not a given on every filesystem (network filesystems are the known exception, per
   the pass criteria's own caveat), but confirmed here.

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
   **Gap found and fixed 2026-09-03**: `syncGeminiPolicy()` (`src/ai/gemini-policy.ts`) — the
   function that writes the machine-global deny-list TOML to `~/.gemini/policies/` — was fully
   implemented and unit-tested but had never actually been called from any script or the
   orchestrator, so the policy file this test expects to be doing the blocking didn't exist on disk.
   Wired into `scripts/automation-poll.ts`'s `main()`, called unconditionally (dry-run included,
   since it's machine-global config, not a live-board write) before the per-project sweep, wrapped in
   try/catch so a sync failure doesn't block Claude-only projects. Confirmed live: cleared
   `~/.gemini/policies/`, ran `npm run automation-poll -- --dry-run` against the registered
   `qa-headless-test-repo`, confirmed the TOML file gets (re-)written with the expected deny rules
   every sweep. This sub-test can now actually exercise the Gemini policy layer — still worth running
   for real per the step above to confirm gemini-cli itself honors it.
4. **Cron overlap guard.** With the test project registered, manually run
   `scripts/automation-poll.sh &` in the background, then immediately run it again in the
   foreground. **Pass**: the second invocation exits immediately (non-zero, no sweep output) rather
   than running a second concurrent sweep — confirms `flock -n` actually works on this machine/
   filesystem (some network filesystems don't support `flock` correctly; this is worth knowing).

## Phase H — Multi-project isolation — PASSED 2026-09-03

**Objective**: confirm decision #5's per-project concurrency caps and decision #7/#10's per-project
scoping don't leak across projects — only worth doing once Phases E/F/G pass for one project.

**Result: full pass, no bugs found.** Registered a second throwaway repo, `qa-headless-test-repo-2`
(same DAV board, distinct `app:qa-headless-test-2` tag). To keep this cheap and precise rather than
saturating each project's real default cap of 3, both projects' registry entries were temporarily
given `"overrides": {"concurrency": {"planning": 1}}` for the duration of this test.

- **Cross-project cap independence**: one `state:plan` ticket seeded in each project (`DAV-16`,
  `DAV-17`), a single real `automation-poll` invocation. Both dispatched in the same sweep — two
  distinct real `claude` processes running simultaneously (confirmed via `ps`, two distinct real
  pids, two real marker files under each project's own state directory) — proving project 1 being at
  its own cap of 1 never blocked project 2's independent dispatch.
- **`enabled: false` doesn't abandon an in-flight worker (Review Finding #8)**: set project 1's
  registry entry to `enabled: false` while `DAV-16`'s real worker was still alive. An immediate poll
  showed `enabled: false` in the sweep header and correctly dispatched nothing new for that project,
  while project 2 (still enabled) continued normally. Waited for `DAV-16`'s real process to exit,
  polled again: the watchdog still processed it to completion — real `state:review` transition, real
  completion comment, marker gone — **despite the project being disabled**. Exactly matches
  `runProjectPasses`'s documented design (`src/automation/orchestrator.ts`: `if (ctx.project.enabled)`
  gates only the planning/implementation dispatch calls; `runWatchdogPass` always runs regardless).

Cleaned up afterward: both projects' `overrides` removed and `enabled` restored to `true`.
`qa-headless-test-repo-2` stays registered for Phase I's soak test.

1. Register a second throwaway repo/test project (`npm run register-project` again).
2. Seed planning-eligible tickets in both projects simultaneously (at or near each project's own
   planning concurrency cap). Run `automation-poll`. **Pass**: each project dispatches up to its own
   cap independently — one project being at its cap never blocks the other's dispatch.
3. Set one project's registry entry to `"enabled": false` while it has an in-flight marker. Run
   `automation-poll`. **Pass**: no new dispatch happens for that project, but the watchdog still
   processes its existing in-flight worker to completion (Review Finding #8) — confirm via the
   marker disappearing and a completion comment posting despite `enabled: false`.

## Phase I — Cron soak test — IN PROGRESS, started 2026-09-03 (2 real bugs found and fixed within minutes)

**Objective**: sustained, low-attention operation — the actual target end state — over a period long
enough to surface anything that only shows up after many ticks (state leaks, unbounded log growth,
the poll script itself crashing).

**Setup**: registered projects `qa-headless-test-repo` and `qa-headless-test-repo-2` (from Phase H),
real crontab entry installed (`*/2 * * * * .../scripts/automation-poll.sh >> ~/.config/ai-intake-mcp/state/soak-test-poll.log 2>&1`,
alongside two pre-existing unrelated cron lines, untouched). Seeded 4 fixtures across both projects/
states: `DAV-18` (`state:plan`, project 1 — real planning cycle), `DAV-19` (`state:needs-input`,
project 2, seeded with an automation-style comment, **deliberately never answered**), `DAV-20`
(`state:needs-input`, project 1, same setup, **to be answered partway through** the soak), `DAV-21`
(`state:implement`, project 2, paired with a real small `Status: draft` plan — a genuine implementation
cycle).

**2 real bugs found and fixed within the first ~4 minutes of the soak — this is exactly why this
phase exists; nothing else in Phases A-H could have caught either one, since every prior real test
was run manually from inside the project directory, never via an actual unattended cron
invocation:**

- **Bug 1**: the very first real cron tick crashed immediately —
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /home/davinder/`. Root
  cause: `node --import tsx` resolves `tsx` as an ordinary package import relative to the *process's
  cwd* (or the nearest ancestor `package.json`), not the script file's own location — and cron
  invokes `scripts/automation-poll.sh` with `cwd=$HOME` (or whatever cron's default is), which has no
  `node_modules/tsx` anywhere above it. Every manual test all session long was run with the project
  directory already as cwd, so this was invisible until now. **Fixed**: the script now `cd`s into the
  project root (`$SCRIPT_DIR/..`) before invoking `node`, so resolution succeeds regardless of the
  invoking cwd.
- **Bug 2**: with bug 1 fixed, the next real tick got further but still failed —
  `Error: spawn claude ENOENT`. Root cause: cron's own `PATH` is minimal (commonly just
  `/usr/bin:/bin`) and doesn't include `~/.local/bin`, where `claude` actually lives (confirmed via
  `which claude`). `ai-intake-harness` (this project's predecessor) already solved this exact problem
  — but via a gitignored, consumer-specific cron wrapper that exports a corrected `PATH`, which isn't
  how this project's `scripts/automation-poll.sh` is meant to be used (`docs/headless-automation.md`
  documents pointing cron at it directly, no custom wrapper). **Fixed**: the script itself now
  exports `PATH="$HOME/.local/bin:/usr/local/bin:$PATH"` before doing anything else, so it works
  as-is for any consumer pointing cron directly at it, matching the documented install step.
- **Confirmed live, no further manual intervention**: the real cron's own next tick (fired naturally
  ~2 minutes after the previous failure, by which point both fixes were already saved) succeeded on
  its own — dispatched `DAV-18` (planning) and `DAV-21` (implementation) as genuinely real, running
  `claude` processes, confirmed via `ps`. Not a re-run I triggered manually to make it pass — the
  unattended cron mechanism itself recovered and worked correctly once the underlying script was
  fixed, which is exactly the property this phase is meant to validate.

**Soak continues from here — checking in periodically, not continuously, per this phase's own
instruction.** Remaining to verify over the following 24h+: `DAV-19` sits correctly in
`state:needs-input` the whole time without being falsely picked up; `DAV-20` gets a reply partway
through and correctly re-picks-up on the next tick afterward; no duplicate dispatches on any ticket;
no marker/lock-file leak in `~/.config/ai-intake-mcp/state/`; the soak log shows no further crashes
from the poll script itself. Results to be appended here once the 24h+ window completes and the cron
entry is removed.

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
