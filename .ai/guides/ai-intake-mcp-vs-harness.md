# `ai-intake-harness` vs. `ai-intake-mcp`: functional differences

Reference doc for the design in `.ai/plans/draft/ai-intake-mcp-on-demand-planning.md`. Written to
answer one question precisely: **what does the new MCP-based approach actually do differently from
what this repo already does today**, dimension by dimension, before any code gets written.

Short version: `ai-intake-harness` is a full push-based pipeline (ticket → plan → approval →
implementation → verify → report), automated end to end by a cron poller. `ai-intake-mcp` v1 is a
pull-based **planning-only** slice of that same idea — a developer, sitting in their project repo
with an agent CLI already open, names a ticket and gets the planning step only, with zero files
added to their project. It is not a replacement; both are expected to run side by side for now (see
the plan's "Why").

---

## Capability matrix

| Capability | `ai-intake-harness` (today) | `ai-intake-mcp` (v1 plan) |
|---|---|---|
| Trigger | Cron polls tracker queues automatically (push) | Developer names a ticket explicitly (pull) |
| Planning | Yes — headless, unattended | Yes — interactive, one agent session |
| Implementation (build/test/verify) | Yes — `worktree-go.sh`, headless or attended | **No** — explicitly out of scope for v1 |
| Ticket discovery (`tracker_search`) | Yes — poller finds what's ready | **No** — ticket key is given, nothing is searched for |
| Tracker adapters | `jira`, `jira-tags` (shared-board, multi-repo via app-tag), pluggable contract | `jira` only; no adapter contract, no `jira-tags` |
| Project adapter (DB/container provisioning) | Yes — `scripts/lib/project/<name>.sh` contract, per consumer repo | **No** — `worktree_create` is plain `git worktree add`, nothing project-specific |
| AI provider abstraction | Yes — `lib/ai/<name>.sh` (Claude/Gemini/Codex/Antigravity/local LLM), harness spawns the worker | **No adapter needed** — the developer's own agent CLI *is* the worker; any MCP-capable client works without a harness-side integration |
| Jira auth | Token, with cookie fallback (Python `browser_cookie3`) | Token, with cookie fallback (**pure Node**, ported from a teammate's working implementation — no shared code with the harness's Python path) |
| Per-project install | `install.sh` wizard: `.env.local`, `.ai/intake.config`, `scripts/intake-cron.sh`, Makefile targets, `.claude/settings.*.json` | **None** — one-time *global* MCP server registration (`--scope user`) + global credentials file; nothing added to the project except the plan file itself |
| Config/credential location | Per-project (`.env.local`, `.ai/intake.config`) — different creds possible per repo | Global, one file for the whole machine (`~/.config/ai-intake-mcp/.env`) — same creds across every repo (see Open gap below) |
| Concurrency control | Yes — `JIRA_MAX_WORKTREES` cap, in-flight dedup markers | N/A — one synchronous session per invocation, no queue to cap |
| Stalled-ticket watchdog | Yes — `watchdog_stalled_comment_after` | N/A — nothing runs unattended, so nothing can silently stall |
| Permission sandboxing | Curated `.claude/settings.*.json` / `.gemini/settings.json` deny-lists for unattended workers | None needed yet — the developer is present in their own already-trusted interactive session (this stops being true if the MCP path is ever pointed at unattended/scheduled use — see Open gap) |
| State-machine coverage | Full 9-state lifecycle, both directions | Touches only `needs-author-input` and `plan-review` — nothing drives `ready-for-implementation` → `done` |
| Runtime status tooling | `intake-status.sh` — cross-references tracker + local `.intake/` run state | N/A — no local run state exists to report on (synchronous, per-invocation) |
| Docs delivery | Vendored into the consumer repo (`README.md`, adapter-contract docs, `prompts/intake-planning.md`) | Served live as MCP **resources** (`docs://planning-procedure`, `docs://ticket-states`) — never copied into the project |
| Invocation surface | Cron wrapper script + `make worktree-go`/`worktree-new` | MCP tools (`tracker_get_issue`, `tracker_add_comment`, `tracker_transition`, `worktree_create`) + an MCP **prompt** (`plan_ticket`) surfaced as a slash command |
| AI-provider comment footer (`ai_display_name`) | Yes — footer names whichever provider actually ran | Not yet designed — see Open gap |
| Config health-check (`install.sh --verify`) | Yes — audits `.env.local`, `.ai/intake.config`, adapter completeness | Not yet designed — see Open gap |

---

## Why several harness features simply don't have an MCP equivalent (not gaps — different shape)

- **No AI-provider adapter layer.** The harness's `lib/ai/<name>.sh` exists because the harness
  itself has to *launch* a worker process (Claude Code, Gemini CLI, Codex, etc.) headlessly and
  manage its lifecycle (pidfile, log, detached process). In the MCP model there is no launching to
  do — the developer already has an agent session open, and that agent *is* the thing calling the
  MCP tools. "Which AI provider" stops being a harness concern entirely; it's just whichever CLI the
  developer happened to open. This is a simplification, not a missing feature.
- **No concurrency cap / watchdog.** Both exist in the harness to manage multiple *unattended*
  workers running against a shared machine over time. A single interactive MCP session has no
  analogous failure mode — if it stalls, the developer sees it stall, in their own terminal, right
  now.
- **No queue search.** The harness's poller has to discover *which* tickets need attention; the
  on-demand model is told directly ("Plan DAV-4"), so nothing needs discovering.

## Where the two auth paths are functionally equivalent but not code-shared

Both systems support the same two-mode contract (API token, falling back to a live browser session
cookie, never cached to disk, fails loudly if the browser session has expired) — see decision #8 in
the plan. The *implementations* are independent: the harness's is Python (`browser_cookie3`,
`lib/tracker/jira-cookie.sh`), the MCP server's will be pure Node (ported from a teammate's existing
implementation, per the plan's open questions). `.ai/guides/jira_authentication_report.md` is a
useful third reference point here — it documents a *third*, independent implementation of the same
token+cookie-fallback pattern (Rust, using the `rookie` crate), and its §5 "Replication Strategy for
Other Languages" names `browser-cookies` / `chrome-cookies-secure` as the Node-side equivalents of
`rookie`/`browser_cookie3` — worth checking against whatever library the teammate actually used.

