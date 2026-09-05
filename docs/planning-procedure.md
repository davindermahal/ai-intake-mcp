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
  **accumulate** the Q&A — never overwrite from scratch. Folding an answer in means flipping that
  question's `- [ ]` to `- [x]` (see "Open Questions format" below), not deleting the line.
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
**Implementation order**, **Testing strategy**, **QA Plan**, **Boundaries**, **Open Questions**,
**Confirm at Review**. Leave `**Status**: draft` — flipping to `ready` happens via the `approve_plan`
tool, a separate human
decision this planning session never makes itself.

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

### `## Testing strategy` — required, test-first (TDD)

Verification is never an afterthought bolted on once code exists — every plan is written test-first.
For each Implementation order step that changes behavior, split it into a paired test step and
implementation step rather than one combined step:

1. **Test step** — write the test(s) for that unit of behavior *before* the code exists to satisfy
   them. At minimum, one test for the intended (passing) behavior; where a failure/error path is
   meaningful (invalid input, a boundary condition, an error the code must handle), at least one test
   for that path too — a step that only tests happy paths is incomplete. The step's acceptance check
   is that the new test(s) **fail against the current code, for the expected reason** (red) — this is
   what proves the test actually exercises something real, not a false-positive pass from a typo or
   a vacuous assertion.
2. **Implementation step** — write the minimal code to satisfy those tests. Its acceptance check is
   that the same test(s) now **pass** (green), *and* that the project's full existing test suite
   still passes (no regression) — not just the new tests in isolation.

A step that's genuinely non-behavioral (pure config, docs, a rename with no logic change) may skip
this pairing — but say so explicitly in the plan ("no test needed — config only"), the same way
`## Boundaries` requires "none — full repo in scope" to be stated outright rather than the section
being thin or silently absent. Never omit test steps because "the change is simple" — simple changes
regress silently too.

Add a short `## Testing strategy` section naming: which test command(s) this project actually uses
(from `.ai/intake-mcp.md`/`make test` — same convention `docs://implementation-procedure` already
relies on), and, for each Implementation order group, a one-line note on what's being tested and how
(pass path + fail/error path). This is required on every plan, same standing as `## Boundaries` — not
optional, not something to add only when asked.

### `## QA Plan` — required: automated coverage vs. what a human must verify

`## Testing strategy` above proves the code's *logic* is correct against whatever the automated
suite can observe — mocked APIs, fake dependencies, in-process assertions. It cannot prove the
change actually works against anything the suite doesn't (or can't) exercise for real: a real
external API/service, real timing, a real UI a human has to look at, a new unattended/scheduled
process, real credentials, real file/process interaction. Every plan states, explicitly, both halves
— what's already covered by `## Testing strategy`, and, separately, exactly what still needs a human
to manually verify and how.

Write each manual-verification item as a literal, checkable step — the same "write for a weaker
executor" standard as `## Implementation order`: exact commands, exact URLs/UI paths a person clicks
through, exact pass/fail criteria — never "verify it works" or "test thoroughly." Whoever executes
this section may not be you, and may not even be technical beyond following exact steps.

A plan whose manual-QA surface is genuinely large (multiple real-system integrations, a new
unattended/scheduled process, anything a soak test would meaningfully validate, several distinct
failure modes worth deliberately injecting) should split it into a companion QA plan file
(`.ai/plans/active/<slug>-qa.md`, cross-linked from both directions — name it here, in this section,
and add this plan to the QA plan's own "Related") rather than bloating this section past readability.
`.ai/plans/active/headless-automation-qa.md` is the reference example of that shape: phased, each
phase with an objective, literal steps, and explicit pass/fail criteria, ending in a sign-off
checklist.

If a change genuinely has no manual-QA surface at all (a pure internal refactor, nothing outside the
existing automated suite's reach), say so outright — `"None — automated coverage above is
sufficient, no real external system is touched by this change"` — rather than leaving the section
thin or silently absent. Same standard as `## Boundaries`'s "none — full repo in scope": an explicit,
deliberate "none" is fine; a thin or missing section is not, and is treated as a planning defect the
same way a missing `## Boundaries` is.

### `## Open Questions` and `## Confirm at Review` format — required, both checked by `approve_plan`

Two separate sections, both GitHub-style task-list lines (`- [ ]` while unresolved, `- [x]` once
resolved), split by whether the pipeline can proceed without a human answer:

- **`## Open Questions`** — genuinely blocking: an ambiguity only the ticket's author can resolve,
  not something you can settle from the codebase or a sensible default. Drives the `state:needs-input`
  branch of §5 below (and, for a headless run, the orchestrator's own routing — same distinction,
  same section, different mechanism reading it).
- **`## Confirm at Review`** — non-blocking: you've already settled it (from the codebase or a safe
  default) and just want a reviewer's nod, not new information. Never sends a plan to
  `state:needs-input` — it goes to `state:review` in §5's "no blocking questions" branch, same as a
  plan with no open items at all. State your recommended choice in the item itself.

`approve_plan` parses **both** sections and **refuses to approve while any `- [ ]` item remains in
either one** — a "confirm at review" note doesn't get a pass just because it was never blocking.
That's the point: it forces whoever reviews the plan to actually engage with every item (edit the
plan to check it off, accepting the noted default, rather than approving with something silently
unaddressed). Resolving an item means flipping `[ ]` → `[x]` in place — never delete the line; it's
the plan's own record of what was raised and how it was settled, the same audit-trail habit this
project's own dogfooding plans already keep as a separate "Resolved" section. If a plan truly has
nothing for one of the sections, write `None` under its heading rather than omitting the heading.

## 3. Decide: questions vs. clean

Judge whether anything genuinely blocks a confident plan — an ambiguity only the ticket's author can
resolve, not something you can settle from the codebase or a sensible default.

**Structural decisions always block, even when a sensible default exists — these go under
`## Open Questions`, never `## Confirm at Review`.** Route to `state:review` never happens here —
these go to `state:needs-input` regardless of how reasonable a default seems:

- **Schema/data-model changes** to existing tables — adding/removing/renaming a column, changing a
  primary key, altering types/constraints, any migration that rewrites or backfills existing rows.
- **Destructive or irreversible operations** — deleting data, dropping tables/columns, or anything a
  rollback can't cleanly undo.
- **Public contract changes** — new/changed/removed routes or URLs, or a change to a public
  API/response shape.

State your recommended option in the question so the author can confirm with a one-word reply,
written as `- [ ]` under `## Open Questions`. Non-structural ambiguities you can settle from the
codebase or a safe default go under `## Confirm at Review` instead, written the same way (`- [ ]`,
with your recommendation stated) — the reviewer checks them off, or reopens one, before calling
`approve_plan`. Never mix the two under one heading.

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
