# Plan (draft — brainstorm, not scoped): Confluence content health & staleness tracking

**Status**: draft (idea capture only — deliberately not fleshed out yet, see
`.ai/README.md`'s "Plans convention": draft is for capturing a brainstorm before it's turned into
concrete implementation steps)
**Created**: 2026-09-08
**Related**: `confluence-references-in-planning.md` (this repo's active draft plan — where the
staleness-as-a-citation-date idea, Key decision #8, actually shipped in scoped form),
`.ai/plans/completed/curated-guide-retrieval.md` Key decision #4 (the never-built "lessons learned"
feedback hook this brainstorm would resume), `.ai/plans/draft/2026-09-07-ai-intake-mcp-read-the-
guide-index-s-last-modified-column-2.md` (the guide-index-specific last-modified work, same
philosophy, narrower scope), `ai-intake-documentation-mcp`'s `.ai/` model (`check_drift`,
evidence/correction records — the pattern this brainstorm borrows from).

## Why this is a separate thing, not part of `confluence-references-in-planning.md`

That plan is scoped to *fetching* specific pages during planning and citing them honestly (with a
staleness date) when it does. This is a different, much bigger problem: any long-lived Confluence
space accumulates content that the fetch path never touches at all, where nobody currently has a
way to tell what's still accurate versus quietly wrong. Solving "cite honestly when we fetch
something" doesn't touch "help someone figure out what to fix across a large, aging page set."
Keeping this separate stops the focused plan from scope-creeping into a content-audit project.

## Ideas discussed (unordered, none scoped yet)

1. **Finish the lessons-learned hook that was already deferred.** `curated-guide-retrieval.md`'s
   Key decision #4 named where a "this guide was wrong/stale" signal would plug in
   (`tracker_add_comment`/a completion hook) but explicitly deferred building it. Also unfinished:
   the draft plan adding a "Last Modified" column to the guide index itself. Both are narrowly
   scoped to the curated guide index specifically (the highest-trust, most-reused tier), and both
   are already-designed work sitting idle — cheapest starting point if this ever gets picked up.

2. **Turn "flagged as stale" into a standing, accumulating list instead of a one-time audit.**
   Whenever a planning session (interactive or headless) discovers a fetched page — guide or
   explicit-link — contradicts the actual code, record that as a structured note (not an edit to
   Confluence itself). Over enough planning sessions, that turns into "these N pages have been
   wrong 3+ times" without anyone deliberately auditing anything. Natural fit for
   `ai-intake-documentation-mcp`'s evidence/correction model, but that's currently scoped per-repo
   (`.ai/evidence/`), and Confluence content isn't repo-scoped — open question, not resolved here.

3. **Combine staleness (age) with usage (how often it's actually fetched) as a joint signal.** Age
   alone conflates "old but still true" with "old and wrong." Old + never referenced → archive
   candidate. Old + frequently referenced → high-value refresh candidate (people keep needing it
   despite nobody maintaining it) — a much stronger prioritization signal than age alone, and it
   falls mostly out of idea #2's log once that exists, not new instrumentation on its own.

4. **Structural bet: stop growing the stale pile, not just cleaning the existing one.** Anything
   genuinely app-specific probably belongs in that repo's own `.ai/docs`/`.ai/context` via
   `documentation-mcp` going forward, not Confluence — because that layer has `check_drift` tying
   documentation staleness to actual code changes, something Confluence has no equivalent of.
   Confluence stays for what's genuinely cross-repo (conventions, curated guides). Doesn't fix the
   existing stale content; stops the rate of new staleness from Confluence-first authoring habits.

## Open questions (unscoped — for whenever this gets picked back up)

- [ ] Where would idea #2's log actually live, given Confluence content spans every repo, not one?
- [ ] Is this an `ai-intake-mcp` feature (surfaced during planning), a `documentation-mcp` feature
      (content-health tooling, closer to its existing evidence model), or a standalone tool that
      isn't either MCP server?
- [ ] What counts as "wrong," precisely, versus just "the agent didn't find it relevant this time"?
      Idea #2 needs a real definition here before it produces a trustworthy signal.
- [ ] Does idea #4 need any tooling at all, or is it purely a stated convention/policy decision?

No implementation steps, no design overview, no key decisions — this is intentionally just capturing
the discussion so it isn't lost, per this repo's own "draft" convention. Flesh out when it's actually
picked up.
