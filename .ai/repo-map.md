# Repo map

Update this file as code changes; don't let it drift into aspirational documentation.

## Root

- **`README.md`** — what this tool does, current status.
- **`package.json`** / **`tsconfig.json`** / **`vitest.config.ts`** / **`eslint.config.js`** — TS
  project config. `engines.node >= 24`.
- **`Dockerfile`** / **`.dockerignore`** — Node 24 development environment (build/test only, not a
  deployment artifact — the server itself must run as a local process; see the plan's "Development
  environment" section).
- **`Makefile`** — `make install`/`build`/`test`/`lint`/`shell` (Docker-wrapped, contributor
  build/test only) and `make image`; `make setup` (host-native, wraps `install.sh`). An `exec
  CMD="..."` target — the generic passthrough the implementation-phase plan's decision #2
  standardizes on for every consumer project — exists on the `feature/DAV-5-testing-ticket-for-mcp`
  branch (the implementation-phase dogfood run) but hasn't been merged into `main` yet.
- **`install.sh`** — the real one-command setup path (build, register with whichever agent CLI is
  present, create `~/.config/ai-intake-mcp/.env` from `.env.example` if missing, verify). Runs on
  the host, never in Docker — the registered server must run as a plain `node` process. Idempotent.
- **`.env.example`** — placeholder credentials template `install.sh` copies to
  `~/.config/ai-intake-mcp/.env`. The only `.env*` file that's actually committed (see `.gitignore`'s
  exception for it).
- **`.ai/`** — this project's own AI-context layer: `README.md` (orientation), `system.md`
  (condensed design reference), `repo-map.md` (this file), `plans/` (three-stage convention — see
  `.ai/README.md`), `guides/` (reference material), `prompts/` (empty), `docs/extracted/` (empty).
