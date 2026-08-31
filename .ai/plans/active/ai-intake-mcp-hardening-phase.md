# Plan: `ai-intake-mcp` — hardening phase (guardrails + coverage gaps)

**Status**: ready
**Created**: 2026-08-30
**Updated**: 2026-08-30
**Related**: `.ai/plans/active/ai-intake-mcp-implementation-phase.md` (decision #10, "explicitly out of
scope" — revisited here; "Remaining open" — the two items resolved here), `.ai/plans/draft/scope-out-enforcement.md`
(deliberately **not** touched by this plan — stays a separate draft), `docs/planning-procedure.md`,
`docs/implementation-procedure.md`, `docs/setup.md`, `src/plan-file.ts` (`planHasBoundariesSection`,
the precedent this plan's new gates follow), `src/tools/implement-ticket.ts`,
`src/tools/tracker-transition.ts`, `src/worktree.ts`

## Goal

Close four concrete gaps a 2026-08-30 readiness review surfaced in this project's own guardrails and
test coverage — everything **except** `Scope` → "Out" enforcement, which stays in
`.ai/plans/draft/scope-out-enforcement.md` for later, per explicit instruction:

1. No code-level prevention of `git push`/local merge during a session (decision #10 of the
   implementation-phase plan — explicitly deferred there, revisited now).
2. `approve_plan` doesn't check the plan file's `Open Questions` for anything still unresolved
   before allowing `state:review → state:implement` (flagged "Remaining open" in the
   implementation-phase plan).
3. Ambiguous handling when a declared `make` target genuinely doesn't apply to a project (also
   flagged "Remaining open" there).
4. Test coverage gaps — 13 of 19 `src/` files have no dedicated test file.

Each is a **code-level** guardrail in the same spirit as `planHasBoundariesSection` (structural,
checked in code, not left to an executor's good judgment) — but two of the four (#1, #3) hit the
same architectural wall the Scope-Out draft names: this MCP server never intermediates the
executor's raw shell commands, so enforcement can only happen where the code already has a
checkpoint (a git hook installed ahead of time, or a tool call the procedure already requires). Where
that wall means something genuinely can't be closed in code, this plan says so plainly rather than
overselling a partial fix.

## Core design decisions

### 1. Push/merge block — per-worktree git hook, not a settings snippet

**Decided** (developer, 2026-08-30): use git's own per-worktree hook mechanism, not the existing
opt-in `settings.json` deny-list (`docs/setup.md` §7) — that snippet only works for hosts with a
Claude-Code-style permission system and is easy for a weaker/less-compliant executor to never have
enabled in the first place. A git hook fires regardless of which agent CLI invoked the command.

Mechanics:
- Enable `extensions.worktreeConfig` once per repo (idempotent check-then-set) — required for
  `core.hooksPath` to be settable per-worktree rather than repo-wide.
- `worktreeCreate` (`src/worktree.ts`) writes `pre-push` and `pre-merge-commit` scripts into that
  worktree's **private git dir** (e.g. under `git rev-parse --git-dir`'s `hooks-block/` — *not* the
  tracked working tree / not under `.ai/`, so the hook scripts never get committed onto the ticket
  branch), marks them executable, and sets `core.hooksPath` with `--worktree` scope to that absolute
  path. Applied uniformly to every worktree this server creates (planning sessions too, not just
  implementation) — planning is also told never to push.
- Both hooks always exit non-zero with a message pointing at the manual-push/merge workflow
  (`docs/usage.md`).
- Idempotent: re-running `worktreeCreate` against an already-existing worktree re-checks/reinstalls
  the guard rather than assuming it's still there.
- No teardown code needed in `worktree_remove` — the private git dir (and the hook scripts in it) is
  deleted automatically by `git worktree remove`.

**Known, permanent limitations (document, don't hide):**
- `pre-merge-commit` only fires for a merge that creates a merge commit. A **fast-forward** local
  merge creates no commit and never invokes it. `git merge --squash` doesn't invoke it either.
- Neither hook can reach a **remote-side** merge (`gh pr merge`, the GitHub UI) — that was never a
  local git operation, so no local hook, in this design or any other, can intercept it. This is the
  same category of limitation `docs/setup.md` already admits for push today; the git-hook approach
  narrows it (push itself is now actually blocked, not just discouraged) but doesn't erase it.
- Update `docs/implementation-procedure.md`'s "Hard limits" bullet (`git push`... "no code-level way
  to enforce this") — no longer fully true; rewrite precisely: push and local non-fast-forward merge
  are now blocked in code, remote-side merge/PR-merge is not and cannot be.
- Retire `docs/setup.md` §7's manual `git push`/`git merge` deny-list example — superseded by the
  automatic hook; note the change so nobody thinks they still need to configure it by hand.

### 2. `approve_plan` blocks on unresolved Open Questions — task-list checkbox convention

**Decided** (developer, 2026-08-30): enforce it. Needs a content convention `approve_plan` can parse
without a full markdown parser:

- `docs/planning-procedure.md`'s "Plan file shape" gains: `## Open Questions` items are written as
  GitHub-style task-list items — `- [ ]` for still-open, `- [x]` for resolved. Folding a developer's
  answer back into the plan on re-pickup (§2's existing "accumulate, don't overwrite" rule) means
  flipping `[ ]` → `[x]` in place, not deleting the line — keeps the audit trail, consistent with how
  this project's own plans already keep a separate "Resolved" record rather than erasing history.
- New `planHasUnresolvedOpenQuestions(planPath): boolean` in `src/plan-file.ts`, same shape as
  `planHasBoundariesSection` — true if any `- [ ]` line exists under the `## Open Questions` heading.
- Wired into `approvePlanTool` (`src/tools/approve-plan.ts`): check plan-file content (status, then
  this) before any Jira call, same cheap-check-first ordering the existing `draft`-status check
  already uses.

### 3. Make-target ambiguity — a structured `skipTargets` field, with an honest limit on what it proves

**Decided** (developer, 2026-08-30): require explicit declaration rather than silent skip. But: no
code in this server currently runs a project's `make` targets at all — that happens entirely via the
executor's own raw shell access, following `docs/implementation-procedure.md` §4. So "the agent
silently decided a target doesn't apply" **cannot** be caught by watching for the target having run
(there's nothing to watch) — the only thing checkable in code is a **static consistency check**
against the one piece of real, inspectable state: the project's own `Makefile`.

Design:
- `.ai/intake-mcp.json` (already structured and code-read, decision #3 of the on-demand-planning
  plan — this doesn't touch `.ai/intake-mcp.md`'s deliberately schema-less prose) gains an optional
  `skipTargets: string[]`, restricted to the subset of `install`/`build`/`test`/`lint` (`exec` is a
  generic passthrough, not a fixed convention target, so skip doesn't apply to it).
- A small Makefile target-name parser (new, e.g. `src/makefile.ts`) reads the worktree's `Makefile`
  and extracts defined target names via a simple rule-line regex.
- At the same checkpoint as the git-hook verification (a real `tracker_transition(state: "verify")`
  call), cross-check: if any name in `skipTargets` is actually defined in the Makefile, refuse the
  transition — that's a real, catchable contradiction (the agent both wrote/found a target for it
  and separately claimed to skip it, likely stale or wrong).

**Explicit, permanent limitation:** this closes the "claimed-skip contradicts an existing target"
case only. It **cannot** verify that a target which does exist was actually executed and passed —
that remains entirely dependent on the executor honestly following `docs://implementation-procedure`
§4, the same category of trust gap the Boundaries/Scope-Out guardrails already live with. Don't
present this phase as closing that larger gap; it doesn't.

### 4. Full test coverage of the remaining 13 `src/` files

Grouped by how testable they actually are:

- **Straightforward pure-function tests** — `src/config.ts` (env-var loading/validation),
  `src/footer.ts` (comment-footer string formatting), `src/jira/adf.ts` (markdown → Atlassian
  Document Format conversion): standard input/output unit tests, no new pattern needed.
- **Mocked-fetch tool tests, same pattern as `test/tools/approve-plan.test.ts`** —
  `src/tools/tracker-get-issue.ts`, `src/tools/tracker-add-comment.ts`,
  `src/tools/worktree-remove.ts`, `src/tools/write-repo-config.ts`, `src/tools/health-check.ts`, and
  `src/tools/tracker-transition.ts` (beyond the new case decision #3 adds).
- **`src/jira/auth-cookie.ts`** — flagged as "inherently hard to unit test" in the readiness review
  because it drives real OS-keychain/browser-cookie decryption. Refactor to accept the
  keychain/browser-cookie-read functions as injected parameters so the *fallback ordering and error
  handling* is unit-testable with fakes. The actual OS/browser integration is **not** something a
  unit test can honestly cover — per `.ai/README.md`'s verification requirement, that stays a
  real-system check, and one already effectively exists: `scripts/health-check.ts`/`npm run
  health-check` already exercises the real cookie path end-to-end when `jiraCookieBrowser` is
  configured (`src/jira/client.ts` routes through `getJiraCookieHeader` for every real API call in
  cookie mode). No new script needed — just confirm/document that this is the checkpoint.
- **`src/index.ts`** (server wiring — currently untested at all) — spike first: check whether
  `@modelcontextprotocol/sdk`'s in-memory transport lets a test register the real server and assert
  every tool/prompt/resource this project defines is actually exposed. If that's impractical, fall
  back to a lighter smoke test (import the module, assert it doesn't throw) rather than forcing a
  brittle integration harness onto a file that's mostly registration calls.

## Phases

1. **Push/merge git-hook guard** (decision #1). Extend `src/worktree.ts`, update
   `docs/implementation-procedure.md` and `docs/setup.md`. **Ends with a real-git verification
   checkpoint**: in a throwaway repo, confirm `git push` and a non-fast-forward `git merge` both fail
   inside the guarded worktree while the main checkout is unaffected — actual git process behavior,
   not mocked.
2. **`approve_plan` Open Questions gate** (decision #2). Update `docs/planning-procedure.md`, add
   `planHasUnresolvedOpenQuestions`, wire into `approvePlanTool`.
3. **Make-target `skipTargets` consistency check** (decision #3). Extend `.ai/intake-mcp.json`'s
   shape, add the Makefile parser, wire the contradiction check into `trackerTransition`'s `verify`
   path (shares the checkpoint phase 1 already touches in that file).
4. **Test coverage** (decision #4), in the grouped order above — pure functions first, then mocked
   tool tests, then the `auth-cookie.ts` refactor, then the `index.ts` spike last (most likely to
   need a design pivot, least likely to block anything else).
5. **Dogfood**: run through `plan_ticket` → `approve_plan` → `implement_ticket` against this repo's
   own worktree flow once more (same pattern the implementation-phase plan already used), confirming
   nothing in phases 1–3 broke the existing happy path, and that all four hard-limits bullets in
   `docs/implementation-procedure.md` read accurately against what the code now actually enforces.

## Explicitly out of scope for this plan

- **`Scope` → "Out" enforcement** — stays exactly where it is, in
  `.ai/plans/draft/scope-out-enforcement.md`. Not started, not touched, per explicit instruction.
- **`state:done` and anything past it** (merge, deploy, closing the ticket) — remains a permanent,
  deliberate boundary (implementation-phase plan, decision #6). Not reopened here.
- **Blocking a remote-side PR merge** (`gh pr merge`, GitHub UI merge button) — architecturally
  unreachable by any local mechanism; not attempted.
- **Verifying that an existing (non-skipped) `make` target actually ran and passed** — would require
  a new "run the verification myself" MCP tool (this server executing `make` on the agent's behalf
  instead of trusting the agent's own shell), a materially larger architecture change than this
  phase's scope. Named explicitly in decision #3 above so it isn't mistaken for solved.

## Resolved during implementation

1. **`core.hooksPath` path semantics — relative is broken, absolute is required.** Verified
   empirically with a throwaway repo+worktree: a *relative* `core.hooksPath` set at `--worktree`
   scope resolves against the worktree's **working-tree root**, not its private git dir — so a hook
   placed under the private git dir and referenced by a relative path is silently never found, and
   `git push`/`git merge` succeed as if no guard existed at all. `installPushMergeGuard`
   (`src/worktree.ts`) always writes an absolute path. Also confirmed empirically: a fast-forward
   merge genuinely never invokes `pre-merge-commit` (no merge commit is created), matching the
   documented limitation exactly.
2. **`src/index.ts` test approach — the in-memory-transport approach works, once one thing changed.**
   `src/index.ts` unconditionally called `await server.connect(new StdioServerTransport())` at
   module scope, so merely *importing* the module for a test would have attached real listeners to
   the test process's actual `process.stdin`. Fixed by exporting `server` and gating the real
   stdio-connect behind an `isMainModule()` check (`realpathSync(process.argv[1]) ===
   realpathSync(fileURLToPath(import.meta.url))`) — true only for the real, documented invocation
   (`node .../dist/index.js`, per `docs/setup.md`/`install.sh`; this project never runs it via npm's
   `bin` symlink, so the realpath comparison is not just a defensive nicety here, it always matches).
   With that gate in place, `test/index.test.ts` connects a real `Client` to the real `server` over
   `InMemoryTransport.createLinkedPair()` and calls `listTools`/`listPrompts`/`listResources` —
   metadata-only calls that never invoke a handler, so real Jira credentials are never touched.
3. **A pre-existing gap the phase-4 auth-cookie tests exposed, not introduced**: the dev
   `Dockerfile` never installed `libsecret-1-0`, keytar's native-binding runtime dependency on
   Linux — `make test` failed with "libsecret-1.so.0: cannot open shared object file" the moment any
   test imported `src/jira/auth-cookie.ts` at all (even fully mocked), because keytar loads its
   native binding at import time regardless of whether it's ever called. Added to the `Dockerfile`.
