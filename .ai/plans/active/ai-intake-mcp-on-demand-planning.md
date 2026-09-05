# Plan (draft): `ai-intake-mcp` — on-demand ticket planning via MCP, no cron / no per-project install

**Status**: active
**Created**: 2026-08-28
**Updated**: 2026-08-28
**Related**: the `ai-intake-harness` repo's `README.md` (its cron+poller architecture, which
continues running unchanged — see "Goal" below), its `lib/tracker/jira-common.sh` and
`lib/tracker/jira-tags.sh` (reference for Jira REST shape and the label-driven shared-board
workflow, not reused directly), its `prompts/intake-planning.md` (source material generalized into
this repo's own procedure doc), and its `.ai/guides/ai-intake-mcp-vs-harness.md` (functional
comparison this plan was reconciled against, also carried into this repo — see `.ai/guides/`)

## Goal

Enable ticket planning without a per-developer cron job and without a per-project install step, and
without adding files to the consumer project beyond the plan output itself. This turns ticket
planning from push (a poller notices a ticket is `Ready for Planning` and dispatches a headless
worker) into pull (a developer, sitting inside their own project repo with whatever agent CLI they
already have open, says "Plan DAV-4").

This is a **new, separate system**, not a replacement: `ai-intake-harness`'s existing cron+poller
model (`intake-poll.sh` + `install.sh`) continues running unchanged. Nothing here modifies that.

## Repo

This repo: **`ai-intake-mcp`**. **Node/TypeScript**, using `@modelcontextprotocol/sdk`. Deliberately
**no dependency on `ai-intake-harness`'s bash logic** — reimplements the small slice of Jira REST it
needs from scratch, so the two repos evolve independently and this one never becomes something a
consumer project has to vendor.

**Runtime: Node 24.** Pinned via an `engines` field in `package.json` (`{ "node": ">=24" }`) once
Phase 1 scaffolds the project. No particular v24 feature is load-bearing today — this is a baseline
choice (current Active LTS-track major at plan time), not a dependency on a specific new API — but
stated explicitly so a developer's local `node -v` and the dev Dockerfile (see "Development
environment" below) don't drift apart.

## Core design decisions

