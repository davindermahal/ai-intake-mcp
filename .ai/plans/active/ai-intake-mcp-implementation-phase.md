# Plan (draft): `ai-intake-mcp` — implementation phase (approved plan → implemented, verified, committed)

**Status**: active
**Created**: 2026-08-28
**Updated**: 2026-08-28
**Related**: `.ai/plans/active/ai-intake-mcp-on-demand-planning.md` (the v1 planning-phase plan this
one extends — all of its decisions stand unchanged unless explicitly revised below), the
`ai-intake-harness` repo's `worktree-go.sh`/`worktree-remove.sh`/`lib/worktree-common.sh` (its
DB/container provisioning core), `scripts/lib/project/ai-harness-dev.sh` (a concrete, if trivial,
`project_*` adapter), `.ai/prompts/worktree-bootstrap-auto.md` (source material generalized into
this repo's new implementation procedure doc, the same way `prompts/intake-planning.md` was
generalized into `docs/planning-procedure.md`), and this repo's own root `Dockerfile`/`Makefile` (the
reference example for decision #1/#2 below — already dogfooded, see the v1 plan's "Development
environment" section)

## Goal

Extend `ai-intake-mcp` past planning into the harness's other pipeline half: turning an **approved**
plan (`Status: ready`, ticket moved to `state:implement`) into implemented, locally-verified,
locally-committed code — on demand, interactively, no cron/poller, same "no per-project install
beyond a little config" philosophy the planning phase already established. This is the
`worktree-go.sh` equivalent the v1 plan's "Explicitly out of scope" section named and deferred.

