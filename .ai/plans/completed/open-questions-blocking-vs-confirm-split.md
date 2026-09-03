# Plan: split blocking Open Questions from non-blocking "confirm at review" notes

**Status**: completed
**Branch**: headless-automation
**Created**: 2026-09-03
**Updated**: 2026-09-03

## Goal

Fix a real bug found live during `headless-automation-qa.md` Phase E: a headless planning cycle
against `DAV-6` produced a genuinely clean plan (one structural question already resolved from the
ticket, one non-blocking "confirm at review, recommend as-is" note) but the ticket still bounced to
`state:needs-input` with a misleading "I need answers before finalizing" comment. Root cause:
`planHasUnresolvedOpenQuestions` (`src/plan-file.ts:106`) treats *any* unchecked `- [ ]` line under
`## Open Questions` as blocking — it has no way to tell a genuinely blocking question from the
prompt's own documented "confirm at review, non-blocking" convention (`docs/planning-procedure.md`
§3, `prompts/headless-planning.md` §2), since both are written with identical checkbox syntax.

This plan makes that distinction structural (a second section the code can tell apart), not
something inferred from prose tone — per the explicit preference that the code should do the
checking, not a trust in model self-discipline.

## Scope

**In scope:**
- `src/plan-file.ts`: a new `## Confirm at Review` section heading, a new
  `planHasBlockingOpenQuestions()` (scans only `## Open Questions`), and broadening the existing
  `planHasUnresolvedOpenQuestions()` to scan *both* sections.
- `src/automation/watchdog-pass.ts`: swap which function drives the `needs-input`/`review` routing
  decision to the new, narrower one.