- **`.ai/intake-mcp.json`** — this repo's own tracker config (v1 decision #4). `jiraProjectKey:
  "DAV"`, `appTag: "app:ai-intake-mcp"`. Unchanged by the implementation-phase plan (decision #2).
- **`.ai/intake-mcp.md`** — this repo's own implementation notes (implementation-phase plan, decision
  #3): the standard `make` targets it defines and its ephemeral-container-per-command model. Free
  prose, not parsed.

## `src/` — the MCP server

- **`index.ts`** — entrypoint. Registers all 9 tools, 3 resources, and both prompts (`plan_ticket`,
  `implement_ticket`) on an `McpServer`, then connects a `StdioServerTransport`.
- **`config.ts`** — loads `~/.config/ai-intake-mcp/.env` (decision #8): `JIRA_SITE_URL`,
  `JIRA_INTAKE_EMAIL`, `JIRA_INTAKE_API_TOKEN`, plus the native-status/cookie-browser overrides.
- **`repo-context.ts`** — `git rev-parse --show-toplevel` (decision #1); read/write
  `.ai/intake-mcp.json` (decision #4).
- **`worktree.ts`** — pure-git worktree logic. `worktreeCreate` (v1 decision #5): branch reuse,
  base-branch resolution (`origin/HEAD` → local `main` → local `master`), resume-if-exists.
  `findWorktreeForTicket` (implementation-phase decision #5): resolves an existing worktree by
  ticket key alone, not the caller's cwd — used by `approve_plan`/`worktree_remove`. `worktreeRemove`
  (implementation-phase decision #11): merged-into-base guard, `force`/`keepBranch` options.
- **`plan-file.ts`** (new, implementation phase): `findPlanFile`/`readPlanStatus`/`setPlanStatus` —
  the plan file's `**Status**:` field is the approval gate (decision #4).
- **`footer.ts`** — comment footer naming the calling agent, from MCP's `clientInfo` (decision #10).
- **`jira/client.ts`** — the one HTTP chokepoint (decision #9); `fetchImpl` is injectable, which is
  what the unit tests substitute (see "Resolved: Testing approach" in the v1 plan doc).
- **`jira/auth-cookie.ts`** — cookie-fallback auth: `keytar` (OS keyring) + `better-sqlite3` (Chrome's
  cookie DB) + `crypto` (AES decrypt). Chrome/Chromium on Linux only for v1. Lazy-imported by
  `client.ts` so token-mode developers never need these native modules loadable at all.
- **`jira/tags.ts`** — `jira-tags` mode domain logic: `state:*`/`app:*` label parsing, the
  assignee-gate (with unassigned-auto-assign), bootstrap-on-first-touch, the best-effort
  native-status mirror (now reaching `TRACKER_NATIVE_STATUS_CODE_REVIEW` for `verify`, per
  implementation-phase decision #7), and `tracker_transition`'s legal-target list — `needs-input`,
  `review`, `working`, `verify`, `problem`; `plan` and `implement` are deliberately excluded
  (bootstrap-only / `approve_plan`-only, respectively).
- **`jira/adf.ts`** — minimal Atlassian Document Format ↔ plain-text conversion (Jira Cloud's REST
  v3 API requires ADF for description/comment bodies).
- **`tools/*.ts`** — one thin module per MCP tool, wiring the above into the exact tool-surface
  contract from the plan docs. Implementation-phase additions: `approve-plan.ts` (the only path to
  `state:implement` — transitions Jira before touching the plan file, decision #5), `implement-
  ticket.ts` (resolves/resumes the worktree, confirms the approval gate, transitions to
  `state:working` — does not itself compute a final verified/problem outcome, since that's the
  result of the whole session that follows, not one tool call), `worktree-remove.ts`.

## `docs/` — served as MCP resources + read directly by developers

- **`planning-procedure.md`** — served as `docs://planning-procedure`. Generalized from
  `ai-intake-harness`'s `prompts/intake-planning.md` for the on-demand, interactive model.
- **`ticket-states.md`** — served as `docs://ticket-states`. The full `state:*`/`app:*` label
  vocabulary (planning + implementation phases), reference only.
- **`implementation-procedure.md`** — served as `docs://implementation-procedure`. Generalized from
  `ai-intake-harness`'s `.ai/prompts/worktree-bootstrap-auto.md`: hard limits, the approval gate,
  reading `.ai/intake-mcp.md`, the `make install`/`build`/`test`/`lint`/`exec` convention, reporting
  back via `tracker_transition(key, "verify" | "problem")`.
- **`setup.md`** — one-time personal setup: clone/build, register at user scope, credentials,
  `health_check`, approving/implementing a ticket, the recommended allow-list snippet (+ an optional
  `git push`/`merge` deny example for implementation sessions).

## `test/` — vitest, mocked HTTP only (no real Jira in automated tests)

- **`jira/client.test.ts`** — auth header construction, error surfacing, 204 handling.
- **`jira/tags.test.ts`** — the `jira-tags` domain logic: bootstrap, assignee-gate, label swap,
  native-status mirror (including the `verify` → Code Review / `implement`,`working`,`problem` → In
  Progress mapping), ADF comment body, transition-target vocabulary.
- **`plan-file.test.ts`** — plan-file `Status` read/write.
- **`worktree.test.ts`** — real git operations against a throwaway temp repo (not mocked — this is
  local and fast, not the "real Jira" concern the mocking policy is about). Covers
  `findWorktreeForTicket` and `worktreeRemove`'s merge/force/keep-branch guards.
- **`tools/approve-plan.test.ts`** — the ordering guarantee (Jira transition before the plan-file
  write) and all refusal cases, against a real temp git repo + mocked Jira.

## `scripts/`

- **`health-check.ts`** (`npm run health-check`) — standalone wrapper around the same `healthCheck()`
  the MCP tool calls. Used by `install.sh` as its final verification step; also runnable directly.
- **`jira-smoke-check.ts`** (`npm run smoke:jira -- <KEY>`) — the v1 Phase 1 real-Jira verification
  checkpoint. Exercises `tracker_get_issue`/`tracker_add_comment`/`tracker_transition` (planning
  states) against one real ticket, never mocked. Run and passed against `DAV-5` on 2026-08-28.
- **`jira-smoke-check-implementation.ts`** (`node --import tsx scripts/jira-smoke-check-implementation.ts <KEY> <worktree-path>`)
  — the implementation-phase Phase 1 checkpoint: `approve_plan`, the widened `tracker_transition`
  vocabulary (`working`/`verify`/`problem`), confirms `"implement"` is refused as a raw target, and
  exercises the `TRACKER_NATIVE_STATUS_CODE_REVIEW` mirror. Run and passed against `DAV-5` on
  2026-08-28 — see the implementation-phase plan doc's "Verification checkpoints" section.