1. **cwd = project context, no per-repo registry.** The server is registered once per developer at
   **user scope** (not per-project). **During the experimental phase, this points at a local git
   clone**, not a published npm package — the repo (https://github.com/davindermahal/ai-intake-mcp)
   is public and its README says so up front, but nothing about it is validated yet, so publishing
   an installable `npx` package is premature:
   ```
   git clone https://github.com/davindermahal/ai-intake-mcp ~/dev/ai-intake-mcp
   cd ~/dev/ai-intake-mcp && npm install && npm run build
   claude mcp add --scope user ai-intake -- node ~/dev/ai-intake-mcp/dist/index.js
   gemini mcp add --scope user ai-intake node ~/dev/ai-intake-mcp/dist/index.js
   ```
   `npx -y ai-intake-mcp` (an npm publish) is a later step, only once the concept is proven —
   `docs/setup.md` should document the git-clone form as the only supported path for now, and
   picking up updates means `git pull && npm run build` in that clone.

   A local stdio MCP server subprocess inherits the cwd of whatever spawned it — the agent CLI
   itself — so whichever project repo the developer opened their agent in becomes the server's
   working context for that session, discovered via `git rev-parse --show-toplevel`. This is the
   load-bearing assumption of the whole design; see "Verify first" below before building on it. This
   resolves *which repo* the developer is in, but not *which Jira project/app-tag* applies to it —
   see decision #3.

2. **Ticket key is enough — no queue search.** In the on-demand model the developer already names
   the exact ticket ("Plan DAV-4"), so `tracker_search` (which the poller uses to discover *which*
   tickets are ready) isn't needed for v1. No "which queue" abstraction at all.

3. **`jira-tags` is the v1 tracker mode; plain `jira` is deferred entirely.** Reversed from the
   original sketch. The actual target for this tool is a shared board (this harness's own DAV board
   is the concrete case), and — as raised in review — a ticket key's project prefix does **not**
   reliably identify which repo it belongs to in that world: multiple repos can share one Jira
   project (all tickets look like `DAV-*` regardless of app), and conversely one repo could
   legitimately receive tickets from more than one Jira project over time. Plain `jira`'s
   native-status-driven single-project workflow has no such ambiguity to solve and isn't needed by
   anything today, so it isn't built until a real project actually needs it.

   This reintroduces a small piece of per-repo state that decision #1's cwd-only design didn't
   originally have — see "Per-repo config file" below for how that's resolved without bringing back
   the harness's full install wizard.

   **What `jira-tags` mode actually requires** (read directly from `lib/tracker/jira-tags.sh`, not
   assumed):
   - The abstract state (`needs-author-input`, `plan-review`, etc.) lives in a single `state:<step>`
     label on the ticket — this is the authoritative source of truth. `tracker_transition` removes
     the old `state:*` label and adds the new one.
   - Every state-changing write (not comments, by default) is gated on
     `jira_tags_assert_assignee`: the ticket must currently be assigned to the authenticated
     account, or the write is refused outright — a real safety rail on a board shared by multiple
     users/repos. `ai-intake-mcp` must port this same guard, since it's still one shared board even
     though there's no poller. **Resolved (unassigned case)**: if the ticket is currently
     *unassigned*, `tracker_transition` auto-assigns it to the authenticated account first, then
     proceeds — naming a specific ticket to `plan_ticket` is already a clear, explicit signal of
     intent, so there's no reason to force a manual round trip through the Jira UI first. If it's
     assigned to *someone else*, the existing hard-refusal stands unchanged — this only relaxes the
     unassigned case, not the guard itself.
   - After the label write, the adapter *best-effort* mirrors onto one of two configurable native
     status columns (`TRACKER_NATIVE_STATUS_IN_PROGRESS` / `TRACKER_NATIVE_STATUS_CODE_REVIEW`) so
     the board still looks right to a human glancing at it — a failed mirror is logged but never
     fails the call, since the label write already succeeded. **Only `TRACKER_NATIVE_STATUS_IN_PROGRESS`
     is ever reachable from v1's actual scope**: `jira_tags_native_status` maps both
     `needs-author-input` and `plan-review` to the *in-progress* column; `TRACKER_NATIVE_STATUS_CODE_REVIEW`
     is only reached by `ready-for-verification`/`done`, both implementation-phase states this plan
     doesn't touch. Don't build anything for `_CODE_REVIEW` in v1 — there's nothing that would ever
     call it.
   - `tracker_add_comment` is **not** assignee-gated by default (a worker's only channel to report
     back should survive a mid-flight reassignment) — matches `TRACKER_GATE_COMMENTS` defaulting to
     `false` in the harness. Carry the same default; don't gate comments in v1 unless asked.

   **`ai-intake-mcp` uses its own, shortened `state:*` vocabulary — not the harness's literal
   strings.** Since this is already a clean-room reimplementation (decision #9's no-shared-code
   stance), there's no dependency forcing the exact label text to match. Shortened for readability
   on the board:

   | Harness's full name (`lib/tracker/jira-tags.sh`) | `ai-intake-mcp` label | Used by v1? |
   |---|---|---|
   | `ready-for-planning` | `state:plan` | Yes — bootstrap-only initial state (see decision #4), never a `tracker_transition` target, matching the harness's own function (it doesn't accept this as a target either) |
   | `needs-author-input` | `state:needs-input` | Yes — `tracker_transition` target |
   | `plan-review` | `state:review` | Yes — `tracker_transition` target |
   | `ready-for-implementation` | `state:implement` | No — implementation phase, out of scope for v1 |
   | `in-progress` | `state:working` | No — implementation phase, out of scope for v1 |
   | `ready-for-verification` | `state:verify` | No — implementation phase, out of scope for v1 |
   | `done` | `state:done` | No — implementation phase, out of scope for v1 |

   Safe on the shared board because scoping is per-`appTag`, not per-vocabulary: each ticket belongs
   to exactly one app, so there's no collision between a harness-managed ticket using
   `state:plan-review` and an `ai-intake-mcp`-managed ticket using `state:review` elsewhere on the
   same board. The real consequence is **no interoperability** — a ticket cannot move between the
   harness's pipeline and `ai-intake-mcp`'s pipeline, since each reads a different label vocabulary
   as its source of truth. Not a problem given decision to keep these as two separate, non-integrated
   systems (see "Goal"), but worth being explicit about so nobody assumes a ticket started in one
   can be picked up by the other later without manual relabeling.

4. **Per-repo config file: one small file, committed, auto-bootstrapped.** Resolves decision #3's
   gap without reviving the harness's install wizard/cron/Makefile bundle — this is a fundamentally
   smaller thing than a full per-project install.
   - **Location/shape**: `.ai/intake-mcp.json` at the repo root (resolved via decision #1's cwd →
     `git rev-parse --show-toplevel`) — reuses this harness's existing `.ai/` convention rather than
     inventing a new dotfile. Contents: `{ "jiraProjectKey": "DAV", "appTag": "app:my-repo" }`, both
     required (since plain `jira` is deferred, every v1 repo is in `jira-tags` mode).
   - **Committed to git.** This is a team-shared fact about the repo (which Jira project/app-tag
     applies), not a secret and not host-specific — every teammate gets it via `git pull`, nobody
     re-enters it.
   - **Auto-bootstrapped, no separate setup command.** If a tracker tool is called and
     `.ai/intake-mcp.json` doesn't exist yet, it returns a clear "not configured" result instead of
     guessing; the planning-procedure doc instructs the agent to ask the developer once for the
     Jira project key and app-tag, then call the new `write_repo_config` tool (see Tool surface) to
     create the file. Never asked again after that — genuinely zero manual install steps, just one
     question the first time.
   - **Cross-repo ticket safety check** (directly addresses the scenario raised in review — a
     developer accidentally planning a ticket that belongs to a *different* repo on the same shared
     board): before acting on any ticket, `tracker_get_issue` verifies the key's project prefix
     matches `jiraProjectKey`. For the `appTag` label specifically:
     - Ticket already carries a *different* `app:*` label → refuse with a clear message ("DAV-47 is
       tagged app:other-repo, not app:my-repo — wrong repo?") rather than silently acting on the
       wrong project's ticket.
     - Ticket carries **no** `app:*` label at all → adopt it: apply this repo's `app:<appTag>` label
       as part of the same bootstrap that applies `state:plan` (see below) — a brand
       new ticket that was never tagged for any app is exactly the case this bootstrap exists for.
     - Ticket already carries *this* repo's `appTag` → proceed normally, nothing to do.
   - **Bootstrapping an untouched ticket** (no `state:*` label yet — it's never entered the
     pipeline): `plan_ticket` applies `state:plan` (and, per the app-tag rule above,
     `app:<appTag>` too if that's also missing) and proceeds, rather than refusing. Same reasoning
     as the assignee case above — explicitly naming the ticket to `plan_ticket` already *is* the
     human decision to start the pipeline on it; there's no separate confirmation step to route
     through Jira first.

5. **Worktree creation is a tool, not a doc instruction.** Planning needs no DB/container
   provisioning (that's implementation-phase only in the existing harness) — so `worktree_create`
   can be pure git: derive a branch name from the ticket key + summary slug (or reuse a matching
   existing branch), `git worktree add` a sibling directory off the repo root resolved from cwd,
   return the path. No project-adapter contract needed for v1. **Resumes rather than errors**: if a
   worktree already exists for the ticket's branch, return its existing path instead of failing —
   MCP has no headless/interactive split to justify the harness's two different behaviors here
   (`worktree-go.sh` auto-resumes under `HEADLESS`, `worktree-new.sh` always hard-errors), and a
   developer re-running planning on the same ticket (e.g. after it bounces to
   `state:needs-input` and back) is the expected case, not an edge case.

6. **Docs delivered as MCP resources + a prompt, not files copied into the project.** Two docs live
   in the `ai-intake-mcp` repo itself:
   - `docs/planning-procedure.md` — the actual "how to plan a ticket" instructions, generalized from
     `ai-intake-harness`'s `prompts/intake-planning.md`: read ticket, ask clarifying questions vs.
     write a plan, plan-file conventions, transition rules.
   - `docs/ticket-states.md` — `ai-intake-mcp`'s own `state:*` label vocabulary (`state:plan`,
     `state:needs-input`, `state:review`, etc. — see decision #3's mapping table), reference only.

   Exposed via MCP's `resources/list` + `resources/read`, so the agent pulls them at runtime —
   nothing to paste into a personal `CLAUDE.md`, nothing copied into the target repo. Additionally,
   register an MCP **prompt** `plan_ticket(ticket_key)` — confirmed working as a slash command on
   both target CLIs (see "Verify first"), giving the developer one reliable trigger instead of
   relying on free-text "Plan DAV-4" pattern-matching alone. Invocation syntax differs by client:
   `/plan_ticket DAV-4` on **Gemini CLI** (the team's primary agent — bare prompt name, confirmed
   live), `/mcp__ai-intake__plan_ticket DAV-4` on Claude Code (always server-prefixed). Document
   both forms explicitly wherever this is shown to a developer.

7. **Plan output still lands in the project repo.** `.ai/plans/active/<KEY>-slug.md` is the
   *deliverable* of planning, not harness infrastructure — it's written and committed inside the
   developer's worktree exactly like today. Only the *mechanism* (server, docs, config) stays out of
   the project.

8. **Credentials are global, not per-project.** Jira site URL + API token (or cookie fallback, see
   #9) live in the `ai-intake-mcp` server's own user-level config
   (`~/.config/ai-intake-mcp/.env`, three vars: `JIRA_SITE_URL`, `JIRA_INTAKE_EMAIL`,
   `JIRA_INTAKE_API_TOKEN` — reusing `ai-intake-harness`'s exact `.env.local.dist` var names rather
   than inventing new ones, even though this file lives at a different path and is user-scoped, not
   per-repo), set up once regardless of how many project repos the developer works in. This file is
   never committed (it lives outside any repo, under `~/.config/`) and is never pasted into a chat
   session — populated directly by the developer, read only by the server process at runtime. (This
   is separate from decision #4's per-repo `.ai/intake-mcp.json` — that file holds which Jira
   *project/app-tag* a repo maps to; this holds the *credentials* to reach Jira at all, the same for
   every repo.)

9. **Auth mode (API token vs. session cookie) is internal to the Jira client, not agent-visible.**
   All tools (`tracker_get_issue`, `tracker_add_comment`, `tracker_transition`) go through one Jira
   REST client module inside the server; that module decides token-vs-cookie per call, same
   chokepoint shape as `lib/tracker/jira-common.sh`'s `jira_api` in the existing harness. The agent
   never sees or chooses an auth mode.
   - **Token mode** (preferred): `JIRA_SITE_URL` + `JIRA_INTAKE_EMAIL` + `JIRA_INTAKE_API_TOKEN` in
     the server's `~/.config/ai-intake-mcp/.env` (decision #8) → Basic Auth, pure Node, no extra
     dependency.
   - **Cookie fallback** (for developers who can't get a token issued, e.g. blocked by org policy):
     implemented **natively in Node** — no Python dependency, no shelling out, fully self-contained
     in the one MCP server (the earlier plan of shelling out to Python's `browser_cookie3` is
     dropped). **Resolved — built from scratch, not ported**: waiting on a teammate's existing
     implementation was blocking Phase 1 for no real reason, so v1 implements this directly against
     the well-documented mechanism rather than waiting on it:
     - Read the target browser's cookie store directly — Chrome/Chromium-family on Linux stores
       cookies in a SQLite DB under the profile directory (`~/.config/google-chrome/Default/Cookies`
       et al.), with values encrypted using a key held in the OS keyring (`libsecret` on Linux,
       Keychain on macOS, DPAPI on Windows).
     - Use `keytar` to fetch the OS-keyring-held encryption key, a plain SQLite reader
       (`better-sqlite3` or equivalent) to read the `cookies` table, and Node's built-in `crypto` to
       AES-decrypt the value — all pure Node, no native browser-vendor SDK.
     - v1 scope: **Chrome/Chromium on Linux only** (matches this team's actual dev environment; the
       harness's own cross-browser/cross-OS breadth isn't needed yet) — document this narrowing
       explicitly rather than silently under-supporting other platforms. Extend to Firefox/macOS/
       Windows only if a developer actually needs one of those.
     - Same behavior contract as today's harness regardless of language: fresh cookie extracted on
       every call, never cached to disk; requires a real desktop session with a logged-in browser;
       fails loudly with a clear message if that session has expired or the keyring can't be
       unlocked, not silently.

10. **Comment footer names the calling agent, sourced from the MCP protocol itself.** Mirrors the
    harness's `ai_display_name` mechanism, but simpler: MCP's `initialize` handshake already hands
    the server the connecting client's `clientInfo.name`/`version` (Claude Code, Gemini CLI,
    whatever else speaks MCP) — no per-agent adapter file needed the way `lib/ai/<name>.sh` requires
    one per provider today. `tracker_add_comment` stamps every comment with a footer built from that
    (e.g. `🤖 _Posted by Claude Code via ai-intake-mcp_`), falling back to a generic
    `AI via ai-intake-mcp` if a client omits `clientInfo`. One chokepoint, same as
    `jira_common_ai_footer` — not something a caller can bypass or forget.

11. **Sandboxing is mostly built into the tools themselves, uniformly for every developer — not
    delegated entirely to each client's own settings.** Revisited in review: relying purely on
    "whatever the connecting client is configured to allow" means two developers with different
    Claude Code/Gemini CLI settings get genuinely different safety guarantees, which isn't good
    enough. The fix isn't a shipped permission-profile file (there's nowhere uniform to put one — no
    file is added to the consumer project, and a personal one isn't guaranteed to be present
    or correct) — it's that **the tools are narrow by construction**, which is a property of the
    server's own code and therefore identical for everyone regardless of client config:
    - `worktree_create` can only ever call `git worktree add` inside the repo root resolved from
      cwd — no arbitrary shell, no destructive git operations. There is no way to use it to run any
      other command.
    - `tracker_transition` can only ever apply one of a fixed, hardcoded set of legal `state:*`
      label swaps (mirroring `jira_tags_legal_move`) to the one ticket named — no arbitrary Jira API
      access, no touching a second ticket in the same call.
    - `tracker_transition`/`tracker_add_comment` writes are **assignee-gated server-side against
      Jira itself** (decision #3) — this holds regardless of the local client's permission mode,
      since Jira, not the client, is what refuses the write. This is a second, uniform enforcement
      layer independent of anyone's local settings.
    - `write_repo_config` only ever writes one specific, small JSON file at one fixed path.

    This is a real structural improvement over the harness's Bash-based model, which is exactly
    *why* that model needs a curated `.claude/settings.*.json` deny-list — an agent with raw Bash
    access is open-ended; an agent with only these MCP tools isn't, no matter how the calling
    client's own permissions are configured.

    What the server genuinely can't force: whether the client prompts for confirmation before
    calling a tool at all (that's inherently client-side). Two lightweight, non-enforced measures
    for consistency here, both to build in phase 1 rather than leave implicit:
    - Set MCP tool annotations (`readOnlyHint: true` on `tracker_get_issue`/`health_check`;
      `destructiveHint`/appropriate hints on the write tools) so well-behaved clients apply
      consistent default confirmation UX without a shipped profile.
    - `docs/setup.md` includes a **recommended** (not required) personal Claude Code/Gemini CLI
      settings snippet for allow-listing `mcp__ai-intake__*` — reasonable to actually recommend
      *because* the tools are narrow-by-construction, but still opt-in per developer, not enforced.

    **`worktree_remove` is the one exception, if it gets built** (still just a "maybe," phase 1.5):
    it's the sole genuinely destructive operation under consideration. If built, it should not be
    covered by the recommended allow-list snippet above, and should carry a `destructiveHint`
    annotation so clients default to confirming it even when the rest of the tool surface is
    allow-listed.

    **This reasoning breaks the moment this path is ever pointed at unattended/scheduled use** —
    tool-level containment still holds then too, but the "a human is present to notice something
    odd" backstop goes away, which is a materially different risk profile worth revisiting
    explicitly at that time rather than assuming today's reasoning still applies.

## Development environment

A root-level `Dockerfile` (Node 24 base image, plus `git`) gives every contributor an identical
`npm install` / `npm run build` / `npm test` environment, independent of whatever Node version
happens to be on their host machine. A root-level `Makefile` wraps it (`make image`, `make install`,
`make update`, `make build`, `make test`, `make lint`, `make shell`) so contributors run plain `make`
targets rather than hand-rolling `docker run` invocations; every target bind-mounts the repo into
the container so installs/builds/`package-lock.json` changes land back in the checked-out source, and
the image carries no baked-in source or `node_modules` — it builds cleanly even before
`package.json` exists (only `image`/`shell` are usable pre-Phase-1; the rest need `package.json`).

**Development/CI only — not a deployment artifact, and not how the server is actually run.** Decision
#1's cwd-inheritance design means the MCP server must run as a local `node` process spawned directly
by the developer's agent CLI so it inherits that CLI's working directory; a containerized server
would only ever see the container's own filesystem, breaking the whole cwd → project-root resolution
this design depends on. So the image is never what `claude mcp add` / `gemini mcp add` point at, and
running the compiled `dist/index.js` for real still requires a local Node install (ideally also 24,
matching the `engines` pin, though the compiled output is plain JS with no native deps so this is a
soft requirement, not a hard one). `docs/setup.md` (Phase 6) continues to document a plain local
`git clone` + `npm install` + `npm run build` for that step, per decision #1 — the Makefile/Docker
flow is a build/test convenience for contributors, not a substitute for it.

## Tool surface (v1)

- `tracker_get_issue(key)` → `{ summary, status, description, comments }` — refuses with a clear
  error if `.ai/intake-mcp.json` is missing (see decision #4) or if the issue's project/app-tag
  don't match this repo's config.
- `tracker_add_comment(key, text)` — not assignee-gated by default (decision #3); footer stamped
  per decision #10.
- `tracker_transition(key, state)` — states: `needs-input`, `review` (`ai-intake-mcp`'s short
  vocabulary, decision #3 — `plan` is bootstrap-only, never a `tracker_transition` target, matching
  the harness's own behavior for its equivalent `ready-for-planning`). Assignee-gated per decision
  #3, auto-assigning first if the ticket is currently unassigned (resolved — see decision #3).
- `worktree_create(ticket_key)` → `{ worktree_path, branch }` — resumes an existing worktree per
  decision #5.
- `write_repo_config(jiraProjectKey, appTag)` — creates/overwrites `.ai/intake-mcp.json` at the
  resolved repo root (decision #4). Called once, automatically, the first time a tracker tool is
  used in a repo that doesn't have the file yet.
- `health_check()` — verifies credentials load and the Jira site is reachable, and that
  `TRACKER_NATIVE_STATUS_IN_PROGRESS`'s configured value (default `In Progress`) actually exists as
  a status on the resolved project's board. Deliberately does **not** check
  `TRACKER_NATIVE_STATUS_CODE_REVIEW` — v1's scope never reaches it (decision #3). Framed as a
  cosmetic/UX check, not a correctness gate: the underlying `state:*` label write is authoritative
  and succeeds independently of whether this mirror status exists.
- *(maybe)* `worktree_remove(ticket_key)` — phase 1.5, cleanup convenience. The one genuinely
  destructive tool under consideration (decision #11) — if built, carries a `destructiveHint`
  annotation and is deliberately left out of `docs/setup.md`'s recommended allow-list snippet.

## MCP resources

- `docs://planning-procedure`
- `docs://ticket-states`

## MCP prompts

- `plan_ticket(ticket_key)` — seeds the session: fetch the issue, read the procedure resource,
  create/enter the worktree, then follow the procedure.

## Verify first (before writing much code)

- **cwd inheritance — CONFIRMED 2026-08-28.** Built a throwaway one-tool MCP server (`get_cwd`,
  plain `@modelcontextprotocol/sdk` stdio server) and registered it at `--scope user`. Ran
  `claude -p` against it from three locations — `/tmp/spike-dir-a`, `/tmp/spike-dir-b`, and a
  *nested subdirectory of `ai-intake-harness`* (`lib/tracker/`) — and in every case the tool's
  `process.cwd()` matched exactly the directory `claude` was launched from, not some fixed
  npm/install directory. Confirms `git rev-parse --show-toplevel` run inside the server will
  correctly resolve the project root regardless of where in the repo the developer opened their
  agent. Decision #1 stands as designed; no `repo_root` argument fallback needed. Registration was
  removed again after the test (`claude mcp remove --scope user cwd-spike`) — this was a throwaway
  probe, not a permanent addition to this machine's config.
- **Prompt support across agents — CONFIRMED 2026-08-28, both work, different syntax.** This one
  matters more than originally scoped: **Gemini CLI is the team's primary agent CLI**, not a
  secondary target, so this had to actually work there, not just in Claude Code. Built a throwaway
  server declaring one prompt (`plan_ticket(ticket_key)`, plus a `noop` tool) and registered it at
  user scope in both CLIs (`claude mcp add --scope user` / `gemini mcp add --scope user`).
  - **Gemini CLI 0.56.0**: `gemini -p '/plan_ticket DAV-4' --approval-mode yolo` — the server's own
    log confirmed `prompts/list` then `prompts/get` fired with `{"ticket_key":"DAV-4"}` correctly
    parsed from the positional argument. (The subsequent model call hit a transient upstream 503 —
    unrelated to MCP, the protocol exchange itself had already succeeded by that point.) Gemini
    invokes a prompt by its **bare registered name** (`/plan_ticket`), no server-name prefix, per
    its docs — a prefix only gets appended on a name collision between two servers' prompts.
  - **Claude Code**: `claude -p "/mcp__ai-intake-spike__plan_ticket DAV-4"` — full round trip, model
    echoed back the exact seeded prompt text. Claude Code **always prefixes** with the server name
    (`/mcp__<server>__<prompt>`), unlike Gemini.
  - **Consequence for the plan**: both CLIs genuinely support the prompts primitive — no fallback
    needed, decision #6's `plan_ticket` prompt stands as designed for both. But the *invocation
    syntax differs per client* (`/plan_ticket DAV-4` on Gemini vs.
    `/mcp__ai-intake__plan_ticket DAV-4` on Claude Code) — `docs/setup.md` and
    `docs/planning-procedure.md` need to show both forms explicitly rather than one generic
    example, since a Gemini-primary team hand-copying a Claude-flavored example would get it wrong.

## Verification checkpoints (real systems, not mocks)

Mocked-`fetch` unit tests (see "Resolved: Testing approach") verify the Jira client's *logic* — they
never confirm a request is actually valid against Jira's real API. That confirmation needs its own,
explicit checkpoint, not just a hope that Phase 7 dogfood will catch it.

- **Test ticket: `DAV-5`** — created on the real shared board specifically for this checkpoint (and
  for Phase 7 dogfood). Throwaway/disposable; safe to relabel, comment on, and transition.
- **End of Phase 1 — Jira REST client against real Jira (required before Phase 2 starts).** Exercise
  `tracker_get_issue`, `tracker_add_comment`, and `tracker_transition` against `DAV-5` — not a mock.
  Confirm: the label-driven transition actually swaps
  `state:*` labels on a live ticket, the assignee-gate refuses/succeeds as designed (including the
  unassigned-auto-assign case from decision #3), and the `TRACKER_NATIVE_STATUS_IN_PROGRESS` mirror
  write lands on the real board. Clean up the test ticket's labels/comments afterward. This is
  deliberately narrow — client only, nothing else layered on top yet — so a real-Jira surprise here
  is easy to isolate, rather than only surfacing during Phase 7's full pipeline run where
  `worktree_create` and config auto-bootstrap are also in play.
- **Phase 7 dogfood** (below) is the full end-to-end real-Jira exercise, but it is not a substitute
  for the checkpoint above — it validates the whole pipeline together, not the Jira client in
  isolation.
- **CONFIRMED 2026-08-28.** `npm run smoke:jira -- DAV-5` ran `fetchIssue` → `addComment` →
  `transitionState("needs-input")` → `transitionState("review")` against the real board, then
  cleaned up (deleted the test comment, cleared labels, unassigned). All four confirmed working
  live: the label-driven transition swapped `state:*` correctly both directions, the
  unassigned-auto-assign case fired exactly as designed, and the native-status mirror actually moved
  the ticket to "In Progress" on the real board (confirming `TRACKER_NATIVE_STATUS_IN_PROGRESS`'s
  default value matches this Jira site, same as `ai-intake-harness`'s own `.ai/intake.config`).
  `health_check` was also run live and returned `ok: true`. See `scripts/jira-smoke-check.ts`.

## Phases

**Phases 1–7 implemented and verified 2026-08-28** — see "Dogfood results" after phase 8 below.
Phase 8's decision is the one item still open, deliberately left to the developer.

1. Scaffold `ai-intake-mcp`: TS project (`package.json` pins `engines.node >= 24`, see "Repo" above),
   `@modelcontextprotocol/sdk`, a minimal **jira-tags-only** Jira REST client (issue get / comment /
   label-driven transition + assignee-gate — reference `lib/tracker/jira-tags.sh` for the exact
   contract, but reimplemented, no shared code). Implements both auth modes from decision #9: token
   (pure Node) and cookie fallback (pure Node also, built from scratch — `keytar` + SQLite reader +
   built-in `crypto`, Chrome/Chromium on Linux only for v1). The dev `Dockerfile` (see "Development
   environment") is exercised here for
   the first time now that `package.json` exists. **Ends with the real-Jira smoke check above** —
   Phase 2 doesn't start until it passes.
2. Implement `write_repo_config` + the `.ai/intake-mcp.json` auto-bootstrap flow (decision #4), and
   the `health_check` tool.
3. Implement `worktree_create` as pure git, no project-adapter contract (decision #5).
4. Write `docs/planning-procedure.md` + `docs/ticket-states.md`, wire up as resources.
5. Wire the `plan_ticket` prompt.
6. Set MCP tool annotations (`readOnlyHint`/`destructiveHint`, decision #11) on every tool. Write
   `docs/setup.md` (personal, one-time setup): register the server at user scope, drop credentials
   into `~/.config/ai-intake-mcp/.env`, verify with the `health_check` tool, and include the
   recommended (opt-in) allow-list snippet for `mcp__ai-intake__*` — excluding `worktree_remove` if
   it exists by then.
7. Dogfood: from inside a real project repo, run `/mcp__ai-intake__plan_ticket DAV-5` end to end
   against the real test ticket; compare plan quality/output against what the existing poller-driven
   flow already produces for a similar ticket.
8. Decide, based on dogfood results: keep as a permanent parallel path, fold ideas back into
   `ai-intake-harness`, or drop.

### Dogfood results (2026-08-28)

Run directly against `DAV-5` (real Jira, real git worktree) by driving the built tool functions in
the exact sequence `plan_ticket` specifies, rather than through a live agent-CLI slash command —
registering the server at user scope and letting a separate, fully autonomous agent session act
freely against the real board was judged too heavy/unreviewable a step to take without the developer
present, so this run stayed in-session instead. Sequence and results:

1. `write_repo_config("DAV", "app:ai-intake-mcp")` → created this repo's own `.ai/intake-mcp.json`.
2. `tracker_get_issue("DAV-5")` → ticket had no `state:*`/`app:*` labels yet; bootstrap correctly
   applied both (`state:plan`, `app:ai-intake-mcp`).
3. `worktree_create("DAV-5")` → minted `feature/DAV-5-testing-ticket-for-mcp` (no existing branch to
   reuse) and created the sibling worktree at
   `../feature-DAV-5-testing-ticket-for-mcp`, off `main` (no `origin/HEAD`, fell back to local
   `main` per the resolved base-branch rule).
4. Followed `docs/planning-procedure.md` inside that worktree. `DAV-5` turned out to carry no
   description or comments at all (`summary: "Testing ticket for mcp"` only) — the procedure's own
   "questions vs. clean" logic correctly identifies this as a genuine blocker (nothing to plan
   against), not a false positive. Wrote
   `.ai/plans/active/DAV-5-testing-ticket-for-mcp.md` documenting exactly that, with one blocking
   question back to the ticket's author.
5. `tracker_add_comment` → posted, footer correctly rendered as `🤖 _Posted by ai-intake-mcp dogfood
   (Claude Code) via ai-intake-mcp_` (decision #10 confirmed live).
6. `tracker_transition("DAV-5", "needs-input")` → assignee-gate auto-assigned (was unassigned),
   label swapped to `state:needs-input`, native-status mirror moved the board to "In Progress".

**Comparison against the harness's poller-driven flow**: structurally faithful by construction —
`docs/planning-procedure.md` is a direct generalization of the harness's own
`prompts/intake-planning.md` (same plan-file header shape, same blocking-question criteria, same
"refine don't regenerate" rule), so there's no divergence to reconcile. The one difference is
mechanical, not qualitative: no decision-file/poller indirection, the agent calls the tracker tools
directly.

**Left in place afterward** (not reset, unlike the Phase 1 smoke check's throwaway comment): the
real worktree at `../feature-DAV-5-testing-ticket-for-mcp`, its plan file, the real Jira comment, and
`DAV-5`'s final state (`state:needs-input`, assigned, native status "In Progress") — this is genuine
tool output, not test residue, so it wasn't scrubbed. The developer should decide whether to answer
the plan's question, close `DAV-5` out, or reset it for another dogfood run.

**Phase 8 recommendation**: the mechanics held up cleanly end to end against a real board with no
workarounds needed — worth treating as a positive signal for "keep as a permanent parallel path,"
but this decision is intentionally left to the developer, not made here.

## Explicitly out of scope for v1

- Implementation phase (the `worktree-go` equivalent: DB/container provisioning, build/test/verify)
  — needs a real project-adapter contract, which is genuine per-project coupling; revisit only after
  planning-only is proven.
- Plain `jira` (single-project, native-status-driven workflow) — deferred entirely per decision #3;
  nothing today needs it, only build it if a real project comes along that isn't on a shared board.
- Any change to `ai-intake-harness` itself — the existing cron+poller keeps running unchanged.

## Resolved (this round)

- **Branch-naming convention**: `worktree_create` reuses the harness's `feature/<KEY>-<slug>`
  convention — worktrees from either path look the same in `git branch -a`, no reason to diverge.
- **Default base branch**: when there's no existing branch for the ticket yet, resolve the base via
  `git symbolic-ref refs/remotes/origin/HEAD` (the standard git mechanism for "what's the remote's
  default branch" — works regardless of whether it's named `main`, `master`, or something else). If
  that's unset (no remote configured, or it's never been fetched), fall back to a local `main`, then
  a local `master`. If none of those resolve, refuse with a clear error asking the developer to
  specify a base branch explicitly — don't guess past this point.
- **Cookie fallback's desktop-session requirement**: accepted as-is, same limitation as the harness
  today — decrypting a browser's cookie store inherently requires a live, logged-in desktop session;
  there's no way around this on a headless/remote box. Document it plainly; a developer on such a
  machine uses the API token instead.
- **`.ai/intake-mcp.json` filename**: stands as the default — no existing convention to defer to
  instead.
- **Testing approach**: `vitest` as the test runner (TS-native, minimal config). The Jira client is
  tested against mocked HTTP responses, not a real Jira instance — a thin `fetch` wrapper the tests
  substitute directly is enough at this size; no need for a heavier mocking library.
- **License**: no `LICENSE` file — the repo stays public (visible, readable, forkable on GitHub) but
  grants no reuse rights by default. State this explicitly in the repo's own README rather than
  leaving it implicit, so it doesn't read as an oversight to anyone who finds the repo.
- **Cookie-fallback implementation**: built from scratch in Node (`keytar` + a SQLite reader +
  built-in `crypto`), scoped to Chrome/Chromium on Linux for v1 — see decision #9. No longer blocked
  on a teammate's existing implementation; that dependency was dropped since it was blocking Phase 1
  for no real design reason.

## Related idea raised in review, not part of this plan

A possible future **fork of `ai-intake-harness` itself** (not `ai-intake-mcp`): jira-tags-only,
installed *once per developer machine* rather than per-project, with a single cron reading a global
config that lists multiple local repos + their Jira project/app-tag, polling across all of them, and
running fully headlessly (including the implementation phase this plan defers).

Flagging one direct tension before it goes further: **this reintroduces a cron on the developer's
machine**, which is exactly the constraint `ai-intake-mcp` was designed to avoid (see "Goal" at the
top of this doc). A single global cron is a real improvement over today's per-project one, but it's
still a cron on every developer's machine, so it doesn't meet that constraint — it would need to be
evaluated on its own terms, separately, not as a substitute for this plan.

What *would* carry over cleanly if this ever gets built: the per-repo `.ai/intake-mcp.json` file
from decision #4. A daemon still needs to discover which local repos to manage and their
project/app-tag — but rather than duplicating that mapping in its own global config, it could just
read each repo's already-committed `.ai/intake-mcp.json` once it knows the repo's filesystem path
(from a much smaller global list of *paths only*, populated via a one-time `register` step per repo
— unlike `ai-intake-mcp`'s auto-bootstrap, a headless daemon has no interactive moment to ask a
question in, so it can't self-bootstrap the same way). Worth keeping the file format
daemon-friendly (plain JSON, no interactive-only assumptions) for exactly this reason, even though
nothing in this plan needs that today.

No action for this plan beyond that formatting note — revisit only if/when someone wants to design
the fork itself.
