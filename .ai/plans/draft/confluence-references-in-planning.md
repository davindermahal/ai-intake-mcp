# Plan (draft): `ai-intake-mcp` — Confluence references during planning

**Status**: draft
**Created**: 2026-09-08
**Updated**: 2026-09-08 (added Key decision #8 — surface `lastModified` as a staleness signal on
explicit-link citations, distinct from curated guides' prescriptive status)
**Related**: `docs/planning-procedure.md` (interactive planning instructions, wiring point),
`prompts/headless-planning.md` (headless planning instructions — currently has no Confluence
integration at all), `src/automation/prompt-template.ts` (`renderPrompt`, gains `resolveIncludes`),
`src/jira/adf.ts` (`adfToPlainText`, the ticket-text extraction gap), `src/confluence/client.ts`/
`storage-text.ts` (existing fetch-by-URL + storage-to-text primitives this plan reuses),
`docs/_fragments/confluence-context.md` (new — the single source of truth this plan introduces),
`.ai/plans/completed/curated-guide-retrieval.md` (the existing curated-guide-index feature this
plan extends, not replaces), and a forthcoming companion plan in `ai-intake-documentation-mcp`
covering that repo's own consumption of a shared Confluence transport package (not yet written —
see Key decision #3).

## Problem

Today, Confluence access during planning is limited to a single curated guide index
(`list_guides`/`fetch_guide`, from `curated-guide-retrieval.md`) — deliberately narrow, "no raw
search." But real tickets increasingly name specific Confluence pages relevant to just that one
ticket (design docs, runbooks, decision records) that will never belong in the generic, reusable
guide index. There is currently no way to fetch a page that isn't already catalogued, whether:

- an operator names it directly during an interactive `plan_ticket` session, or
- the ticket's own description/comments already reference it, in either interactive or fully
  automatic (`prompts/headless-planning.md`, cron-dispatched) mode.

Two concrete gaps make this worse than "just add a fetch tool":

1. `adfToPlainText()` (`src/jira/adf.ts`) silently drops Jira's "smart link" card nodes
   (`inlineCard`/`blockCard`) and ignores `link` marks on text — so a Confluence URL a reporter
   pasted into a ticket, if Jira auto-chipped it, is already invisible to `tracker_get_issue`
   output today, in both planning modes.
2. Interactive and automatic planning are two independently hand-maintained instruction sets
   (`docs/planning-procedure.md` vs. `prompts/headless-planning.md`) that have already drifted:
   the former has a "Check for a relevant guide" step, the latter has no Confluence integration at
   all. Any new Confluence capability added to only one of them will re-drift immediately.

## Goals

- Ticket-referenced and operator-named Confluence pages are fetchable by URL during planning, in
  both interactive and headless mode, without expanding to raw/unbounded search.
- Whatever gets fetched from Confluence is always cited in the plan file and ticket comment a human
  reviews before approval — the existing `approve_plan`/`state:review` gate is the safety net, the
  same pattern already used for guides (`**Guides used**:`).
- Close the two structural gaps above (ADF smart-link blindness; interactive/headless instruction
  drift) as part of this work, not as a side effect — they'll keep causing silent gaps for every
  future Jira/Confluence feature otherwise.
- Leave room for a later "reference an area" capability (space- or page-tree-scoped browse/search,
  always surfaced for human review, never auto-applied) without needing to redesign the fetch layer.

## Out of scope (this plan)

- Raw/unbounded Confluence search or space-wide crawling — deferred to a later "area reference"
  phase (Key decision #1).
- Any change to the curated guide index (`list_guides`/`fetch_guide`) itself — this plan adds a
  second, explicit-link-scoped path alongside it, not a replacement.
- The `ai-intake-documentation-mcp` side of a shared transport package (its own
  `document_area`/`start_documentation` consumption, folding its write-path `ConfluenceClient` in)
  — companion plan, that repo, once this plan's shape is settled.
- Unifying `docs/planning-procedure.md` and `prompts/headless-planning.md` wholesale — only the
  Confluence-related step gets de-duplicated (Key decision #2); the rest of their drift is a
  separate, pre-existing problem this plan doesn't take on.

## Design overview

### 1. Fix ADF extraction to surface Confluence-shaped links

`src/jira/adf.ts`'s `adfToPlainText` (or a new sibling helper reusing the same walk) gains handling
for:

- `inlineCard`/`blockCard` nodes — emit their `attrs.url` inline (as the raw URL) instead of
  silently dropping the node.
- `text` nodes carrying a `link` mark — emit `attrs.href` alongside the visible text.

Callers (`tracker_get_issue` today) get this for free once the walker changes — no new tool needed
for this step alone.

### 2. One source of truth for the Confluence-context planning step

The "gather Confluence context for this ticket" instructions (guide-catalog check, new
explicit-link fetch, later area-search) live in exactly one file,
`docs/_fragments/confluence-context.md`, and both `docs/planning-procedure.md` §1 and
`prompts/headless-planning.md` §1 pull it in via a `{{INCLUDE:_fragments/confluence-context.md}}`
token (Key decision #7) — resolved at read time for the former (`registerDocResource`'s handler),
and at render time for the latter (`renderPrompt`, before its existing `{{VAR}}` substitution pass).
So headless planning stops being silently behind interactive planning the moment this step lands,
and stays that way for whatever gets added to that one fragment next.

### 3. Explicit-link fetch tool

A new MCP tool, `fetch_confluence_pages` (Key decision #6), taking `urls: string[]`, returning
per-URL `{url, title, content, lastModified, error?}` (partial-failure tolerant — one bad or
inaccessible link doesn't sink the whole batch). Built on the fetch-by-URL primitives that already
exist in this repo (`extractPageIdFromUrl`, `fetchPageByUrl` in `src/confluence/client.ts`,
`storageToPlainText` in `src/confluence/storage-text.ts`) — reused as-is initially, re-pointed at a
cross-repo shared package later (Key decision #3), not blocked on it.

`lastModified` (Key decision #8) comes from `version.when`, free on the same request once
`fetchPageByUrl`'s `expand` parameter includes `version` alongside `body.storage` — no second API
call, no new client method.

A URL only gets fetched if it passes both checks (Key decision #5):

1. Its hostname matches the resolved Confluence site (`confluenceSiteUrl ?? jiraSiteUrl` — the same
   fallback `ConfluenceClient` already applies for auth).
2. `extractPageIdFromUrl` can pull a page ID out of it.

Anything else (a Slack link, a GitHub link, a Confluence *space* URL with no page ID) is silently
skipped, not treated as an error — this is a filter over "things that might be Confluence links in
free text," not validation of an input the caller promised was one.

Two sources of URLs, both routed through the same tool:

- **Operator-named**: the `plan_ticket` prompt gains an optional `confluence_links` argument; the
  shared instructions fragment (#2) tells the agent to fetch them alongside the guide-catalog check.
- **Ticket-named**: the same instructions fragment tells the agent to scan the ticket's description
  and comments (now link-complete, per #1) for URLs and pass all of them through the same two-check
  filter above — same tool, no operator action required, works identically in headless mode.

### 4. Citation, not silent use — with a trust tier, not just a name

Plan file gains a `**Confluence pages referenced**:` header line, parallel to the existing
`**Guides used**:` line — populated whenever the new tool is called, omitted when it isn't.
`tracker_add_comment`'s summary instruction gains the same "name what was consulted" addition
already in place for guides. This is what keeps headless mode from being a wild-west path: nothing
fetched gets acted on before a human sees it cited and runs `approve_plan`.

The two fields already carry a coarse trust distinction for free — `**Guides used**:` is the
curated index (prescriptive, per `curated-guide-retrieval.md`'s existing instruction), `**Confluence
pages referenced**:` is arbitrary, unvetted pages that may be current, generic, or badly stale.
Key decision #8 sharpens the second bucket: each entry carries its `lastModified` date —
`**Confluence pages referenced**: [Title](url) — last updated 2021-03-14` — and the shared
instructions fragment (#2) tells the agent explicitly to treat these as background context, never
prescriptive, and to prefer what it can verify directly in the ticket or codebase over an old or
generic page when the two disagree.

## Key decisions

### 1. Explicit links now; "area" reference later, deliberately

"An area in Confluence" (a space or page-tree) is a browse/search operation, not a fetch-by-URL — a
materially different, riskier capability (unbounded result sets, relevance judgment, bigger context
cost) that deserves its own design pass once we've seen how the explicit-link path is actually
used. Designing the fetch tool's interface (Design #3) to not preclude a later `search`/
`listChildren` addition is sufficient for now — not building toward it further than that.

### 2. De-duplicate only the Confluence step, not the whole instruction pair

`docs/planning-procedure.md` and `prompts/headless-planning.md` have broader, pre-existing drift
(QA-plan/testing-strategy wording, etc.) that predates this plan and is out of scope here. Fully
unifying them is a bigger, separate effort; pulling just the Confluence-context step into one shared
fragment is small, directly motivated by this plan, and stops this specific feature from drifting
the way guide support already did between the two instruction sets.

### 3. Shared transport package deferred, not blocked on

Cross-repo direction so far (with `ai-intake-documentation-mcp`): fetch-by-URL + storage-to-text
conversion should eventually live in a shared package (`ConfluenceClient` + auth/retry +
`fetchPageByUrl` + `storageToPlainText` — transport only; policy like "curated titles only" or
"human must review" stays local to each server), since `ai-intake-mcp` today has zero
`@davindermahal/*` dependencies and this would be the first. That package doesn't need to exist
before this plan's tool ships: Implementation step 3 builds `fetch_confluence_pages` directly
against this repo's existing `src/confluence/client.ts`/`storage-text.ts`, and gets re-pointed at
the shared package later as a follow-up, once the companion `ai-intake-documentation-mcp` plan is
written and both sides agree on the package's exact API.

### 4. Human review stays structural, not a new mechanism

No new "review gate" tool — reusing `approve_plan`'s existing refusal-until-every-open-item-is-
resolved behavior, extended only by the new citation line (Design #4). This matches Key decision #2
of `curated-guide-retrieval.md` (reuse existing plan-file/ticket-comment hooks rather than invent
new tooling) and keeps headless mode's safety story identical to interactive mode's.

### 5. URL-matching rule: same host as the configured Confluence site, *and* a page-ID shape

**Resolves the former "exact URL-matching rule" open question.** Neither check alone is safe:

- **Hostname-only** would accept any URL on the Confluence site (e.g. a space overview with no page
  ID) — harmless (a 404 from `fetchPageByUrl`, caught by the tool's per-URL error handling), but
  wasteful and noisy in headless mode, attempting fetches that were never going to resolve.
- **Pattern-only** (just `extractPageIdFromUrl` succeeding) is the real risk: `fetchPageByUrl` never
  looks at the URL's own hostname, only the numeric ID it extracts, then queries *our own configured*
  Confluence site for that ID (`src/confluence/client.ts:151-157`). A ticket linking to some
  unrelated system whose URL shape happens to match `/pages/(\d+)` would cause us to query our own
  tenant for a coincidentally-matching ID — a wrong-content risk, not just a wasted call.

Requiring both — same host as `confluenceSiteUrl ?? jiraSiteUrl` (the resolution `ConfluenceClient`
already performs for auth, so no new config) *and* a successful `extractPageIdFromUrl` — closes both
gaps with no new configuration surface.

### 6. Tool name: `fetch_confluence_pages`

**Resolves the former "tool name" open question.** Matches this repo's existing object-based
naming (`fetch_guide`, `list_guides`, `tracker_get_issue` — named for what's fetched, not the shape
of the input), and leaves `search_confluence` free and unambiguous for the later area/browse
feature (Key decision #1).

### 7. Shared fragment via a minimal `{{INCLUDE:path}}` preprocessor, not a build step

**Resolves the former "how does the shared fragment actually get included" open question.**
`src/automation/prompt-template.ts`'s `renderPrompt` does flat `{{WORD}}` token substitution only —
no include/composition mechanism exists today, and `docs/planning-procedure.md` is served verbatim
by `registerDocResource` (a plain `readFileSync` at read time, `src/index.ts:312-321`) — genuinely
different code paths, not one shared loader. Rather than unify those loaders (bigger, riskier change
for what's needed here) or hand-copy the fragment into both files (the exact drift this plan exists
to stop), add one small function — `resolveIncludes(content: string): string`, resolving
`{{INCLUDE:relative/to/docs/path.md}}` tokens by reading and splicing that file's contents — called
by both `registerDocResource`'s handler (before returning the resource's text) and immediately
before `renderPrompt`'s existing `{{VAR}}` pass (so an included fragment could itself contain a
`{{VAR}}` token later, if one's ever needed). `{{INCLUDE:...}}`'s `:`/`/`/`.` characters can't match
`renderPrompt`'s existing `\{\{(\w+)\}\}` pattern, so the two token types can't collide.

### 8. Surface staleness as data (a date), not as a judgment

Some Confluence content is old and quietly wrong; some is current. The tool has no way to
know which, and shouldn't guess — a page's age doesn't by itself mean it's wrong, and "looks stale"
is exactly the kind of call this project's whole design philosophy leaves to a human rather than an
agent inferring silently. So the tool does the minimum honest thing: surface `version.when`
(already free on the existing API call, Design #3) as a plain fact in the citation, and tell the
agent explicitly how to weigh it (Design #4) — background context, not a source of truth, checked
against the ticket/codebase rather than trusted at face value. No staleness threshold, no
auto-filtering old pages, no scoring — those would all be the tool quietly deciding something only
the reviewer reading the date should decide.

## Implementation steps

1. Extend `src/jira/adf.ts`'s ADF walk to surface `inlineCard`/`blockCard` URLs and `link`-mark
   hrefs. Unit tests: a fixture ADF doc with a smart-link card, and one with a `link` mark, confirm
   both now appear in `adfToPlainText` output.
2. Add `resolveIncludes` (Key decision #7) and wire it into `registerDocResource`'s handler and
   `renderPrompt`'s call sites. Write `docs/_fragments/confluence-context.md` (the guide-catalog
   check moves here from `docs/planning-procedure.md` §1, plus the new explicit-link/ticket-scan
   instructions), and replace both files' Confluence-context prose with the `{{INCLUDE:...}}` token.
   Unit tests: `resolveIncludes` splices a fixture file correctly and leaves unmatched tokens
   untouched; both real doc files render with the fragment's content present exactly once.
3. Build `fetch_confluence_pages` against the existing `src/confluence/client.ts`
   (`extractPageIdFromUrl`, `fetchPageByUrl`) and `storage-text.ts` (`storageToPlainText`) — array
   input, the host-plus-pattern filter from Key decision #5, `lastModified` from `version.when`
   (Key decision #8), partial-failure-tolerant output. Unit tests with `fetchImpl` substituted,
   matching this repo's existing Confluence client test pattern, including a case for a
   pattern-matching URL on the wrong host (must be skipped, not fetched) and a case asserting
   `lastModified` is parsed from a fixture `version.when` value.
4. Add the `confluence_links` optional argument to the `plan_ticket` prompt; wire the shared
   instructions fragment to call the new tool for both operator-named and ticket-scanned links.
5. Add the `**Confluence pages referenced**:` plan-file line (including each page's `lastModified`
   date, Key decision #8) and the ticket-comment "name what was consulted" instruction, both
   alongside the existing guide equivalents. Add the "background context, not prescriptive; prefer
   the ticket/codebase when they disagree" instruction to the shared fragment (Design #4).
6. Real-system verification (per `.ai/README.md`'s Verification requirement): a real ticket with a
   Confluence link pasted as plain text, a second with one Jira auto-chipped into a smart card, run
   through both `plan_ticket` (interactive) and a real headless dispatch — confirm both surface and
   fetch the link, and the plan/comment cite it correctly.

## QA Plan

- **Automated coverage**: unit tests for the ADF extraction fix (step 1), the fetch tool's URL
  parsing/partial-failure handling with `fetchImpl` substituted (step 3), and that the plan-file/
  comment templates include the new citation line when the tool was called and omit it when not
  (step 5).
- **Manual verification required**: the real-system check in Implementation step 6 — a mocked
  Confluence response can't confirm Jira actually represents a pasted link as an `inlineCard` the
  way we assume, or that a real Confluence page's storage format round-trips through
  `storageToPlainText` correctly for a page that isn't one of the existing guide fixtures. Needs a
  real Jira ticket plus a real Confluence page, run once interactively and once through a real
  headless dispatch.

## Boundaries

- Files/directories in scope: `src/jira/adf.ts`, `src/confluence/*`, `src/automation/prompt-template.ts`,
  `src/tools/` (new tool), `docs/planning-procedure.md`, `docs/_fragments/` (new),
  `prompts/headless-planning.md`, `src/index.ts` (tool/prompt registration). Nothing in
  `ai-intake-documentation-mcp` — that's the companion plan's territory.
- Do not fold `ConfluenceClient` into a shared cross-repo package as part of this plan (Key
  decision #3) — build against this repo's existing client, revisit once the companion plan exists.
- Do not build space/page-tree browsing or any raw search (Key decision #1) — explicit URLs only.
- Do not touch the curated guide index (`list_guides`/`fetch_guide`) — additive, parallel path only.
