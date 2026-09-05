# Plan (draft): `ai-intake-mcp` — curated Confluence guide retrieval

**Status**: draft
**Created**: 2026-09-05
**Updated**: 2026-09-05
**Related**: `docs/planning-procedure.md` (wiring point — step 2/step 5), `src/config.ts`
(`GlobalConfig`/`loadGlobalConfig`, where the new config field lands), `src/jira/client.ts`
(`JiraClient`, the auth/fetch chokepoint pattern the new Confluence client follows),
`src/repo-context.ts` (`.ai/intake-mcp.json` — per-repo config, deliberately **not** used here, see
Key decision #5), `ai-intake-documentation-mcp` (a separate, sibling MCP server for *authoring*
guides in the correct format — not built, but the guide shape below should anticipate it)

## Problem

Planning phase for tickets (e.g., "upgrade app X from Symfony 4.4") lacks access to structured,
reusable how-to knowledge. We maintain Confluence guides for this kind of work, but nothing
currently connects ticket intake (`docs/planning-procedure.md`) to that knowledge in a bounded,
predictable way.

## Goals (v1)

- Let `ai-intake-mcp` discover and fetch **curated** Confluence guides during the planning phase of
  a ticket (`docs/planning-procedure.md` §1–§3).
- Keep retrieval **bounded**: only guides listed on a dedicated index page, never a raw Confluence
  search. Guides here are written specifically for AI-agent consumption — narrower and more
  prescriptive than typical human-facing docs — so scope must stay controlled.
- Support an **org-level guide index** as optional config — usable by anyone adopting
  `ai-intake-mcp` for their own setup, not hardcoded to one company. Absent config = feature fully
  off, today's behavior unchanged.
- Prove the design out on a concrete case: chained Symfony upgrade guides (4→5, 5→6, 6→7), used one
  hop at a time.

## Out of scope (v1)

- Raw/unbounded Confluence search or crawling (future capability, separate feature, for tasks that
  can tolerate messier context).
- `ai-intake-documentation-mcp` (the sibling tool for *authoring* guides in the correct format). Not
  built now, but the guide shape below should anticipate it.
- Automated feedback loop that rewrites guides from completed-ticket lessons learned. Hook point
  named in Key decision #4, not built.

## Design overview

### 1. Confluence index page

A single, hand-maintained Confluence page lists all agent-consumable guides in a table:

| Title | Description | Link | Tags |
|---|---|---|---|
| Symfony 4→5 Upgrade | Steps for upgrading 4.4 apps to 5.x | [link] | symfony, upgrade |
| Symfony 5→6 Upgrade | Steps for upgrading 5.x apps to 6.x | [link] | symfony, upgrade |
| Symfony 6→7 Upgrade | Steps for upgrading 6.x apps to 7.x | [link] | symfony, upgrade |
| Company Conventions | Coding standards, PR process, testing expectations | [link] | always |

- `tags` distinguishes `always`-relevant docs (near-mandatory context, e.g. conventions) from
  `search_only` docs the agent should only fetch when a ticket clearly matches.
- Index links are **leaf content only** — see Key decision #1 (no child-page recursion).
- Curation/staleness risk is accepted as a tradeoff for control. Consider a "last reviewed" column
  later.

### 2. Config

