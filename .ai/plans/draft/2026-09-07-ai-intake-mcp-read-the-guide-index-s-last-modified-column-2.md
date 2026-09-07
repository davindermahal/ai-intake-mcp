# Plan: `ai-intake-mcp` — read the guide index's Last Modified column

**Status**: draft
**Branch**: task/guide-index-last-mod-column
**Created**: 2026-09-06
**Updated**: 2026-09-06
**Related**: `.ai/plans/completed/curated-guide-retrieval.md` (this repo's own guide-retrieval plan —
now **complete**: all 7 Implementation steps done, real-Confluence QA passed, Verdict: GO. It's in
`completed/` now, and per `.ai/README.md`'s convention that directory's files are "never edited
again, only superseded by a new plan" — so this plan does **not** edit its table; this plan's own
Design overview below is the up-to-date spec for the index shape, and the "Curation/staleness"
bullet in `curated-guide-retrieval.md`'s Design overview §1 already points forward to this plan),
companion write-side plan in the sibling repo, `ai-intake-documentation-mcp`'s
`.ai/plans/draft/2026-09-07-add-a-last-modified-column-to-the-guide-index-write-side.md` (produces the
column this plan reads — **the two plans must stay in exact agreement** on column name, position, and
date format; treat either one drifting from the other as a bug in this plan, not a detail to
improvise past)

## Goal

`src/confluence/index-parser.ts` and `src/tools/list-guides.ts` — both already implemented, real-QA
validated as part of `curated-guide-retrieval.md`, and currently reading a fixed 4-column
(Title | Description | Link | Tags) index table — parse and surface a 5th `Last Modified` column,
tolerant of the legacy 4-column shape, so a curator or (once an agent consumes `list_guides`) the
planning agent has a staleness signal for a matched guide. This repo never writes the index —
`ai-intake-documentation-mcp`'s `sync_guide` does; this plan is the read side only.

## Scope

**In:**
- This plan's own Design overview §1 below is the up-to-date 5-column index table shape — the
  authoritative spec going forward, superseding (not editing) the 4-column table in the now-completed
  `curated-guide-retrieval.md`.
- `index-parser.ts` parses a `Last Modified` column into a `lastModified` field on each row, matched
  by header text (not fixed column position), so a legacy 4-column table (no `Last Modified` header at
  all) still parses cleanly with `lastModified` `undefined` on every row.
- Column contract — must match the write-side plan exactly:
  - Header text: `Last Modified`
  - Position: 5th column, appended after `Tags`
  - Format: `YYYY-MM-DD` (date only, no time component), kept as a raw string end-to-end (see
    Boundaries — no `Date`-object round-trip anywhere in this change)
  - An empty cell (row not yet re-synced since the write side's own migration) maps to `lastModified:
    undefined`, not an error and not `""`.
- `list_guides`'s output (`src/tools/list-guides.ts`) includes `lastModified` alongside the
  title/description/tags it already returns — one more field, no new tool.

**Out:**
- Any staleness enforcement or alerting (e.g. auto-flagging guides past some age). Surfacing the date
  is enough for v1; acting on it is left to agent judgment.
- Anything on the write side: stamping the date, migrating the real index page in place. Fully owned
  by the companion `ai-intake-documentation-mcp` plan.
- `fetch_guide` (`src/tools/fetch-guide.ts`) — it returns only `{ title, content }`, no catalog
  metadata at all today (not description/tags/link either); adding `lastModified` there is a separate,
  unrelated change this plan doesn't make.
- Re-deriving `title`/`description`/`link`/`tags` by header lookup. Their contract (fixed first four
  columns) isn't changing; only the new 5th column needs header-based tolerance.
- Editing `.ai/plans/completed/curated-guide-retrieval.md` — it's completed; see **Related** above.

## Design overview

### 1. Updated index table shape (supersedes the 4-column table in `curated-guide-retrieval.md` §1)

| Title | Description | Link | Tags | Last Modified |
|---|---|---|---|---|
| Symfony 4→5 Upgrade | Steps for upgrading 4.4 apps to 5.x | [link] | symfony, upgrade | 2026-09-06 |

## Files to change

- `src/confluence/index-parser.ts` — add `lastModified?: string` to `GuideIndexEntry`; look up the
  `Last Modified` column by header text and read it per row, tolerant of the header being absent.
- `test/confluence/index-parser.test.ts` — add fixtures: a 5-column table (with and without a value in
  the `Last Modified` cell) plus the existing legacy 4-column fixture, asserting `lastModified` in each
  case.
- `src/tools/list-guides.ts` — add `lastModified` to `ListGuidesResult`'s guide type and to the
  `.map()` projection.
- `test/tools/list-guides.test.ts` — add a case asserting `lastModified` passes through from the
  catalog entry into `listGuides()`'s output, both defined and `undefined`.

## Key decisions

1. **Header-based column matching for `Last Modified` only, not a fixed 5th-position read.** Resolved:
   locate the column by matching the header row's cell text against `"Last Modified"`, not by assuming
   index 4. This is what makes tolerating a 4-column legacy table possible without an explicit
   "which shape is this" branch — a table simply has the columns its header row says it has. The
   existing four columns stay positional (see Scope → Out); only this one addition needs the lookup.
2. **No schema-version marker on the index page.** Rejected adding an explicit version field/row to
   signal which column shape a given index is in. Header-based matching already makes that
   unnecessary — same "don't build for a cost that hasn't been observed" reasoning
   `curated-guide-retrieval.md` already applies elsewhere (its Key decision #3, no persistent cache).
3. **`lastModified` stays a raw string end-to-end, never parsed into a `Date`.** Avoids the timezone
   off-by-one failure mode named in QA Plan #3 below — there is no need to parse it as a `Date` for
   anything this plan does (display/pass-through only), so the safest choice is to never construct one.
4. **This plan's own Design overview supersedes `curated-guide-retrieval.md`'s table, rather than
   editing it.** That plan is now in `.ai/plans/completed/`, and `.ai/README.md`'s convention is that
   completed plans are "never edited again, only superseded by a new plan." Earlier drafts of this
   plan (written while the base plan was still `active/`) included a step to edit that table directly;
   corrected once the base plan completed and moved.

## Implementation order

1. **Re-confirm the write-side contract.** Before writing any code, read the companion write-side
   plan at the path under **Related** above and confirm its column name, position, and date format
   still exactly match the Column contract in this plan's Scope section. Acceptance check: the three
   values match; if any have drifted, stop and update this plan's Column contract first rather than
   implementing against a stale assumption (see Boundaries).
2. **Test step — `index-parser.ts` fixtures.** In `test/confluence/index-parser.test.ts`, add:
   - A 5-column fixture whose header row includes `<th><p>Last Modified</p></th>` and whose data rows
     each end with `<td><p>YYYY-MM-DD</p></td>`; assert the parsed entries include `lastModified` equal
     to that exact string.
   - A 5-column fixture with an empty `Last Modified` cell (`<td><p></p></td>`) on one row; assert that
     row's `lastModified` is `undefined`.
   - The existing legacy 4-column fixture (already in the file, no `Last Modified` header at all);
     assert `lastModified` is `undefined` on every row and parsing doesn't throw.
   Acceptance check: `make test` — the new "has a value" case fails (red), because
   `parseGuideIndex` doesn't read a 5th column yet.
3. **Implementation step — `index-parser.ts` parsing.** In `src/confluence/index-parser.ts`: add
   `lastModified?: string` to the `GuideIndexEntry` interface; from the header row's cells (already
   captured via `captureAll` on `rows[0]`), compute `headerCells.map(stripTags)` and
   `indexOf("Last Modified")`; in the per-row loop, if that index exists, read `cells[thatIndex]`
   through `stripTags`, and set `lastModified` to that value or `undefined` if it strips to an empty
   string; if the index doesn't exist, `lastModified` is always `undefined`. Acceptance check:
   `make test` — all three Step 2 cases pass, and the full suite (`make test`) is still green (no
   regression in the pre-existing 4-column tests already in that file).
4. **Test step — `list-guides.ts` pass-through.** In `test/tools/list-guides.test.ts`, add a case
   (using the same catalog-stubbing pattern the existing tests in that file already use) asserting that
   when a catalog entry has `lastModified: "2026-09-06"`, `listGuides()`'s returned `guides[]` entry
   includes `lastModified: "2026-09-06"`; and that an entry with `lastModified: undefined` comes back
   with `lastModified: undefined`. Acceptance check: `make test` — this new case fails (red), because
   `ListGuidesResult`'s mapping doesn't include `lastModified` yet.
5. **Implementation step — `list-guides.ts` pass-through.** In `src/tools/list-guides.ts`, add
   `lastModified` to `ListGuidesResult`'s guide type and to the `.map()` call
   (`catalog.map(({ title, description, tags, lastModified }) => ({ title, description, tags,
   lastModified }))`). Acceptance check: `make test` — Step 4's case passes, and the full suite is
   green.

## Testing strategy

Test command: `make test` (runs `npm test` → `vitest run`, inside this project's Docker dev image per
the `Makefile` — same command the rest of the suite already uses). Per Implementation order group:

- **Steps 2–3 (`index-parser.ts`):** pass path is a 5-column fixture with a real date value parsing to
  that exact string; fail/error path is covered by two cases, not one — an empty `Last Modified` cell
  (→ `undefined`, not `""` or a thrown error) and a legacy 4-column table with no `Last Modified`
  header at all (→ `undefined` on every row, no crash).
- **Steps 4–5 (`list-guides.ts`):** pass path is a catalog entry with a `lastModified` value passing
  through unchanged; fail/error path is a catalog entry with `lastModified: undefined` passing through
  as `undefined` rather than being coerced to `null`/`""`/omitted.

## QA Plan

Testing strategy above proves the parsing and pass-through logic against fixture HTML — it cannot
prove this repo's independently-built parser agrees with the real page `ai-intake-documentation-mcp`'s
`sync_guide` actually produces once the companion write-side plan ships. Manual verification, once
that companion plan has run its own live dry run (migrating the real guide index Confluence page):

1. From a session with this MCP server connected and `CONFLUENCE_GUIDE_INDEX_URL` configured, call the
   `list_guides` tool and inspect the raw response.
2. Confirm at least one returned guide includes a `lastModified` field in `YYYY-MM-DD` shape, and that
   the value matches what's visibly shown in the `Last Modified` column on the real Confluence index
   page for that same row (open the page in a browser and compare by eye).
3. Specifically check for an off-by-one date bug: a page cell showing e.g. `2026-09-06` must come back
   as exactly `"2026-09-06"` in the tool response — not the day before or after. Key decision #3 (never
   constructing a `Date` object from this value) should make this class of bug structurally impossible,
   but this step verifies that in practice, against a real value, not just in theory.

## Boundaries

- Must not touch `src/confluence/client.ts`, `src/confluence/storage-text.ts`, `src/jira/**`, or
  `src/automation/**` — unrelated to this column-read change.
- Must not touch the write side at all — no changes to the sibling `ai-intake-documentation-mcp` repo
  from this plan or any session implementing it.
- Must not edit `.ai/plans/completed/curated-guide-retrieval.md` — it's completed; see Key decision #4.
- Do not add a schema-version marker/field to the index page or its parser — Key decision #2 already
  rejected this; don't re-litigate it during implementation.
- Do not introduce any `Date`-object construction from the `lastModified` value anywhere in this
  change (parser output, `ListGuidesResult`, or otherwise) — keep it a raw `YYYY-MM-DD` string
  end-to-end, per Key decision #3.
- No new dependencies. No new abstractions beyond the header-index lookup described in Implementation
  order Step 3 — do not generalize `index-parser.ts` into a fully general HTML-table parser as part of
  this change.
- **Stop and report** rather than guessing past it if: an acceptance check still fails after one fix
  attempt, or Step 1's re-read finds the companion plan's column contract has drifted from this plan's.
- This standing rule wins even when crossing it looks like the easier or more "correct" fix — raise it
  under Open Questions / stop-and-report instead of judging past it.

## Open Questions

None.

## Confirm at Review

- [ ] Header-match lookup for `Last Modified` only, keeping the first four columns positional (Key
      decision #1) — recommended: yes, per the reasoning given there.
- [ ] An empty `Last Modified` cell maps to `lastModified: undefined`, never `""` — recommended: yes,
      matches "treated as unknown" in Scope.