This is an **extension of the same server**, not a new one: it reuses `tracker_get_issue`,
`worktree_create`, the Jira client/`jira-tags` module, the per-repo config file, the comment-footer
mechanism (decision #10 in the v1 plan), and the narrow-tools sandboxing philosophy (decision #11)
unchanged. Everything below is additive.

## Core design decisions

1. **Git worktree isolation is kept exactly as v1 built it; container isolation is dropped
   entirely — these are two different things the harness bundles together, and only one of them
   is worth keeping here.** Clarified in review: the harness's `worktree-go.sh` provisions *two*
   separate kinds of isolation per ticket — a git worktree (a checkout) and a **brand-new,
   dedicated Docker container** with its own port/DB (`wt_start_container`/`wt_create_empty_db`,
   `lib/worktree-common.sh`). The container-per-worktree half exists to let the harness's poller run
   **many headless implementation workers in parallel** without them colliding on ports/state.
   `ai-intake-mcp`'s on-demand model has no such parallelism to isolate against — one interactive
   developer, one ticket, one session at a time. Provisioning a whole new container per worktree
   would be solving a problem this model doesn't have.

   So: `implement_ticket` reuses `worktree_create` (v1) **unchanged** — same git worktree, same
   sibling-directory convention, same resume-if-exists behavior. It creates **no container, no
   database, no port allocation, ever.** Instead, implementation commands run through `make
   <target>` (decision #2), invoked from inside the worktree directory — exactly like `git`/`npm`/
   anything else already works per-worktree with zero container bookkeeping. What a target does
   internally is entirely the project's own business: this repo's own Dockerfile/Makefile pattern
   (build one shared image once via `make image`, then every command is an ephemeral `docker run
   --rm -v $(CURDIR):/workspace ...`) naturally handles the worktree case for free — `CURDIR` is
   whatever directory `make` was invoked from, so running `make test` from inside a worktree binds
   *that* worktree with no start/stop/wait/verify-DB steps at all. A project with a genuinely
   stateful service (its own long-running app + database) is free to make its targets `docker exec`
   into one already-running **shared** dev container instead — `ai-intake-mcp` doesn't care which
   pattern a project uses, only that `make <target>` works from inside the worktree directory.

   Consequence: no `wt_start_container`/`wt_wait_container`/`wt_verify_container_db`/
   `wt_create_empty_db`/port-allocation equivalents are ever built. `ai-intake-mcp` never talks to
   Docker or a database in any form, at any point.

2. **Standard `make` target vocabulary + one generic passthrough, instead of per-project config
   fields.** Rather than storing freeform command *strings* per project (an earlier draft's
   `.ai/intake-mcp.json` `implementation` block — superseded by this decision), standardize on fixed
   target **names** every consumer project's Makefile is expected to define — the same convention
   this repo's own Makefile already dogfoods:
   - `make install` — dependencies (mirrors this repo's own target).
   - `make build`
   - `make test`
   - `make lint`
   - `make exec CMD="<command>"` — the **generic passthrough** for anything not covered by a fixed
     verb (installing a new dependency mid-implementation, a one-off framework command — e.g.
     `make exec CMD="composer install"`, `make exec CMD="php bin/console cache:clear"`). This is the
     one *load-bearing* target name `docs://implementation-procedure` can always fall back to. A
     project may additionally define its own convenience wrappers on top (e.g. `make composer
     ARGS=install`) purely as sugar — `ai-intake-mcp` never requires or reads those.

   `docs://implementation-procedure` calls these by fixed name; no config is needed to know what
   they're *called*. Whether a project has all five, some, or needs to be asked is decision #3's
   concern, not a schema `ai-intake-mcp` parses. **Consequence**: the `.ai/intake-mcp.json`
   `implementation` block from the earlier draft is dropped — the file stays exactly as v1 left it
   (`jiraProjectKey`, `appTag`, nothing more).

3. **A new, optional, free-form file — `.ai/intake-mcp.md` — carries whatever project-specific
   context doesn't fit a fixed schema; no new tool writes it.** For exactly the kind of detail that's
   better read than parsed: which of decision #2's targets this project actually defines, dev-setup
   quirks ("first `make test` after `make install` takes ~30s while the image builds"), anything
   else a human would tell a new teammate about running this project locally.

   Deliberately **not JSON** — unlike `.ai/intake-mcp.json` (v1 decision #4: exactly two required
   fields, validated on write), this is read by the agent as prose, the same way it already reads
   `docs://planning-procedure`. No schema to keep in sync, no parser to version alongside it.
   **No new MCP tool writes it** — `write_repo_config` exists because `.ai/intake-mcp.json` has a
   real schema worth validating; `.ai/intake-mcp.md` has none, and the agent already has its own
   `Write`/`Edit` access in the calling session. A dedicated tool for "write one markdown file" would
   only widen the tool surface against v1 decision #11's narrow-tools philosophy for no real benefit.

   Bootstrap: `docs://implementation-procedure` tells the agent that if `.ai/intake-mcp.md` doesn't
   exist yet, ask the developer once for the essentials (which of decision #2's targets exist,
   anything unusual about the dev setup) and write the file directly — same "ask once, never again"
   spirit as `write_repo_config`'s bootstrap (v1 decision #4), just without a dedicated tool behind
   it.

4. **The plan file's `Status: ready` field is the approval gate — checked, never bypassed, no
   override argument.** Mirrors the harness's core safety property
   (`worktree-bootstrap-auto.md` §1: "Confirm its Status is ready... If it is not ready, or no plan
   exists: stop"). `implement_ticket`'s first, non-negotiable step: read
   `.ai/plans/active/<KEY>-*.md`; refuse to proceed if `Status` isn't `ready` (or `active`, for a
   resumed/interrupted run — see decision #8). The whole point of the gate is that flipping it to
   `ready` is a **human** decision made by editing the plan file — no automated caller can supply an
   override.

5. **A new tool, `approve_plan`, makes the two approval signals move together instead of drifting —
   and is the *only* way to reach `state:implement`.** Approval in this model has two artifacts that
   must agree: the plan file's `Status` field (decision #4) and the ticket's `state:*` label
   (decision #6 below). `approve_plan(ticket_key)`:
   1. Resolves the ticket's worktree by key (the same branch-lookup `worktree_create`/
      `worktree_remove` already do — **not** assumed from the caller's cwd, since the plan file only
      exists inside that specific worktree and a developer approving a plan may well be sitting
      somewhere else, e.g. the main checkout, having reviewed the diff there). Refuses with a clear
      error if no worktree exists yet for this ticket.
   2. Calls `tracker_transition(key, "implement")` **first** — this is the call with real gating
      logic (the ticket must currently carry `state:review`, matching v1's assignee-gate shape). If
      Jira refuses or the call fails, stop here: nothing local has changed yet.
   3. Only on success: sets the plan file's `Status: draft → ready` and bumps `Updated`.

   Order matters: writing the file first and transitioning Jira second (the original draft's order)
   would leave the file saying `ready` while Jira still says `state:review` if the transition then
   failed — exactly the inconsistency this tool exists to prevent. Doing the gated call first means a
   failure never leaves stale local state behind.

   **`"implement"` is removed from `tracker_transition`'s own directly-callable vocabulary** (see
   "Tool surface" below) — reachable only through `approve_plan`, the same way `plan` is
   bootstrap-only and not a raw v1 target. Without this, an agent could call
   `tracker_transition(key, "implement")` directly and skip the plan-file flip entirely, silently
   defeating the whole point of this decision.

6. **`tracker_transition`'s vocabulary is extended, not replaced, plus one label v1 never
   anticipated.** v1 already reserved `state:implement`/`state:working`/`state:verify`/`state:done`
   in its mapping table without building them; this plan activates three of the four as real
   `tracker_transition` targets (`implement` is deliberately *not* one — see decision #5), and adds a
   fifth label v1's vocabulary had no equivalent for:

   | Label | Who transitions it | When |
   |---|---|---|
   | `state:implement` | `approve_plan` **only** — never a raw `tracker_transition` target | Human approves the plan (decision #5). |
   | `state:working` | `implement_ticket` (auto), `tracker_transition` target | Implementation session starts, right after the `Status: ready` gate passes. |
   | `state:verify` | `implement_ticket` (auto), `tracker_transition` target | Implementation complete, `make build`/`test`/`lint` (as applicable) all passed, work committed locally. |
   | `state:problem` (**new**) | `implement_ticket` (auto), `tracker_transition` target | Implementation blocked — an unfixable failure, or something needing a human decision. |
   | `state:done` | *(not this plan)* | A later, human/merge-time step — out of scope here, same as the harness's own worker, which stops at "ready for verification... the diff review they will do before merging" (`worktree-bootstrap-auto.md`). No tool in this plan ever sets it. |

   **Why a new label instead of reusing `state:needs-input`**: that label already carries a specific,
   established meaning from v1 — "the ticket's *author* needs to answer a planning question." A
   failed build or an implementation blocker is a different kind of event (often nothing to do with
   the author at all) and reusing the same label would blur two genuinely different signals a
   developer glancing at the board needs to tell apart. `state:problem` says, unambiguously, "this
   implementation run did not complete cleanly — look here."

   `state:working` carries real information (a human glancing at the board can tell implementation
   is underway) even though nothing in `ai-intake-mcp` itself depends on reading it back — same
   cosmetic-but-worthwhile justification v1 gave the native-status mirror.

7. **Native-status mirror extended: `TRACKER_NATIVE_STATUS_CODE_REVIEW` finally becomes reachable.**
   v1 explicitly punted on this ("don't build anything for `_CODE_REVIEW` in v1 — there's nothing
   that would ever call it"). Mapping (read from the harness's own `jira_tags_native_status`, same
   as v1 did for `_IN_PROGRESS`): `implement`/`working`/`problem` → `TRACKER_NATIVE_STATUS_IN_PROGRESS`;
   `verify` → `TRACKER_NATIVE_STATUS_CODE_REVIEW`. `problem` mirrors to the same in-progress column
   rather than getting a third configurable native-status variable — the `state:problem` *label* is
   the authoritative signal (v1 decision #3's principle: the label is source of truth, the native
   status is cosmetic); not worth a new `TRACKER_NATIVE_STATUS_*` config var for one label, matching
   v1's own minimalism about not building `_CODE_REVIEW` until something actually needed it. Still
   best-effort, still never fails the call — unchanged contract from v1 decision #3.

8. **Resume-awareness carried over from both the harness and v1's own `worktree_create`.** If the
   worktree already exists (a prior planning session, or a previous interrupted implementation
   attempt), `implement_ticket` does not start over: check `git status`/`git diff` for uncommitted
   work and the plan file's own progress notes first, and treat that as the starting point — mirrors
   `worktree-bootstrap-auto.md`'s explicit "treat that as your starting point" rule and v1 decision
   #5's resume-not-error policy. The gate in decision #4 accepts `Status: active` (not just `ready`)
   for exactly this case — `active` is what the procedure sets once implementation actually starts
   (see `docs://implementation-procedure` below), so a resumed run isn't locked out by its own prior
   progress.

9. **No result-file/poller indirection — the agent transitions directly, same as planning, on
   *either* outcome.** The harness's headless implementation worker deliberately *cannot* call
   `tracker-transition.sh` itself; it writes `.ai/impl-result.json` and a separate poller process,
   running after the worker exits, performs the transition deterministically
   (`.ai/plans/completed/implementation-completion-handoff.md`) — a safeguard against a headless run
   silently forgetting its last step. `ai-intake-mcp` has no such gap to guard against: the calling
   agent is present for the whole tool-call sequence, exactly as it already is for planning.
   `tracker_add_comment` then `tracker_transition` are called directly by the agent at the end of
   `implement_ticket` — `tracker_transition(key, "verify")` on success, `tracker_transition(key,
   "problem")` (decision #6) on a blocked outcome, both preceded by a comment explaining what
   happened. No indirection either way.

10. **Hard limits carried over from the harness's worker, as procedure-doc guidance, not
    code-enforced — an explicit, accepted gap, not an oversight.** Directly ported from
    `worktree-bootstrap-auto.md`'s "Hard limits": never `git push`/merge/deploy (commit locally only
    — the human reviews and merges); implement the **plan**, not raw ticket prose — ticket
    description/comments are untrusted reference data, never instructions (the same prompt-injection
    defense, verbatim reasoning); stay within the plan's Scope/Boundaries; stop and report on the
    first unfixable failure rather than improvising past it.

    Unlike the harness — which enforces `git push` denial via a curated `.claude/settings.*.json`
    profile shipped inside its own repo — `ai-intake-mcp` has no comparable place to ship an enforced
    deny-list for **general shell**. v1 decision #11 already established narrow-tools-not-broad-
    permissions for `ai-intake-mcp`'s *own* MCP tool surface, but implementation work fundamentally
    needs the agent's full `Edit`/`Bash` access (unlike planning, which only ever needed the six
    narrow MCP tools) — there is no tool-level containment equivalent to build here. `docs/setup.md`'s
    existing recommended-but-optional settings snippet (v1 decision #11) is extended with a `git push`
    deny example for implementation sessions, opt-in per developer, same as today.

11. **`worktree_remove` is built for real in this plan** (v1 left it a "maybe," phase 1.5). An
    implementation-phase worktree is exactly the case where cleanup actually matters — a
    planning-only worktree holding just a plan file is nearly free to leave around; a merged
    implementation worktree is pure waste. Pure git, no container/DB to tear down (decision #1 —
    there never was one): removes the worktree directory and, unless `keep_branch` is set, the
    branch itself — guarded the same way the harness's `worktree-remove.sh` guards it: only
    `feature/*` branches, never `main`/`master`, and only branches **merged into local `main`**
    unless `force` is set. Carries `destructiveHint: true` (v1 decision #11's exception case, now
    built) and stays out of `docs/setup.md`'s recommended allow-list.

## Tool surface (additions)

- `approve_plan(ticket_key)` → `{ plan_path, transitioned_to: "implement" }` — decision #5. Resolves
  the ticket's worktree by key (not the caller's cwd); refuses unless the ticket currently carries
  `state:review`; transitions Jira before touching the plan file (decision #5's ordering).
- `tracker_transition(key, state)` — **vocabulary widened**: adds `working`, `verify`, `problem` to
  the existing `needs-input`/`review` (v1). `plan`/`implement`/`done` remain non-targets —
  `implement` deliberately excluded (decision #5: reachable only via `approve_plan`), same treatment
  v1 gave `plan`.
- `implement_ticket(ticket_key)` → `{ worktree_path, branch, outcome: "verified" | "problem" }` —
  orchestrates, **in this order**: (1) resolve/resume the worktree (reuses `worktree_create`
  unchanged, decision #1) — must happen first, since the plan file this tool needs to read only
  exists inside it; (2) from inside that worktree, confirm plan `Status: ready`/`active` and the
  ticket's `state:implement`/`working` (decisions #4, #8); (3) transition to `working` (decision #6)
  if not already there; (4) hand off to `docs://implementation-procedure`. Returns `"problem"`
  rather than throwing when the procedure itself determines it can't proceed (matches the harness's
  `{"outcome":"blocked"}` — a legitimate result, not a tool failure; named to match the `state:problem`
  label it corresponds to).
- `worktree_remove(ticket_key, { force?, keep_branch? })` → `{ removed: { worktree, branch } }` —
  decision #11. Also resolves the worktree by ticket key, same as `approve_plan`.

Everything else in v1's tool surface (`tracker_get_issue`, `tracker_add_comment`, `worktree_create`,
`write_repo_config`, `health_check`) is reused unchanged. No new tool runs `make` commands or touches
Docker — the agent runs those directly with its own shell access (decisions #1, #2).

## `.ai/intake-mcp.md` (new, optional file)

Example:
```markdown
# Implementation notes for ai-intake-mcp

Standard targets defined: install, build, test, lint, exec.
`make install` builds the shared dev image on first run (~40s); subsequent commands are fast.
No database, no long-running container — every `make` target is an ephemeral `docker run --rm`
scoped to whatever directory you invoke it from, so it works unmodified from inside a worktree.
```
Read by the agent as prose (decision #3) — not parsed, no schema. `.ai/intake-mcp.json` is unchanged
from v1: still just `{ "jiraProjectKey": ..., "appTag": ... }`.

## MCP resources (additions)

- `docs://implementation-procedure` — generalized from `worktree-bootstrap-auto.md`, adapted for the
  interactive on-demand model: no headless-only `impl-result.json` handoff (decision #9), no
  reference to one repo's own dogfood `.claude/settings.*.json`. Covers: confirm the approval gate
  (decision #4), read `.ai/intake-mcp.md` if present or bootstrap it if not (decision #3), read
  project context, work the plan's Implementation order in sequence with each step's acceptance
  check, respect Boundaries, stop-and-report on the first unfixable failure (report back via
  `tracker_add_comment` + `tracker_transition(key, "problem")`, decision #6, rather than improvising
  past it), run `make install`/`build`/`test`/`lint` as applicable and `make exec` for anything else
  (decision #2, all declared targets must pass to count as verified — a failing one is a `problem`
  outcome, not a partial success), commit locally as logical units land, move the plan file to
  `.ai/plans/completed/` + `Status: completed`, then report back on success too (decision #9's direct
  `tracker_add_comment` + `tracker_transition(key, "verify")`).

## MCP prompts (additions)

- `implement_ticket(ticket_key)` — seeds the session: create/resume the worktree (`worktree_create`,
  decision #1) **first**, then confirm approval from inside it (decisions #4/#5), read
  `docs://implementation-procedure`, then follow it. Mirrors `plan_ticket`'s shape exactly (v1
  decision #6).

## Verification checkpoints (real systems, not mocks)

Per the standing convention (`.ai/README.md`, "Verification requirement"): mocked-`fetch` unit tests
verify logic, not that a request is valid against the real system. This plan's new ground —
`approve_plan`'s `state:implement` transition, the raw `working`/`verify`/`problem`
`tracker_transition` targets, and the `TRACKER_NATIVE_STATUS_CODE_REVIEW` mirror — was never
exercised by v1's checkpoint (v1 explicitly scoped its check to `needs-input`/`review` only).

- **Required before this plan's Phase 2 starts**: extend `scripts/jira-smoke-check.ts` (or add a
  sibling script) to exercise `approve_plan` and all three new raw `tracker_transition` targets
  (`working`, `verify`, `problem`) against one real, disposable test ticket — confirming the
  `state:review → state:implement` guard actually refuses/succeeds as designed, that
  `tracker_transition(key, "implement")` is now correctly *refused* when called directly (decision
  #5's vocabulary exclusion), and that the `TRACKER_NATIVE_STATUS_CODE_REVIEW` mirror lands on the
  real board (this repo's Jira site has never had this column exercised — `health_check` only ever
  checked `_IN_PROGRESS`). Clean up afterward, same discipline as v1's checkpoint.
  **CONFIRMED 2026-08-28** — `scripts/jira-smoke-check-implementation.ts`, run against `DAV-5`:
  `approve_plan` transitioned `state:review → state:implement` and flipped the plan file to `ready`;
  a direct `tracker_transition(key, "implement")` was correctly refused with a clear error; `working`
  → mirrored to "In Progress"; `verify` → **mirrored to "Code Review"** (the new ground — confirms
  that native status exists and is reachable on this board); `problem` → mirrored to "In Progress".
  Cleaned up (labels + plan `Status` restored) afterward.
- **Dogfood**: once built, run `implement_ticket` against a real ticket with a real, small,
  genuinely-`ready` plan (not a description-less placeholder like `DAV-5` — v1's dogfood ticket had
  nothing to implement) — ideally against **this repo itself**, since it already has the exact
  `make install`/`build`/`test`/`lint` targets decision #2 standardizes on, so the make-target
  convention gets exercised for real, not just the Jira/git mechanics.

  **CONFIRMED 2026-08-28.** Real task: this repo's own Makefile was missing the `make exec`
  passthrough target decision #2 requires — a genuine gap the checkpoint above happened to surface.
  Full real pipeline, driven by calling the built tool functions directly (same rationale as v1's
  dogfood — a separate live agent session against the real board was judged unnecessarily
  unreviewable): wrote a real plan at `DAV-5`'s existing worktree → `tracker_add_comment` +
  `tracker_transition(key, "review")` → `approve_plan` (flipped `state:review → state:implement`,
  plan `Status → ready`) → `implement_ticket` (resumed the worktree, `state:implement → working`).
  `DAV-5`'s worktree turned out to be a **stale branch** (forked before Phase 1 even scaffolded
  `package.json`) — merged current `main` into it first (`git merge main`, purely local, not a
  `git push`), exactly the "prior progress / resume" case decision #8 anticipates, just via a merge
  rather than mid-run interruption. Then implemented for real: added the `exec` target, wrote
  `.ai/intake-mcp.md`. Ran `make exec CMD="node -v"` (printed the container's Node version), `make
  build`, `make test` (17 tests), `make lint` — all passed. Committed locally (two commits, plan
  moved to `completed/`), never pushed. Reported back: `tracker_add_comment` + `tracker_transition
  (key, "verify")` → mirrored to native status "Code Review" for real.

  **Confirms the central design bet (decision #1)**: no container was ever created or managed by
  `ai-intake-mcp` — `make exec`/`build`/`test`/`lint` ran as ordinary ephemeral `docker run --rm`
  invocations scoped to the worktree directory, with zero container lifecycle code anywhere in this
  plan's implementation. `DAV-5` was left at its resulting state (`state:verify`, real comments, a
  real 2-commit branch) — genuine tool output, not test residue, same precedent as v1.

## Phases

1. Write `docs/implementation-procedure.md`'s "gate + approval" half and the `.ai/intake-mcp.md`
   convention (decisions #2–#5); extend `tracker_transition`'s vocabulary + native-status mapping
   (decisions #6, #7); build `approve_plan`. Mocked-`fetch` unit tests for all of it. **Ends with the
   real-Jira verification checkpoint above.**
2. Build `worktree_remove` (decision #11) — pure git, guarded, unit-tested against a throwaway local
   repo the same way `worktree_create`'s tests already are.
3. Finish `docs/implementation-procedure.md` (the make-target/build/verify half, decisions #1, #2),
   wire it up as `docs://implementation-procedure`; build `implement_ticket` (tool + prompt).
4. Update `docs/setup.md`'s recommended allow-list snippet (add the new tools; keep
   `worktree_remove` excluded, decision #11) and add the optional `git push`-deny example (decision
   #10).
5. Dogfood against this repo itself (see "Verification checkpoints" above); decide, based on
   results, whether the `make`-target convention (decisions #1, #2) is enough or needs another
   target/hook.

## Explicitly out of scope for this plan

- **Any Docker container or database created/managed by `ai-intake-mcp`, ever** — decision #1. A
  project's own `make` targets own 100% of that; `ai-intake-mcp` never shells out to `docker`/`psql`
  in any form.
- **`state:done` and anything past it** (merge, deploy, closing the ticket) — decision #6's table.
  Stops at `state:verify`, same boundary the harness's own headless worker stops at.
- **Enforced (code-level) prevention of `git push`/merge during an implementation session** —
  decision #10. Procedure-doc guidance + an opt-in settings snippet only.
  **Revisited**: `.ai/plans/completed/ai-intake-mcp-hardening-phase.md` (2026-08-30), decision #1 —
  `worktree_create` now installs a per-worktree `pre-push`/`pre-merge-commit` git hook that actually
  blocks `git push` and a local non-fast-forward merge, regardless of which agent CLI is driving. A
  fast-forward local merge and any remote-side merge (`gh pr merge`, GitHub's UI) remain unreachable
  by any local mechanism — that part of decision #10 still stands.
- **Multi-service / docker-compose-style orchestration** — not attempted even optionally; a project
  needing more than "run this `make` target" belongs to that project's own tooling.
- **Any change to `ai-intake-harness` itself** — unchanged from the v1 plan's own boundary.

## Resolved (this round)

- **Git worktree isolation vs. container isolation are different things — only the first is kept.**
  The point that triggered this round's redesign: v1's `worktree_create` (a git checkout) stays
  exactly as built; the harness's *separate* per-worktree container/DB/port provisioning is dropped
  entirely, not replaced with a lighter version of itself — see decision #1.
- **How a project's build/test/verify commands are declared**: not JSON command strings (an earlier
  draft's `.ai/intake-mcp.json` `implementation` block, now dropped) — a **fixed `make` target-name
  convention** (`install`/`build`/`test`/`lint`/`exec`) instead, so `ai-intake-mcp` needs zero
  per-project config to know what to run, only whether a target exists — see decision #2.
- **Where free-form project context lives**: a new `.ai/intake-mcp.md`, prose, no schema, no
  dedicated tool to write it — `.ai/intake-mcp.json` stays exactly as v1 left it — see decision #3.
- **`state:working`'s value despite nothing reading it back**: kept anyway, for board hygiene — see
  decision #6.
- **`worktree_remove`'s DB/container-drop steps**: dropped entirely, not ported — decision #1 already
  means `ai-intake-mcp` never created a database or container to begin with, so there's nothing for
  `worktree_remove` to tear down there either. Only git worktree + branch removal carry over from
  the harness's `worktree-remove.sh`.
- **`tracker_transition`/`approve_plan` overlap on `state:implement`**: closed by removing
  `"implement"` from `tracker_transition`'s own callable vocabulary — reachable only via
  `approve_plan` — see decision #5. Without this fix an agent could bypass the plan-file `Status`
  flip entirely by calling `tracker_transition` directly.
- **Worktree resolution can't be assumed from cwd**: `approve_plan` and `implement_ticket`'s gate
  check both need the ticket's plan file, which only exists inside that specific worktree. Both now
  resolve the worktree by ticket key first (reusing `worktree_create`'s branch lookup), rather than
  assuming the caller is already sitting in the right directory — see decision #5 and the
  `implement_ticket` tool-surface entry.
- **`approve_plan`'s write order**: Jira transition first, plan-file `Status` flip second — prevents
  a failed Jira call from leaving a plan file that claims approval Jira never actually recorded —
  see decision #5.
- **A distinct `state:problem` label for a blocked implementation, instead of reusing
  `state:needs-input`**: `needs-input` already means something specific from v1 ("the ticket's
  author needs to answer a planning question"); a build/test failure or an implementation blocker is
  a different kind of event and deserves its own, unambiguous signal — see decision #6.
- **Whether a failing declared `make` target blocks completion**: yes — all targets the project
  declares (via `.ai/intake-mcp.md`, decision #3) must pass for `implement_ticket` to report
  `"verified"`; any failure is a `"problem"` outcome, not a partial success. See "MCP resources"
  above.

## Remaining open

Both items below were resolved by `.ai/plans/completed/ai-intake-mcp-hardening-phase.md` (2026-08-30) —
kept here, unresolved wording included, as the record of what was originally left open and why.

- **Whether `approve_plan` should also verify the plan file has no unresolved Open Questions** before
  allowing the `state:review → state:implement` transition — the harness's human approval step
  implicitly does this (a person reads the plan before moving it), but `approve_plan` itself doesn't
  parse the plan file's content today, only its `Status` field. Worth deciding in phase 1 whether
  that's an acceptable trust boundary (the human calling `approve_plan` already read the plan) or a
  gap worth closing.
  **Resolved**: yes, close the gap. Hardening-phase plan, decision #2 — `## Open Questions` items are
  now `- [ ]`/`- [x]` task-list lines, and `approve_plan` refuses while any `- [ ]` remains.
- **How prescriptive `docs://implementation-procedure` should be when a project's `.ai/intake-mcp.md`
  says a standard target (decision #2) genuinely doesn't apply** (e.g. a docs-only repo with no
  `lint` target) — skip silently, or note it in the completion comment? Leaning toward "skip
  silently, only note declared-but-failing targets," but not decided — revisit in phase 3.
  **Resolved**: require explicit declaration, not silent skip. Hardening-phase plan, decision #3 —
  `.ai/intake-mcp.json`'s `skipTargets` field, cross-checked against the real `Makefile` at the
  `verify` transition. Can't verify a non-skipped target was actually run, only that a claimed-skip
  isn't contradicted by the Makefile — documented as a permanent limit, not oversold as closing the
  full gap.

## Related idea raised in review, not part of this plan

**A future hybrid workflow**: the developer plans and approves interactively via `ai-intake-mcp`
(no cron), then optionally hands a specific, approved ticket off to `ai-intake-harness`'s existing
headless cron poller for unattended implementation — on the developer's own machine, using the same
Jira account for both. Currently not possible even in principle: the harness's poller queries for
the literal label `state:ready-for-implementation` (confirmed by reading
`lib/tracker/jira-tags.sh`'s `jira_tags_current_state`/legal-move logic), while `ai-intake-mcp`
writes `state:implement` — different strings, so the poller simply never sees a ticket
`approve_plan` touched. This is v1 decision #3's "no interoperability" stance in practice, not a bug.

The developer plans to update `ai-intake-harness` to adopt `ai-intake-mcp`'s shortened `state:*`
vocabulary, which would close that gap. Once the two systems share label text, a second problem
appears: **both systems would then be able to act on the exact same `state:implement` ticket**, with
no way to tell "I'm going to `implement_ticket` this myself" from "please let the cron pick this
up" — worse, the harness's assignee-gate can't disambiguate by account either, since both paths
authenticate as the same person on the same machine.

**Proposed resolution, not designed or built here**: don't fork `state:implement` into a parallel
`state:implement-headless` state — that doubles every downstream state (`working`/`verify`/
`problem`) if "was this headless" ever needs to survive past approval, and complicates the shared
state machine both systems would need to keep in sync. Instead, add a small **orthogonal dispatch
marker label** (e.g. `dispatch:headless`) that only the poller's *pickup decision* consults — the
same pattern `app:<tag>` already establishes (a label alongside `state:*`, not part of the state
machine itself). Concretely: `approve_plan(ticket_key, { headless?: boolean })` — default behavior
unchanged (`state:implement` only, meant for `implement_ticket`); `headless: true` additionally
applies `dispatch:headless`.

**The load-bearing catch**: this only prevents the race if the harness's *poller* is updated to
require `state:implement` **and** `dispatch:headless` together, not `state:implement` alone. A
naive tag-vocabulary alignment on the harness side that just swaps its literal strings for
`ai-intake-mcp`'s shortened ones, without also adding this filter, would make the poller sweep up
*every* `approve_plan` call — including ones the developer meant to implement themselves. Whoever
updates the harness's poller needs to know this filter is required, not optional.

No action taken here — revisit once the harness-side tag alignment is closer to real, and decide
then whether to build the `headless` option on `approve_plan`.
