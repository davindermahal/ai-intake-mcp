# Changelog

All notable changes to `@davindermahal/ai-intake-mcp` are documented here. Versions correspond to
tags (`vX.Y.Z`) and npm releases; see `.ai/plans/` for the full design record behind each change.

## 0.3.1 — 2026-09-09

### Fixed
- Publish now actually includes `CHANGELOG.md` (0.3.0 predated this file, so the fix couldn't ship
  until this release).

## 0.3.0 — 2026-09-08

### Added
- Explicit-link Confluence references during ticket planning, interactive and headless: a
  `fetch_confluence_pages` pre-fetch step picks up Confluence URLs pasted into a ticket's
  description/comments (or named mid-conversation) and cites them in the resulting plan
  (`**Confluence pages referenced**: [Title](url) — last updated <date>`). Headless workers get
  the fetched content via an orchestrator-written file, not MCP tool access. See
  `.ai/plans/completed/confluence-references-in-planning.md`.

### Changed
- Migrated the Confluence read path (guide catalog + the new explicit-link fetching) onto the
  shared `@davindermahal/confluence-client` package instead of this repo's own client — no
  behavior change, sets up auth/config/retry logic to stay in sync with `documentation-mcp`'s
  write-side tools.

## 0.2.0 — 2026-09-08

### Added
- Confluence-backed `list_guides`/`fetch_guide` tools: a ticket plan can reference a curated guide
  from the shared Confluence index during planning.
- Opt-in `MCP_TRANSPORT=http` (existing stdio default unchanged).

### Changed
- Migrated from `@modelcontextprotocol/sdk` v1 to the v2 `@modelcontextprotocol/node`/`server`
  packages.
- `better-sqlite3`/`keytar` moved to `optionalDependencies`, so a token-only install (no
  browser-cookie fallback, no local cache) no longer fails on native module builds.

## 0.1.1 — 2026-09-05

### Changed
- Rescoped the npm package to `@davindermahal/ai-intake-mcp`.

## 0.1.0 — 2026-09-05

### Added
- Initial release: on-demand Jira ticket planning and implementation via MCP
  (`plan_ticket`/`approve_plan`/`implement_ticket`), no cron and no per-project install required.
- Headless automation mode: the same plan-then-build pipeline running unattended on a cron across
  one or more registered repos, validated end to end against a real Jira board including a 24.5h
  unattended soak (see `.ai/plans/completed/headless-automation-qa.md`).
