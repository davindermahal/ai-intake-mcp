# Plan: `ai-intake-mcp` — read the guide index's Last Modified column

**Status**: complete — all 5 Implementation order steps done, write-side contract re-confirmed (no
drift), full suite green (`npm test`: 376 passed, 3 skipped, 0 failed; `npm run build`/`npm run
lint` clean), and QA Plan's real-system round-trip check passed against the live Confluence index
— see "Real-system verification" under QA Plan below.
**Branch**: task/guide-index-last-mod-column
**Created**: 2026-09-06
**Updated**: 2026-09-07
**Related**: `.ai/plans/completed/curated-guide-retrieval.md` (this repo's own guide-retrieval plan —
**complete**: all 7 Implementation steps done, real-Confluence QA passed, Verdict: GO. It's in
`completed/` now, and per `.ai/README.md`'s convention that directory's files are "never edited
again, only superseded by a new plan" — so this plan does **not** edit its table; this plan's own
Design overview below is the up-to-date spec for the index shape, and the "Curation/staleness"
bullet in `curated-guide-retrieval.md`'s Design overview §1 already points forward to this plan),
companion write-side plan in the sibling repo, `ai-intake-documentation-mcp`'s
`.ai/plans/completed/2026-09-07-add-a-last-modified-column-to-the-guide-index-write-side.md`
(produces the column this plan reads — merged to that repo's `main` via PR #3, **Verdict: GO**,
real dry run against the live `QT` space; one implementation-strategy deviation noted there —
their `parseIndexTable` reads the 5th column positionally-with-tolerance rather than by header
text — but the on-wire contract this plan depends on, header text/position/format, is unaffected.
That plan explicitly left its own "Verification #3" — this repo's round-trip check — for this plan
to close; done, see QA Plan below)

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

## Implementation order (all done)

1. **Done.** Re-read the companion write-side plan
   (`ai-intake-documentation-mcp`'s `.ai/plans/draft/2026-09-07-add-a-last-modified-column-to-the-guide-index-write-side.md`).
   Column name (`Last Modified`), position (5th, after `Tags`), and date format (`YYYY-MM-DD`) all
   matched this plan's Column contract exactly — no drift, proceeded as planned.
2. **Done.** Added the three fixtures to `test/confluence/index-parser.test.ts`: a 5-column fixture
   with a real date value, a 5-column fixture with an empty `Last Modified` cell, and an assertion on
   the existing legacy 4-column fixture. Confirmed red first: the "has a value" case failed with
   `expected undefined to be '2026-09-06'` (the other two passed trivially, since an absent field is
   already `undefined`) — exactly the expected red state.
3. **Done.** `src/confluence/index-parser.ts`: added `lastModified?: string` to `GuideIndexEntry`;
   `parseGuideIndex` now reads the header row's cells via `captureAll`/`stripTags`, finds
   `indexOf("Last Modified")`, and reads that column per row (`undefined` if the header is absent or
   the cell strips to empty). All 7 tests in that file passed after, full suite green.
4. **Done.** Added a case to `test/tools/list-guides.test.ts` covering both a `lastModified` value
   passing through and an entry with no `Last Modified` cell coming back `undefined`. Confirmed red
   first: `expected undefined to be '2026-09-06'`.
5. **Done.** `src/tools/list-guides.ts`: added `lastModified?: string` to `ListGuidesResult`'s guide
   type and to the `.map()` projection. All 4 tests in that file passed after, full suite green.

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
`sync_guide` actually produces. Manual verification below, done.

### Real-system verification (2026-09-07) — PASSED

The write-side plan's own real dry run (see **Related** above) left a live artifact: the shared
`QT` space's index page (`dmahal.atlassian.net`, page id 196804) is genuinely 5 columns now, with
one row re-synced (stamped) and one row untouched since before the migration — exactly the mixed
state this plan's Column contract needs to prove itself against.

1. **Done.** Called the real `list_guides` tool (this MCP server connected, `CONFLUENCE_GUIDE_INDEX_URL`
   configured) and inspected the raw response:
   ```json
   {"configured":true,"guides":[
     {"title":"Symfony 4→5 Upgrade","description":"...","tags":["symfony","upgrade"]},
     {"title":"QA Test: Attachment and Last Modified","description":"...","tags":["qa-test"],
      "lastModified":"2026-09-07"}
   ]}
   ```
2. **Done, both halves.** The re-synced row ("QA Test: Attachment and Last Modified") came back with
   `lastModified: "2026-09-07"`, in `YYYY-MM-DD` shape, matching the exact date the write side's own
   Real run log independently confirmed it stamped on that same row via a direct Confluence API check
   — the two independently-built parsers agree on the real page, not just on matching fixtures. The
   untouched "Symfony 4→5 Upgrade" row correctly has **no** `lastModified` key at all (`undefined`,
   per Key decision #1/#3 — not `""`, not fabricated) — proving the "blank cell on an unmigrated row"
   half of the contract against a real page, not just a unit-test fixture. (Not personally
   re-confirmed by opening the Confluence page in a browser — relying on the write side's own
   independent real-API confirmation of the same value, which is the actual point of this
   cross-repo check; same non-blocking caveat already carried in `curated-guide-retrieval.md`'s
   Verification section about UI-level visual confirmation.)
3. **Done.** The re-synced row's date came back as exactly `"2026-09-07"` — no off-by-one shift.
   Confirms Key decision #3 (never constructing a `Date` object from this value) in practice, not
   just in theory.

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

- [x] Header-match lookup for `Last Modified` only, keeping the first four columns positional (Key
      decision #1) — implemented exactly this way; confirmed by
      `test/confluence/index-parser.test.ts`'s legacy-4-column and 5-column fixtures.
- [x] An empty `Last Modified` cell maps to `lastModified: undefined`, never `""` — implemented
      exactly this way; confirmed by the "maps an empty Last Modified cell to undefined" test.