---

## Open gaps in the current draft plan (not yet answered, worth resolving before implementation)

These are things the harness does today that the MCP plan hasn't addressed yet — not necessarily
things it *should* do, just things to decide on deliberately rather than by omission:

1. **Single global credential file, multiple projects.** `.ai/intake.config` lets each consumer
   repo point at a different Jira site/project. The MCP plan's `~/.config/ai-intake-mcp/.env` is one
   file for the whole machine. Fine if a developer only ever works against one Jira site; a real gap
   if they work across two tracker instances. (The plan's existing "Open questions" section already
   flags the narrower `jira-tags` version of this; this is the more basic single-tracker version of
   the same question.)
2. **No comment footer / provider-name design.** The harness's `ai_display_name` mechanism (added in
   DAV-4) means every posted comment says which AI actually ran. The MCP plan hasn't decided what
   `tracker_add_comment` should stamp — worth at least a static "posted via ai-intake-mcp" footer
   for parity, before this gets dogfooded and someone asks "who posted this?"
3. **No config health-check equivalent.** `install.sh --verify` catches drift (missing keys, stale
   adapter functions, wrong Jira status names) — for a global, per-machine config, whatever the
   equivalent misconfiguration modes are (bad credentials, unreachable Jira, missing Node/OS-keyring
   permissions for the cookie path) currently have no analogous self-check tool planned. Worth at
   least a trivial `health_check` tool for the same reason `install.sh --test-only` exists today.
4. **`worktree_create`'s resume-vs-error behavior is unspecified.** The harness deliberately
   distinguishes `worktree-go.sh HEADLESS=1` (auto-resumes an existing worktree dir) from
   `worktree-new.sh` (hard-errors on one) — see
   `.ai/plans/draft/worktree-scripts-functional-decomposition.md`'s "Real behavioral differences"
   section. The MCP plan doesn't yet say which behavior `worktree_create` should have when a
   worktree for that ticket already exists.
5. **Permission sandboxing assumption.** The plan's "no sandboxing needed" reasoning holds only
   because a human is always present in the loop for v1. Flag explicitly if this MCP path is ever
   extended toward unattended/scheduled invocation later — that would reintroduce the need for
   something like the harness's curated `.claude/settings.*.json` deny-lists.

None of these block starting phase 1 (they're all additive or deferrable), but they're the concrete
list of "what the harness has that this plan is silently not doing yet" — worth a deliberate
yes/no/later per item rather than discovering them mid-build.