Global, not per-repo (Key decision #5) — new fields on `GlobalConfig` (`src/config.ts`), read from
`~/.config/ai-intake-mcp/.env` the same way `JIRA_SITE_URL` is today:

```
CONFLUENCE_GUIDE_INDEX_URL=https://confluence.example.com/pages/GUIDE_INDEX
```

- Personal use: leave it unset — `loadGlobalConfig()` treats it as optional (unlike
  `JIRA_SITE_URL`), and the agent behaves as it does today.
- Company use: set it once, in the shared `.env` convention the Jira fields already use.

### 3. Retrieval flow (agent-driven, not pre-wired per ticket type)

1. Fetch + parse the index page into `{title, description, link, tags}` once per planning session,
   held in memory only (Key decision #3 — no persistent cache in v1).
2. Agent reads the ticket (`docs/planning-procedure.md` §1) and reasons about task type during
   planning.
3. Agent matches ticket content against index titles/descriptions (e.g. "upgrade Symfony 4.4" →
   "Symfony 4→5 Upgrade" row).
4. Agent always considers `always`-tagged docs (e.g. conventions) as a light default check.
5. Agent fetches full page content **only** for matched guides — keeps context usage low.
6. No fallback to raw Confluence search if nothing matches.

### 4. Execution discipline (how guides get used, not just fetched)

- One major version hop at a time (e.g. 4.4→5.x), never the full chain in one pass.
- Run tests and fix deprecations before moving to the next hop.
- Checkpoint between hops rather than executing the whole chain blind.

### 5. Where each kind of info lives

- **Generic guides (Confluence, via index)** — portable "how" for a given version hop. No
  company-specific process details, so they stay reusable and don't need edits when Symfony docs
  change.
- **Company conventions (Confluence, `always` tag)** — deploy process, coding standards,
  PR/ticket format, testing expectations. Applies across all apps regardless of version.
- **App-specific notes (in-repo)** — quirks, forked bundles, legacy hacks particular to one app.
  Lives with the app, not in Confluence.

## Guide authoring notes (for the future `ai-intake-documentation-mcp` guide-authoring flow, not
built now)

Guides in the index should be written for agent consumption:
- Atomic, testable steps.
- Exact commands, not descriptions ("run `composer require symfony/...`" not "update the relevant
  packages").
- Explicit checkpoints where tests must run before proceeding.
- Clear "done" criteria per step.

## Key decisions

### 1. Index stays flat — no child-page recursion

**Resolves the former "top-level only, or recurse into child pages?" open question.** No recursion
in v1: index links must point at the guide's full, leaf content directly. A guide that genuinely
needs more than one Confluence page becomes multiple index rows (e.g. "Symfony 4→5 Upgrade — part
2"), not a parent the agent has to crawl. Recursion is unbounded-traversal risk of exactly the kind
the "no raw search" goal exists to avoid — keeping the index itself as the single source of what's
fetchable is what makes retrieval auditable.

### 2. How the agent signals which guide(s) it used — two existing mechanisms, no new tooling

**Resolves the former "how does the agent signal in the ticket which guide(s) it used?" open
question.** Both hooks already exist in `docs/planning-procedure.md`; nothing new needs building:

- **Plan file**: add a `**Guides used**:` header line, parallel to the existing `**Related**:` line
  (see "Plan file shape" in `docs/planning-procedure.md`), populated during step 2 as guides are
  fetched and applied. Omitted entirely when no guide matched.
- **Ticket comment**: `docs/planning-procedure.md` §5's `tracker_add_comment` summary ("2-4 sentence
  summary of approach, files, and key decisions") gets one more instruction: name the guide(s)
  consulted, if any. This is the record that lands on the Jira ticket itself, not just the plan
  file.

Both are additive edits to `docs/planning-procedure.md`'s existing sections — no new field, tool, or
enforcement mechanism.

### 3. No persistent cache in v1 — fetch once per session, in memory only

**Resolves the former "is a daily TTL fine, or does it need manual refresh?" open question**, by
questioning the premise: `ai-intake-mcp` runs as a stdio MCP server process scoped to one planning
session (`docs/planning-procedure.md`'s whole model is one ticket, one session, developer present
throughout). A TTL cache would almost never outlive the handful of tool calls in that session, so
there's nothing real to invalidate yet. v1 fetches the index once, on the first guide-lookup call
per session, and holds it in memory for the rest of that process's life — no disk cache, no TTL, no
manual-refresh tool to build or test. If refetch-per-session cost becomes a real problem (a large
index, a slow Confluence instance), revisit with an actual file-backed TTL cache then — building it
now would be solving a cost that hasn't been observed.

### 4. Lessons-learned feedback loop — confirmed deferred, hook point named precisely

**Resolves the former "what's the trigger for folding lessons learned back into a guide?" open
question** by confirming it stays out of scope for v1, and naming exactly where it would plug in
when someone does build it: `docs/planning-procedure.md` §5's `tracker_add_comment` call (or, later,
an `implement_ticket` completion hook) is the natural point to capture "this guide was
wrong/incomplete in way X" — feeding into the not-yet-built `ai-intake-documentation-mcp`
guide-authoring tool. Nothing to build now; this is the hook point for later, not a mechanism.

### 5. Config lives in global `~/.config/ai-intake-mcp/.env`, not per-repo `.ai/intake-mcp.json`

A Confluence guide index is an org-wide resource — one Confluence instance shared across every repo
a developer plans tickets in — not a per-project setting like `jiraProjectKey` or `skipTargets`
(`src/repo-context.ts`'s `RepoConfig`). It belongs next to `JIRA_SITE_URL` in `GlobalConfig`
(`src/config.ts`), not in a committed per-repo file. This also matches the "personal use: leave it
unset" goal more directly — one unset env var, not a per-repo opt-out check in every project.

### 6. Confluence client reuses the Jira client's auth chokepoint pattern (confirm at review)

Confluence and Jira are typically the same Atlassian Cloud/Server tenant sharing auth, so the new
client (`src/confluence/client.ts`, sibling to `src/jira/client.ts`) should follow the same
`JiraClientOptions`-style shape — token-vs-cookie decided in one `authHeaders()` chokepoint,
`fetchImpl` injectable for tests — pointed at `/wiki/rest/api` instead of `/rest/api`. **Assumption
to confirm, not fully closed**: this holds for a standard shared-tenant setup, but an org running
Confluence and Jira as genuinely separate instances/credentials would need its own auth config. Flag
at review rather than blocking on it now — the common case is worth building for directly, and the
separate-instance case is a config-shape extension, not a rearchitecture.

## Implementation steps (draft)

1. Add `CONFLUENCE_GUIDE_INDEX_URL` (optional) to `GlobalConfig`/`loadGlobalConfig` in
   `src/config.ts`.
2. Build `src/confluence/client.ts` (auth/fetch, following `src/jira/client.ts`'s pattern per Key
   decision #6) and `src/confluence/index-parser.ts` (parse the index page's table into
   `{title, description, link, tags}[]`).
3. Add `src/tools/list-guides.ts` — exposes the parsed catalog (titles/descriptions/tags only, not
   full content), fetched once per process and held in memory (Key decision #3).
4. Add `src/tools/fetch-guide.ts` — fetches full content, scoped to only links present in the
   parsed index (enforces the "no raw search" boundary here, in code, not by instruction alone).
5. Update `docs/planning-procedure.md`: wire guide lookup into §2–§3 (agent checks `always`-tagged
   docs + searches catalog based on ticket content), add the `**Guides used**:` plan-file line and
   the ticket-comment instruction from Key decision #2.
6. Validate end-to-end against the Symfony 4→5 guide as the first real case.
7. Write up the app-specific-notes convention (in-repo doc location/format) so it's consistent
   across apps.