- `prompts/headless-planning.md` and `docs/planning-procedure.md`: describe the two-section
  convention (both docs currently describe the single-section convention verbatim; decision #17/#22
  requires the headless prompt's prose to match this doc, so both need the same update).
- Tests for all of the above.

**Out of scope:**
- `src/tools/approve-plan.ts` — needs **zero** code changes. It calls
  `planHasUnresolvedOpenQuestions`, whose broadened definition already covers the new section, so its
  existing "refuse until every item, blocking or not, is checked off" guarantee is preserved exactly,
  not weakened. A test confirms this rather than assuming it.
- Adding a new "required, non-empty" structural gate for `## Confirm at Review` (parallel to
  `## Boundaries`/`## Testing strategy`/`## QA Plan`'s gates in `approve-plan.ts`) — its absence is
  treated the same as "nothing to confirm," matching how `## Open Questions` itself is already
  leniently handled today (its absence doesn't block approval either). A real, separate ask if wanted
  later, not bundled into this bugfix.
- Migrating already-committed plan files (`DAV-6`'s, `DAV-10`'s in `qa-headless-test-repo`) to the
  new format — this change is backward compatible with the old single-section convention (see Key
  decisions), not a migration.
- Any change to `src/ai/`, `src/jira/`, `dispatch.ts`, `registration.ts`, or any script.

## Files to change

- `src/plan-file.ts` — add `CONFIRM_AT_REVIEW_HEADING`; add `planHasBlockingOpenQuestions()`; broaden
  `planHasUnresolvedOpenQuestions()`.
- `src/automation/watchdog-pass.ts` — routing call site swap (one line).
- `prompts/headless-planning.md` — Open Questions format + "decide blocking vs. clean" sections.
- `docs/planning-procedure.md` — the same two sections, kept in sync (this doc is what the headless
  prompt quotes from).
- `test/plan-file.test.ts` — new/updated unit tests.
- `test/automation/watchdog-pass.test.ts` — routing test for the blocking/non-blocking distinction.
- `test/tools/approve-plan.test.ts` — regression test: still refuses on an unresolved
  `## Confirm at Review` item.
- `.ai/plans/active/headless-automation-qa.md` — mark the Phase E finding fixed, cross-link this plan.

## Key decisions

- **Section name: `## Confirm at Review`.** Reuses the exact phrase both docs already use repeatedly
  ("note them under Open Questions as `- [ ]` 'confirm at review'") — minimal churn, immediately
  recognizable to anyone already using the current convention.
- **`planHasUnresolvedOpenQuestions` keeps its name and signature.** Its *definition* broadens to
  "any unchecked `- [ ]` in `## Open Questions` OR `## Confirm at Review`." `approve-plan.ts`'s call
  site needs no edit at all — this is deliberate: the safety net it provides (a human must explicitly
  acknowledge every item, blocking or not, before real implementation starts) must not weaken.
- **New `planHasBlockingOpenQuestions` scans only `## Open Questions`.** This is what
  `watchdog-pass.ts` calls for the `needs-input`/`review` routing decision — the actual bug fix.
- **Backward compatible by construction.** A plan using only the old single-section convention has
  no `## Confirm at Review` heading at all; `sectionBody` returns `undefined` for a heading that
  isn't present, and both functions already treat "section absent" as "nothing to check" (the same
  existing lenient behavior `## Open Questions`'s own absence already gets today). Old plans keep
  working exactly as before under both functions.
- **No new structural "required and non-empty" gate for the new section** (see Scope) — keeps this
  fix minimal and focused on the actual reported defect.

## Implementation order

1. **Test** — in `test/plan-file.test.ts`, add fixtures/tests for `planHasBlockingOpenQuestions`
   (new) and the broadened `planHasUnresolvedOpenQuestions`: (a) unresolved item only in
   `## Confirm at Review` → blocking-check is `false`, unresolved-check is `true`; (b) unresolved item
   in `## Open Questions` → both `true`; (c) both sections absent → both `false`; (d) both sections
   present and fully resolved → both `false`.
   **Acceptance check**: `npx vitest run test/plan-file.test.ts` fails (function doesn't exist yet /
   current behavior doesn't match).
2. **Implement** — `src/plan-file.ts`: add `CONFIRM_AT_REVIEW_HEADING = /^##\s+Confirm at Review\s*$/m`,
   `planHasBlockingOpenQuestions(planPath)` (mirrors the current `planHasUnresolvedOpenQuestions`
   body but only checks `OPEN_QUESTIONS_HEADING`'s section), and change
   `planHasUnresolvedOpenQuestions` to `true` if either section's body matches `UNCHECKED_TASK_ITEM`.
   **Acceptance check**: `npx vitest run test/plan-file.test.ts` passes, including step 1's new cases
   and every pre-existing case in the file.
3. **Test** — in `test/automation/watchdog-pass.test.ts`, add a case: a plan fixture with
   `## Open Questions` fully resolved (`- [x]`) but `## Confirm at Review` carrying one unresolved
   `- [ ]` item → assert the watchdog transitions the ticket to `state:review` (not
   `state:needs-input`) and the posted comment is the "ready for review" one, not "I need answers."
   **Acceptance check**: fails against the current `watchdog-pass.ts` (still calls the
   unresolved-in-either-section check).
4. **Implement** — `src/automation/watchdog-pass.ts`: swap the routing call from
   `planHasUnresolvedOpenQuestions` to `planHasBlockingOpenQuestions` (import + one call-site
   change; the variable/heading-message logic around it is unchanged).
   **Acceptance check**: step 3's new test passes; `npx vitest run test/automation/watchdog-pass.test.ts`
   fully green (no regressions on existing needs-input/review cases).
5. **Test** — in `test/tools/approve-plan.test.ts`, add a case: `## Open Questions` fully resolved,
   `## Confirm at Review` has one unresolved item → assert `approvePlanTool` still throws (the
   "no weakening" regression guard).
   **Acceptance check**: passes once step 2 lands (no `approve-plan.ts` code change needed) — still
   written and run before/alongside step 2 to prove the guarantee holds, not assumed.
6. **Docs** — update `prompts/headless-planning.md`: the "Open Questions format" subsection gains a
   short paragraph introducing `## Confirm at Review` (non-blocking, reviewed but never routes to
   needs-input) alongside `## Open Questions` (blocking); the "Decide: blocking questions vs. clean"
   section's instruction to "note them under Open Questions as `- [ ]` 'confirm at review'" changes
   to "note them under a separate `## Confirm at Review` section as `- [ ]`."
   **Acceptance check**: read-through; no remaining sentence tells the worker to mix both kinds under
   one heading.
7. **Docs** — apply the same update to `docs/planning-procedure.md`'s equivalent §2/§3 text, keeping
   the two documents' language for this convention consistent (the headless prompt is meant to quote
   this doc, per its own header comment).
   **Acceptance check**: read-through; both documents describe the identical two-section convention.
8. **Full verification** — `npm run build && npm run lint && npm test`.
   **Acceptance check**: all three green, full suite passing (no regressions anywhere else that
   touches plan-file parsing, e.g. `implementation-pass.ts`'s own plan-status checks, which don't use
   these two functions and shouldn't be affected, but the full run confirms it).
9. **Update the QA plan** — `.ai/plans/active/headless-automation-qa.md`'s Phase E "Bug 3" note:
   change from "not yet fixed" to "fixed", cross-linking this plan file.
10. **Commit.**

## Testing strategy

This project's test command is `npm test` (vitest). Every step above is paired test-then-implement,
per `docs://planning-procedure`'s TDD requirement:

- `test/plan-file.test.ts`: pure unit tests, no I/O beyond the file's existing `mkdtempSync` temp-dir
  convention. Pass path: correct `true`/`false` for each of the four section-combination cases above.
  Fail/error path: both sections entirely absent must not throw and must return `false`/`false` (no
  false positives from a missing heading) — mirrors the existing `sectionBody` returning `undefined`
  behavior already relied on elsewhere in this file.
- `test/automation/watchdog-pass.test.ts`: existing mocked-Jira-client pattern in this file: asserts
  the actual `state:` transition target and comment text chosen for the new blocking/non-blocking
  fixture, alongside the file's existing needs-input/review cases (which must keep passing
  unchanged — they only involve `## Open Questions`, never touching the new section).
- `test/tools/approve-plan.test.ts`: existing mocked-client pattern: asserts `approvePlanTool` throws
  for the new "unresolved item only in `## Confirm at Review`" fixture, proving the safety net named
  in Key decisions actually holds rather than being assumed.
- Full suite (`npm test`) confirms no regression elsewhere.

## QA Plan

- **Automated coverage**: fully covers this change. It's pure string/regex parsing logic against
  plan-file fixtures — no real external system (Jira, a CLI, a real headless process) is touched by
  the code itself, so the unit tests above are a complete, deterministic proof of correctness.
- **Manual verification**: none required for the code change itself. Optional, not required: a future
  real headless planning run that produces a genuine "confirm at review" note would additionally
  confirm this end-to-end in practice — `headless-automation-qa.md` Phase E already did exactly this
  once (that's how the bug was found); not re-spending real API cost here solely to re-confirm a
  parsing fix that deterministic unit tests already cover completely.

## Boundaries

- **Files/directories not to touch**: anything under `src/ai/`, `src/jira/`,
  `src/automation/dispatch.ts`, `src/automation/registration.ts`, `scripts/` — this change is scoped
  entirely to plan-file parsing, the one watchdog routing call site, the two documentation files, and
  their tests.
- **Do not touch already-committed plan files** in `qa-headless-test-repo` (`DAV-6`'s, `DAV-10`'s) —
  this change is backward compatible with them by construction, not a migration; leave them as-is.
- **Do not add a new "required, non-empty" gate** for `## Confirm at Review` in `approve-plan.ts` —
  explicitly out of scope (see Scope/Key decisions). If wanted later, that's a separate, deliberate
  change.
- **Do not edit `src/tools/approve-plan.ts`'s source at all.** If step 5's test reveals it actually
  needs a change, that means the call-site assumption in this plan is wrong — stop and report rather
  than guessing past it.
- Never `git push`.

## Open Questions

- [x] Section name: `## Confirm at Review` vs. an alternative like `## Reviewer Notes`. Resolved:
      keep `## Confirm at Review` — matches the exact phrase already used throughout both existing
      docs, least disruptive to anyone already used to that language.
- [x] Whether `## Confirm at Review` needs its own "required, non-empty" `approve_plan` gate.
      Resolved: no — out of scope for this bugfix (see Key decisions); a separate change if wanted.
