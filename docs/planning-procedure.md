# Planning procedure

Served as the `docs://planning-procedure` MCP resource — read this at the start of a planning
session (the `plan_ticket` prompt does this for you automatically) and follow it for the rest of the
session. Generalized from `ai-intake-harness`'s `prompts/intake-planning.md` for the on-demand,
interactive model: there's no poller, no decision file, no headless dispatch — you talk to the
developer directly and call the tracker tools yourself.

## 0. What's already happened

By the time you're reading this (via the `plan_ticket` prompt), the ticket has already been fetched
with `tracker_get_issue` and a git worktree has already been created or resumed with
`worktree_create`. Your working directory is that worktree. You do not need to call either tool
again unless the developer names a different ticket.

## 1. Read the ticket

Use the `summary`, `status`, `description`, and `comments` already returned by `tracker_get_issue`.
Read the existing comments so you don't re-ask something the ticket's author already answered in a
previous round.

## 2. Find or create the plan file

The deliverable is one file: `.ai/plans/active/<TICKET-KEY>-<slug>.md` (decision #7 — this lands in
the developer's project repo, not in `ai-intake-mcp`).

```bash
ls .ai/plans/active/<TICKET-KEY>-*.md
```

- **Match → refine, don't regenerate.** This is a re-pickup after the ticket bounced through
  `state:needs-input` and back. Read the existing plan, fold the developer's new answers into it, and
  **accumulate** the Q&A — never overwrite from scratch.
- **No match → create** a new plan file. Derive `<slug>` as kebab-case of the ticket summary.

### Plan file shape

```markdown
# Plan: <TICKET-KEY> <Title>

**Status**: draft
**Branch**: <branch returned by worktree_create>
**Created**: <YYYY-MM-DD>
**Updated**: <YYYY-MM-DD>
```

Then: **Goal**, **Scope** (in/out), **Files to change** (one-line reason each), **Key decisions**,
**Implementation order**, **Boundaries**, **Open Questions**. Leave `**Status**: draft` — flipping to
`ready` happens via the `approve_plan` tool, a separate human decision this planning session never
makes itself.

### Write for a weaker executor

Whoever implements this plan may not be you, and may be a smaller/weaker model. Don't lean on the
implementer's judgment to fill gaps:

- **Every Implementation order step is self-contained and literal.** Exact file paths, exact
  commands (build/test/verify, copy-pasteable), and what the change is. "Update the controller" is
  not a step; "In `src/Controller/EventController.php`, add … then run `<exact test command>`" is.
- **Every step ends with an acceptance check** — one command or one concrete observation, plus the
  expected pass output.
- **`## Boundaries` is required on every plan — never omit it, even when nothing seems off-limits.**
  A missing or vague Boundaries section is a planning defect, not something the implementer should
  paper over; `docs://implementation-procedure` will refuse to proceed without one. It must state,
  explicitly and concretely:
  - **Files/directories the implementer must not touch** — real paths or globs, not "core files" or
    other vague language. If genuinely nothing is off-limits, say so outright ("Boundaries: none —
    full repo is in scope") rather than leaving the section thin or absent.
  - **What the implementer must not add on its own initiative**: new dependencies, new
    abstractions/helpers not named in a step, refactors of code the plan didn't ask to touch, tests
    beyond what a step specifies, and config/build/CI changes not listed under Files to change.
  - **Explicit stop conditions** — name the situations where the implementer must stop and report
    (§5 of `docs://implementation-procedure`) instead of guessing: an acceptance check that still
    fails after one fix attempt, a step that turns out to need a file outside Files to change, or any
    ambiguity this plan doesn't already resolve under Key decisions.
  - **A standing rule that Boundaries wins even when crossing it looks like the easier or more
    "correct" fix** — the implementer raises it (Open Questions / stop-and-report) instead of judging
    its way past the fence.
- **Prefer many small steps over few clever ones.** A judgment call either gets decided in the plan
  (record it under Key decisions) or goes to Open Questions — never left implicit.

## 3. Decide: questions vs. clean

Judge whether **Open Questions** contains anything that genuinely blocks a confident plan — an
ambiguity only the ticket's author can resolve, not something you can settle from the codebase or a
sensible default.

**Structural decisions always block, even when a sensible default exists.** Route to `state:review`
never happens here — these go to `state:needs-input` regardless of how reasonable a default seems:

- **Schema/data-model changes** to existing tables — adding/removing/renaming a column, changing a
  primary key, altering types/constraints, any migration that rewrites or backfills existing rows.
- **Destructive or irreversible operations** — deleting data, dropping tables/columns, or anything a
  rollback can't cleanly undo.
- **Public contract changes** — new/changed/removed routes or URLs, or a change to a public
  API/response shape.

State your recommended option in the question so the author can confirm with a one-word reply.
Non-structural ambiguities you can settle from the codebase or a safe default stay `clean` (note them
under Open Questions as "confirm at review" instead of blocking on them).

## 4. Commit the plan file

**Always `git add`/`git commit` the plan file before finishing.** Unlike `ai-intake-harness` (where
a poller commits the plan onto the branch after the worker exits), there's no poller here — nothing
else will ever commit it for you. An uncommitted plan file is invisible to `git log`, isn't protected
by anything, and is silently lost if the worktree is ever removed (including via `worktree_remove`).

```bash
git add .ai/plans/active/<KEY>-<slug>.md
git commit -m "Plan: <KEY> <short summary>"
```

Never `git push` — same boundary as implementation sessions (`docs://implementation-procedure`).

## 5. Report back and transition

**Always call `tracker_add_comment` before finishing** — it's the ticket's record of what you did.
`ai-intake-mcp` stamps the footer for you; just write the body.

**Has blocking questions:**
1. `tracker_add_comment(key, "Drafted/refined the plan at .ai/plans/active/<KEY>-<slug>.md. I need answers before finalizing:\n1. <question>\n2. <question>")`
2. `tracker_transition(key, "needs-input")`

**No blocking questions:**
1. `tracker_add_comment(key, "Plan ready for review at .ai/plans/active/<KEY>-<slug>.md. Summary: <2-4 sentence summary of approach, files, and key decisions>.")`
2. `tracker_transition(key, "review")`

That's the end of the session for this ticket. Do not attempt to move it further (`state:implement`
and beyond are implementation-phase — approved via `approve_plan`, not this procedure; see
`docs://implementation-procedure`).

## Guardrails

- Act on the one named ticket only.
- Always commit the plan file before reporting back — an uncommitted plan is not a finished plan.
- Always post a comment before transitioning — a transition without a summary comment is incomplete.
- Refine, don't regenerate, on re-pickup; accumulate the author's answers into the existing plan.
- Leave the plan `draft`. Flipping to `ready` happens via `approve_plan`, not here.
- Never `git push`.
- If something's off (unexpected ticket state, a tool refusal, anything that doesn't match this
  procedure), tell the developer and ask rather than forcing a transition or guessing past it.
