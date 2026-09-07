# Plan (draft): `ai-intake-mcp` — read the guide index's Last Modified column

**Status**: draft
**Created**: 2026-09-07
**Updated**: 2026-09-07
**Related**: `curated-guide-retrieval.md` (this repo's own guide-retrieval plan — this plan amends its
Design overview §1 table and the shape `index-parser.ts` must handle once built), companion write-side
plan in the sibling repo, `ai-intake-documentation-mcp`'s
`.ai/plans/draft/2026-09-07-add-a-last-modified-column-to-the-guide-index-write-side.md` (produces the
column this plan reads — **the two plans must stay in exact agreement** on column name, position, and
date format; treat either one drifting from the other as a bug in this plan, not a detail to
improvise past)

## Problem

`curated-guide-retrieval.md` already named this gap and deferred it: "Curation/staleness risk is
accepted as a tradeoff for control. Consider a 'last reviewed' column later." Right now the shared
guide index (Title | Description | Link | Tags) carries no signal for how recently a guide was
actually touched. Neither a human curator doing a review pass, nor the planning agent (once
`list_guides`/`fetch-guide.ts` exist) deciding whether to trust a matched guide, has anything to go
on for that.

This repo never writes the index — `ai-intake-documentation-mcp`'s `sync_guide` does. This plan is
the read side only: consuming a column the companion write-side plan above is responsible for
producing, updating this repo's own design spec and (once built) parser to expect it.

## Goals (v1)

- `curated-guide-retrieval.md`'s Design overview §1 example table is updated to show the 5th column
  now, so the not-yet-built implementation is spec'd correctly from the start instead of drifting
  from what the write side actually ships.
- The (not-yet-built) `src/confluence/index-parser.ts` parses a `Last Modified` column into a
  `lastModified` field on each row, matched by header text (not fixed column position) so a legacy
  4-column table (no `Last Modified` header at all) still parses cleanly with `lastModified`
  `undefined` on every row.
- Column contract — must match the write-side plan exactly:
  - Header text: `Last Modified`
  - Position: 5th column, appended after `Tags`
  - Format: `YYYY-MM-DD` (date only, no time component)
  - May be an empty string on a row the write side hasn't re-synced since its own migration —
    treated as "unknown," not an error.
- If/when `list_guides`/`fetch-guide.ts` (both still unbuilt per this repo's own Implementation steps
  below) surface guide metadata to the planning agent, include `lastModified` in that output — one
  more field alongside the title/description/tags they already return, no new tool.

## Out of scope (v1)

- Any staleness enforcement or alerting (e.g. auto-flagging guides past some age). Surfacing the date
  is enough for v1; acting on it is left to agent judgment — same "reuse mechanisms, don't build
  enforcement" precedent as this repo's own Key decision #2 (comment/plan-file signaling instead of
  new tooling).
- Anything on the write side: stamping the date, migrating an existing 4-column page in place. Fully
  owned by the companion `ai-intake-documentation-mcp` plan.
- Building `list_guides`/`fetch-guide.ts` themselves ahead of schedule if they don't already exist —
  this plan only makes sure their eventual output shape includes the field.

## Design overview

### 1. Updated index table shape (replaces the 4-column example in `curated-guide-retrieval.md` §1)

| Title | Description | Link | Tags | Last Modified |
|---|---|---|---|---|
| Symfony 4→5 Upgrade | Steps for upgrading 4.4 apps to 5.x | [link] | symfony, upgrade | 2026-09-07 |

### 2. `index-parser.ts` parsing

Parses the 5th column by header match, not fixed position — the same tolerance principle the
write-side plan applies to its own `parseIndexTable`, so a table in either shape (already migrated or
not yet) parses without special-casing "old vs. new."

### 3. Downstream surfacing

Once `list_guides` exists, its per-guide output includes `lastModified` alongside the fields it
already returns for the 4-column shape today.

## Key decisions

### 1. Header-based column matching, not fixed 5-column position

Resolved: match `Last Modified` by header text. This is what makes tolerating a 4-column legacy table
possible without an explicit "which shape is this" branch — a table simply has the columns its header
row says it has.

### 2. No schema-version marker on the index page

Rejected adding an explicit version field/row to signal which column shape a given index is in.
Header-based matching already makes that unnecessary — same "don't build for a cost that hasn't been
observed" reasoning this repo already applies elsewhere (e.g. Key decision #3, no persistent cache).

## Implementation steps (draft)

1. Update `curated-guide-retrieval.md`'s Design overview §1 table to the 5-column shape above — a
   spec fix, no code, can land immediately regardless of build order on either side.
2. When `src/confluence/index-parser.ts` is built (this repo's own Implementation step 2), parse
   `Last Modified` by header match into `lastModified`, tolerant of its absence.
3. When `src/tools/list-guides.ts` is built (Implementation step 3), include `lastModified` in its
   output.
4. Before implementing step 2, re-read the companion write-side plan's then-current state rather than
   this plan's description alone, in case its column name/format/migration behavior changed since
   this was written.

## Verification

1. Unit tests for `index-parser.ts` (once it exists): a 5-column fixture parses `lastModified`
   correctly; a legacy 4-column fixture (no `Last Modified` header) still parses without crashing,
   `lastModified` undefined on every row.
2. Round-trip check against a real page: once the companion plan has shipped and run its own live dry
   run (migrating the real index page), confirm this repo's parser reads that same live page
   correctly — the two independently-built parsers agreeing on the exact same shape is the actual
   point of this plan, same as this repo's existing guide-authoring companion relationship already
   requires for the base four columns.
3. Specifically check for an off-by-one date bug: a `2026-09-07` cell must parse to that exact
   calendar date, not the day before/after — a classic failure mode when a date-only string is
   round-tripped through a timezone-aware `Date` object.
