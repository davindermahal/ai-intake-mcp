Gather Confluence context for this ticket in two steps: check the curated guide index, then look at
any explicitly named page. This is the single source of truth for this step (Key decision #7 of
`confluence-references-in-planning.md`) — included verbatim into both interactive and headless
planning, so it never drifts between the two the way it did before this existed.

How you actually get this data differs by mode — an interactive `plan_ticket` session calls tools
directly; a headless run has no MCP tool access at all, so the orchestrator pre-fetches everything
below *before* launch and hands it to you as a file — but what you do with it, and how you weigh it,
is identical either way.

### Check for a relevant guide

- **Interactive**: call `list_guides`. If it reports the guide index isn't configured, skip this
  entirely — today's behavior, unchanged.
- **Headless**: read the guide catalog (title/description/tags only) from your Confluence context
  file's `guideCatalog` field. An empty array means the guide index isn't configured (or nothing is
  in it) — skip this entirely, same as interactive mode.

Either way:

- Always give any `always`-tagged entry (e.g. company conventions) a light default check.
- Match the ticket's summary/description against the other entries' titles/descriptions (e.g. a
  ticket that says "upgrade app from Symfony 4.4" matches a "Symfony 4→5 Upgrade" title).
- **Interactive only**: call `fetch_guide` for entries that actually matched, to get their full
  content — don't fetch everything in the catalog "just in case." **Headless mode has no equivalent
  fetch** — you can still cite a matched guide by title (its description/tags already tell you it's
  relevant), but its full content isn't available unless the ticket also links its Confluence page
  directly, in which case it's already present below as a fetched page, same as any other referenced
  page — cited under **Confluence pages referenced**, not **Guides used**, since nothing cross-checks
  a referenced link back to the catalog.
- If nothing matches, don't fall back to searching Confluence directly; there is no such tool, by
  design, in either mode.
- A guide's steps (when its full content is available) inform the plan you write, especially
  `## Implementation order` and `## Key decisions` — treat it as prescriptive, not merely background
  reading.
- **Reconcile against app-specific notes.** A guide is written for the general case (curated for
  reuse across apps); this one app may have forked bundles, legacy hacks, or other quirks that mean
  a step needs adjusting here. Check `.ai/intake-mcp.md` (this project's own free-form notes file,
  `docs://implementation-procedure` §2) if it exists — that's the one place those deviations are
  recorded, in-repo, not in Confluence. If it doesn't exist yet, don't create it during planning;
  that's `docs://implementation-procedure`'s job once implementation starts.

### Fetch explicitly named Confluence pages

Two independent sources of candidate URLs:

- **Operator-named** — interactive `plan_ticket` sessions only: if this session was invoked with a
  `confluence_links` argument, treat every URL in it as a candidate. No equivalent in headless mode —
  there's no operator typing a command.
- **Ticket-named** — both modes: URLs found in the ticket's summary, description, and comments,
  including ones surfaced from Jira's smart-link cards and `link` marks (not just plain-text URLs a
  reporter pasted directly).

- **Interactive**: pass every candidate URL you found (deduplicated) to `fetch_confluence_pages` in
  one call. It silently skips anything that isn't actually a fetchable Confluence page on this site's
  own instance (a Slack link, a GitHub link, a Confluence space URL with no page ID) — you don't need
  to pre-filter, just pass every URL-shaped string you found and let the tool decide.
- **Headless**: the orchestrator already did this before you started, using the same filter. Read the
  results from your Confluence context file's `referencedPages` field — each entry is a page that was
  actually fetched, or, for one that matched the filter but failed to fetch, carries an `error` field
  instead of `content`.

### Weigh what you fetch appropriately — guides vs. arbitrary pages

`list_guides`/`fetch_guide` and `fetch_confluence_pages` return two different trust tiers (however you
obtained them, per above), and the plan file's two citation lines (`**Guides used**:` /
`**Confluence pages referenced**:`) exist to keep that distinction visible to a human reviewer, not
just to you:

- A **matched guide** (with its full content available) is curated and prescriptive — treat its steps
  as authoritative, per "Check for a relevant guide" above.
- A page fetched via **`fetch_confluence_pages`** (or its headless equivalent) is arbitrary and
  unvetted — it may be current, generic, or badly stale, and the tool has no way to know which. Each
  result carries a `lastModified` date; treat it as **background context, never prescriptive**. When
  it disagrees with what you can verify directly in the ticket or the codebase, prefer what you can
  verify — don't silently defer to an old or generic page just because it's the one that got linked.
