# Plan (draft): headless automation mode for `ai-intake-mcp`

**Status**: draft — architecture discussion captured, not scheduled

**Created**: 2026-09-02


**Related**: `.ai/plans/active/ai-intake-mcp-on-demand-planning.md` (v1, interactive planning),
`.ai/plans/active/ai-intake-mcp-implementation-phase.md` (interactive implementation — especially
decision #1, "no container/DB isolation, `make <target>` from inside the worktree," which this
plan's concurrency cap directly follows from), `.ai/guides/ai-intake-mcp-vs-harness.md` (§"Open
gaps," items 1 and 5 — global multi-project credentials and unattended permission sandboxing —
are exactly what this plan resolves). Supersedes the earlier, less-grounded exploration in
`ai-intake-harness`'s `.ai/plans/draft/multi-app-jira-controller.md`, which assumed reusing the
harness's bash engine before this project's existing lightweight-footprint design was reconsidered.

## Goal

Let `ai-intake-mcp` also run **headlessly and unattended** — no developer present at all — driving
one ticket through planning and/or implementation, across multiple registered project repos on one
machine, on a cron. Same per-repo footprint as today (`.ai/intake-mcp.json` +
optional `.ai/intake-mcp.md`, nothing else). Developers keep using the existing interactive MCP
tools (`plan_ticket`/`approve_plan`/`implement_ticket`) exactly as they do today, side by side with
this — same tool logic, same per-repo config, different invocation surface.

## Why this belongs in `ai-intake-mcp`, not a new project

The automation mode needs the same Jira client, the same per-repo config file
(`.ai/intake-mcp.json`), the same worktree/plan-file/state-label functions the interactive tools
already use. Building it as a new project would mean either forking that logic or depending on it
awkwardly. It's additive to the existing server, the same way the implementation phase was additive
to the planning phase.

## Core design decisions

1. **Deterministic orchestrator calls the existing functions directly — no MCP protocol, no
   headless worker self-driving the tracker.** `worktreeCreate`, `fetchIssue`, `transitionState`,
   `addComment`, plan-file helpers, etc. are just TypeScript functions; the automation entrypoint
   imports and calls them in a fixed sequence it controls, the same way `intake-poll.sh` owns every
   tracker write in the harness today. A headless AI CLI process (spawned detached, no terminal,
   no MCP tools wired in — see decision #14 on which CLI and how that's chosen) is invoked for
   exactly two narrow jobs — author a plan, or implement an approved one — and never calls
   `tracker_transition`/`addComment` itself. It reports back through a **result file** the
   orchestrator reads (same shape as the harness's context-file/decision-file/`impl-result.json`
   protocol — port the pattern, not the bash). This keeps every tracker write in one place,
   auditable and consistent, and never trusts an unattended model with deciding when a ticket's
   state changes — true regardless of which AI CLI actually ran.

2. **Planning pass** (per registered project, each cron tick): search for tickets in
   `state:plan` (new tickets) **plus `state:needs-input` tickets with an author reply since the
   automation's last comment (decision #18 — the re-pickup path)**, scoped to that project's own
   `jiraProjectKey`/`appTag` (read from its `.ai/intake-mcp.json` — no new per-repo file). For each
   match: create/resume a worktree, run
   the headless AI worker (whichever provider is configured for this project/ticket's planning
   pass — decision #14) against `docs://planning-procedure` to author/refine the plan (unchanged —
   it still writes/commits `.ai/plans/active/<KEY>-<slug>.md` in the target repo, same as
   interactive), then the **orchestrator** — not the AI — reads that committed plan file back out
   of the worktree
   and posts the **full plan text, inlined, as a Jira comment** (plus the file path, for
   provenance), and transitions the ticket (`needs-input` or `review` — `ai-intake-mcp`'s own
   short `ShortState` vocabulary, `src/jira/tags.ts`, not the harness's `jira-tags.sh` label
   names; corrected here after finding the mismatch while designing decision #12's watchdog).

   **This is a deliberate divergence from `docs://planning-procedure` §5's comment template**, not a
   reuse of it: that template (`"Plan ready for review at .ai/plans/active/<KEY>-<slug>.md.
   Summary: <2-4 sentences>"`) only posts a short summary + a file pointer — correct for the
   interactive case, where the developer already has the worktree open locally, but useless
   headlessly, since nobody has that worktree open and the path isn't visible from Jira at all. The
   headless orchestrator must build its own comment body (full plan text + path), not call the
   procedure's own comment step. This is the point of the whole exercise: plan review happens
   entirely on the Jira board — you should be able to approve straight from the ticket, never
   needing to open a worktree to see what a headless run proposed. (Minor open item: Jira comment
   size limits on a very large plan — likely fine for typical plan lengths, worth a sanity check
   against the Jira Cloud comment body limit before relying on it for an unusually long plan.)

   **The plan file's self-containedness is a hard requirement here, not just good practice.**
   `docs://planning-procedure` already has a "Write for a weaker executor" section (exact file
   paths, literal commands, a required `## Boundaries`, nothing left for the implementer's
   judgment) — reused unchanged. But headlessly, with planning and implementation possibly run by
   *different* AI providers (decision #14) on *different* invocations with **zero shared session
   state**, that guidance stops being about accommodating a weaker model and becomes the only
   handoff channel that exists at all: nothing else carries over between the two passes — no chat
   history, no memory, no context beyond what's written in the committed plan file (and its Jira
   comment mirror). A plan good enough for the same interactive session to pick back up isn't
   automatically good enough for a cold headless implementation run by an unrelated provider to
   pick up correctly; this is the standard the headless planning pass has to hit every time, and
   the implementation prompt (decision #14/#15) should assume it is the *only* source of truth.

3. **Implementation pass** (per registered project, subject to the concurrency cap in #5): search
   for one ticket in `state:implement` with an approved plan (`Status: ready` — see decision #17
   for how `Status` reliably gets to `ready` even when a human approved via the Jira board
   directly, never calling `approve_plan`); create/resume the worktree via the **existing,
   unchanged** `worktreeCreate` — still no database, no container
   provisioning, exactly like the interactive implementation phase already decided (see decision #1
   in `ai-intake-mcp-implementation-phase.md`). Before launching the headless AI worker, the
   orchestrator transitions the ticket to `state:working` (existing `implementTicketTool`
   behavior) **and posts a start comment** naming the ticket/branch/worktree and summarizing what's
   about to be built (from the approved plan) — today `implementTicketTool` transitions silently
   with no comment; this adds one. The headless worker (whichever provider is configured for this
   project/ticket's implementation pass — decision #14, independently selectable from whichever
   provider ran planning) implements the plan and runs whatever this project's own `make
   <target>`s do (build/test — decision #2 of that same plan, unchanged); it writes a result file
   instead of touching Jira. The orchestrator reads it and posts a **completion comment** — notes on
   what
   changed, build/test outcome, anything the AI flagged — then transitions the ticket
   (`verify` on success; back to `needs-input` or an escalation comment on failure/blocker) — same
   tracker-write boundary as #1.

   **General principle this formalizes**: Jira is the sole visibility surface for headless work.
   Every `state:*` transition automation makes — planning start/done, implementation start/done,
   escalation — is accompanied by a human-readable comment (plan details, notes, summary), never a
   silent label flip. You should never need to open a worktree or a log file to know what a headless
   run did or is doing; the ticket's comment history is the full narrative. This matches the
   harness's existing "poller posts comment ALWAYS" behavior (`docs/architecture.md`), applied here
   to both the planning and implementation passes.

4. **No new database/container provisioning, still.** The difference from the existing interactive
   implementation design isn't about DB/containers — it's about *concurrency*. That design assumed
   "one developer, one session at a time," so two worktrees never competed for the same shared dev
   container. Headless automation reintroduces exactly that possibility (two tickets' worktrees
   both wanting the same project's shared container/DB at once), which is why:

5. **Concurrency caps for both phases, but two structurally different kinds of cap** — resolves
   the earlier "planning uncapped" assumption; your call: "planning concurrency needs a cap. ensure
   there is always a global default and then a specific project override." Both enforced via the
   same per-ticket marker scheme (decision #8), but for different reasons:
   - **Implementation: fixed at exactly one in-flight ticket per project, not configurable.** This
     stays a *structural* constraint, not a policy knob — decision #4's reason (a shared dev
     container/DB that can't yet handle two worktrees at once) is a physical limitation, not a
     preference, so no global default or per-project override is allowed to raise it above 1 (a
     project can still effectively disable implementation via `enabled: false`, just not raise the
     cap). Revisit only once real per-worktree container isolation exists (still likely-future
     work, per decision #4).
   - **Planning: a real policy cap, global default + per-project override — the shape decision #9
     and #13 already established for permissions/watchdog, reused here.** `settings.json`
     (decision #13) gets a new `concurrency.planning` default; a project's `overrides` bag
     (decision #7) can raise or lower it individually:
     ```jsonc
     // settings.json
     { "concurrency": { "planning": 3 } }
     // projects.json, one project's override
     { "overrides": { "concurrency": { "planning": 1 } } }
     ```
     **Default proposed: 3 concurrent planning tickets per project** — planning has no
     container/DB conflict to avoid (decision #4 doesn't apply), so the reason to cap it at all is
     bounding cost/API-rate exposure and host load, not correctness; 3 allows real parallelism
     without being effectively unbounded. Adjustable — say if you want a different starting number.
     Enforced the same way as implementation's check: before dispatching a new planning worker,
     count existing `phase: "planning"` markers for this project and skip dispatching (not skip the
     whole project — just that one new ticket, trying the next tick) once at the cap.
   - Different projects still don't share any cap with each other — each project's planning count
     and implementation single-slot are checked independently, exactly as before.

6. **A project repo can be scoped to a *collection* of Jira project keys, not just one.**
   `.ai/intake-mcp.json`'s `RepoConfig` (`src/repo-context.ts`) currently has a single
   `jiraProjectKey: string`. That needs to become a list (e.g. `jiraProjectKeys: string[]`) so one
   repo's automation (and, for free, its interactive tools) can discover/validate tickets filed
   under any of several Jira project keys, not just one — this is exactly the same shape the
   harness's `TRACKER_PROJECT_KEY` never needed because the harness assumes one tracker project per
   repo; this system explicitly does not. Every current single-key consumer needs updating for the
   new shape:
   - `tracker_get_issue`'s wrong-repo guardrail (`src/tools/tracker-get-issue.ts`) — today rejects
     unless `issue.projectKey === repoConfig.jiraProjectKey`; becomes "unless `jiraProjectKeys`
     includes it."
   - `write_repo_config` (`src/tools/write-repo-config.ts`, `src/index.ts`'s `jira_project_key`
     tool param) — accepts/writes the list, not a single string.
   - The new `tracker_search`/JQL builder (new work, see below) — spans the whole collection in one
     query (`project in ("KEY1","KEY2",...) AND labels = "app:Y" AND labels = "state:Z" AND
     assignee = currentUser()`), so headless polling of a multi-key repo is still one query per
     project per pass, not one per key.
   - **Backward compatibility**: existing committed `.ai/intake-mcp.json` files use the singular
     field — keep reading it as a one-element list rather than breaking every repo that's already
     adopted this tool.
   - **Confirmed**: `appTag` stays singular (one repo = one app identity across however many Jira
     project keys feed it) — your call: "appTag should be unique per project." Uniqueness itself
     is already the exact thing decision #20's registration-time collision check enforces (it
     refuses to register a tag already claimed by a different repo, in this registry or found
     live on the board); this decision just confirms the *singular* part — no `appTags: string[]`
     alongside `jiraProjectKeys: string[]`.

7. **Global project registry (new)** — `ai-intake-mcp` today only ever knows "the repo the calling
   agent's `cwd` is in." Headless mode needs an explicit list of repos it's allowed to drive.
   Proposed home: `~/.config/ai-intake-mcp/projects.json`, sibling to the existing global `.env`
   (`src/config.ts`). Each project's Jira scoping (`jiraProjectKeys`/`appTag`, per #6) still comes
   from *that repo's own* `.ai/intake-mcp.json`, never duplicated in the registry — this file is
   only "which repos, and how automation should treat each one."

   **Schema (resolved — flexible/additive, per your steer)**:
   ```jsonc
   {
     "projects": [
       {
         "path": "/home/you/dev/my-app",     // required; local repo checkout
         "name": "my-app",                    // optional; defaults to basename(path) — used in
                                               // logs and comment footers, decoupled from the
                                               // directory name
         "enabled": true,                     // optional, default true — false pauses both
                                               // planning and implementation passes for this
                                               // project without removing its entry
         "overrides": {                       // optional; every field independently optional —
                                               // an open bag so new override keys can be added
                                               // later without a schema migration. Anything
                                               // omitted falls back to a global default (decision
                                               // #13) — permissions in particular default to ONE
                                               // shared global profile (decision #9), not per-project.
           "permissionProfile": "/home/you/.config/ai-intake-mcp/permissions/my-app-claude.json",
                                               // Claude only — a real per-project override (a
                                               // different --settings path). NOT meaningful for
                                               // Gemini: its policies are machine-global by tier
                                               // (decision #9's Workspace-tier bug), so there is no
                                               // way to give one project a different Gemini policy
                                               // right now — omit this override when the project's
                                               // provider is Gemini, or it's silently a no-op.
           "worktreeRoot": "/home/you/dev/my-app-worktree-root",
           "concurrency": { "planning": 1 },  // decision #5 — planning only; implementation's cap
                                               // is a fixed structural 1, never overridable here
           "watchdog": { "implementation": { "maxAttempts": 5 } }  // per-phase shape, decision #13
         }
       }
     ]
   }
   ```
   `path` and `enabled` are the only two the loop itself must check; everything under `overrides`
   is resolved lazily wherever that setting is actually consumed (permission-profile lookup,
   worktree creation, concurrency check, watchdog sweep) — so adding a new override later never
   touches the loader.

   **Resolved**: registration is a proper pre-flight check, not a dumb append — see decision #20's
   app-tag collision check and registration wizard.

8. **Runtime/state files (new) — one marker per active ticket, uniform across both phases.**
   `~/.config/ai-intake-mcp/state/<project-name>/workers/<TICKET-KEY>.json`, one file for as long
   as a headless worker is dispatched on that ticket (deleted on clean completion), holding
   `{ ticketKey, phase: "planning" | "implementation", pid, launchedAt, lastHeartbeatAt,
   progressReadPosition, attempts, escalated }`. This single scheme is what makes decision #12's
   watchdog able to sweep both phases the same way (found there was no Jira-label signal to
   distinguish "not yet started" from "actively being planned" — `ai-intake-mcp` has no
   intermediate label for that, tickets sit in `state:plan` the whole time — so the marker file is
   the only source of truth for "something is currently running on this ticket," not the tracker).
   Plus per-ticket context/decision/result files and logs, same directory tree, never inside the
   target repo. Matches the existing "nothing required in the repo beyond the two config files"
   philosophy.

9. **Permission sandboxing for headless runs — one global profile for all projects, per-provider
   shape, resolved.** Flagged as an open gap in `ai-intake-mcp-vs-harness.md` §5 and now directly
   triggered: an unattended headless worker needs a curated deny-list (no `git push`, no deploy
   commands, etc.). **Resolved: one global profile, not per-project** — simpler, and (for Gemini,
   below) the only thing that currently works at all. Since the worker can be any configured
   provider (decision #14), the profile's *shape* is still per-provider:
   - **Claude**: `--settings <path>` pointing at one global JSON file, e.g.
     `~/.config/ai-intake-mcp/permissions/claude.json` (harness-familiar shape: `permissions.allow`/
     `permissions.deny`).
   - **Gemini — corrected after checking the actually-installed CLI (0.58.0) against real docs,
     not just the harness's `lib/ai/gemini.sh` comment (written and verified against 0.56.0):**
     Gemini has since replaced/superseded the old `coreTools`/`excludeTools` JSON mechanism with a
     **TOML policy engine** (`docs/reference/policy-engine.md` in the installed package) — rules
     like `[[rule]] toolName = "run_shell_command"; commandPrefix = "git push"; decision = "deny";
     priority = 100`, loaded from `.toml` files in tiered directories (Default → Extension →
     Workspace → User → Admin, highest priority wins). **Critical, and exactly why "global" is the
     right call here, not just simpler**: the CLI's own docs flag the **Workspace tier
     (`$WORKSPACE_ROOT/.gemini/policies/*.toml`, i.e. per-project/per-worktree) as currently
     non-functional** (a documented upstream bug, gemini-cli issue #18186) — a per-project policy
     file would silently do nothing right now. Only **User**-tier
     (`~/.gemini/policies/*.toml`, machine-global — every `.toml` file in that directory loads and
     combines) or **Admin**-tier (root-owned system paths, not appropriate for a user-level tool to
     self-manage) actually take effect. So the global profile is written once to a clearly-namespaced
     file, e.g. `~/.gemini/policies/ai-intake-mcp-headless.toml` — additive alongside anything else
     already in that directory, not a replacement.
   - **Scope rules to headless only, so this never affects your own interactive Gemini use**: every
     rule in that file sets `interactive = false` (a real field in the schema, exactly for this) —
     without it, these deny rules would apply to *any* Gemini CLI session on the machine, including
     one you run yourself for unrelated work. `ask_user` decisions are treated as `deny` in
     non-interactive mode anyway (per the policy engine's own semantics), which further reduces the
     risk of an accidentally-permissive default in headless mode specifically.
   - A not-yet-integrated provider may differ again — same per-provider materialization done by
     that provider's adapter (decision #14), which is exactly why this seam exists.
   - The harness's own `lib/ai/gemini.sh` is worth a look before actually implementing this — its
     comment documents the *previous* mechanism (JSON, 0.56.0) as current when it's now the
     deprecated legacy path (the policy engine's own docs say so: "the legacy `tools.exclude`
     setting in `settings.json` is deprecated in favor of policy rules with a `deny` decision").
     Not this plan's job to fix that file, but don't copy its Gemini approach verbatim without
     checking the installed CLI version first, the way this decision just did.

10. **Sequential per-project polling, three sub-passes per project — resolves Review Finding #5.**
    One loop over the registry, in order; for each project, all three sub-passes run back-to-back
    before moving to the next project — not two separate whole-registry loops:
    ```
    for project in registry (decision #7):
        1. planning pass        (decision #2/#18) — dispatch new/re-picked-up planning workers
        2. implementation pass  (decision #3, capped per #5) — dispatch one, if none in flight
        3. watchdog pass        (decision #12) — check every marker under this project's own
                                  state/<project>/workers/, restart/escalate/heartbeat as needed
        # only then move to the next project
    ```
    Chosen over a design where every project gets its planning+implementation pass first and
    watchdog runs as one separate sweep afterward: since each project already needs its own
    separately-scoped Jira query for planning/implementation (different `jiraProjectKeys`/`appTag`
    per decision #6/#7 — there's no single query spanning the whole registry the way the harness's
    single-project poller has), a second whole-registry loop just for watchdog would mean walking
    the registry twice for no real benefit — nothing in either sub-pass *waits* on a worker to
    finish (workers launch detached), so there's no throughput difference, just which order things
    happen in. One loop, three steps per iteration, keeps "everything about project X this tick"
    in one place.

11. **Collision avoidance with interactive MCP use, same identity**: no new locking primitive. Both
    the interactive tools and headless automation share one Jira identity (the existing single
    global `~/.config/ai-intake-mcp/.env` — decision already made: one board, one account, for now),
    so `assignee`-based scoping alone can't distinguish "you're on this ticket right now
    interactively" from "automation should grab it." The existing `state:*` label transition is
    what actually prevents collision — the instant anything touches a ticket, it leaves the
    discoverable queue state, so a concurrent pass (interactive or headless) won't also pick it up.
    Small residual race window if both literally start in the same instant; not solved here.

12. **Watchdog pass — resolved specifics, and covers planning too.** A firm requirement (per your
    steer that this should function like `ai-intake-harness` headlessly —
    `docs/architecture.md`'s "Watchdog pass"). **Scope, resolved: both phases**, per your call to
    add planning coverage too — unlike the harness (which only sweeps `In Progress`/
    implementation, because its planning workers are short-lived and synchronous within one poll),
    this system sweeps **every marker file** under a project's `state/<project>/workers/`
    directory (decision #8), regardless of `phase`. This is a simplification, not just an
    addition: since there's no Jira-label signal distinguishing "planning not yet started" from
    "planning stalled" (both are just `state:plan` — found while working out this scope), the
    watchdog never needs to search Jira to find what to sweep at all — it just iterates local
    marker files, which is exactly the same PID-liveness mechanism either way. Ported from
    `intake-poll.sh`'s `watchdog_check`:
    - **Mechanism, precisely, since the numbers below only make sense with this in mind**: a
      worker whose PID is still alive is *always* left alone, no matter how long it's been
      running — grace period and stall detection only ever apply to a **dead** PID with no result
      file. So a legitimately slow-but-alive Gemini run (your 25-40 minute observation) is never
      at risk of being restarted by this mechanism regardless of the grace value; the grace period
      only controls how long a *silently-crashed* worker sits unnoticed before it's retried. It
      doesn't catch a hung-but-alive process either (same limitation the harness already has,
      not new here).
    - **Grace period, per phase (decision #13, resolving Review Finding #6): implementation 1800s
      (30 min)**, per your number; **planning 600s (10 min)**, tighter since planning is typically
      much faster and a dead planning worker shouldn't sit unnoticed as long — before the watchdog
      will even consider a dead PID stalled.
    - **Retry budget: 3 total launches**, same for both phases (initial + 2 restarts), matching the harness's
      `JIRA_MAX_ATTEMPTS` default — once exhausted, or once a dead worker already left a comment
      reporting a blocker (harness's "case C"), escalate with a comment instead of restarting.
      Applies per marker, so a ticket's planning attempts and (later) its implementation attempts
      are tracked and budgeted independently.
    - **Restart is phase-appropriate**: a stalled planning marker restarts by re-launching the
      headless planning prompt in the same worktree (decision #15's prompt already handles
      re-pickup — `docs://planning-procedure` §2's existing "match → refine, don't regenerate"
      behavior, reused unchanged); a stalled implementation marker restarts via the same
      resume-aware `worktreeCreate` + implementation-prompt path already designed in #3.
    - **Escalation marks the ticket, so it isn't immediately re-dispatched.** Setting `escalated:
      true` on the marker (rather than deleting it) does double duty: it's the audit record, and —
      new, needed now that planning has no state-label change to fall back on — the planning-pass
      dispatch query (#2) must skip any ticket with an escalated marker, mirroring the harness's
      `attempts_escalated`/re-queue-by-hand pattern, or a stalled-and-escalated ticket would just
      get redispatched and immediately re-stall on the very next cron tick.
    - **New: heartbeat comments for alive-and-working tickets, both phases**, addressing your
      "post to Jira every ~25 minutes that it's still working" idea — the harness has no equivalent
      (its unattended runs are typically much shorter than what Gemini needs here). Same watchdog
      sweep, extended: for a ticket whose PID is alive, if `now - lastHeartbeatAt` (a new field on the
      running-slot marker, seeded from the start-comment time) exceeds the heartbeat interval,
      post a heartbeat comment and update `lastHeartbeatAt`. **Heartbeat interval, per phase:
      implementation 1500s (25 min)**, per your number; **planning 300s (5 min)**, matching
      planning's tighter grace period above — both intentionally shorter than their phase's own
      grace period, so a heartbeat should normally land before anyone would start wondering if it's
      stalled.
    - **Heartbeat content — resolved**: not just "still working," but a summary of what's been
      worked on since the last heartbeat and a brief note on what's next, per your ask. Composed
      from a new **progress log** the worker itself maintains — see decision #16 for the exact
      mechanism (why it has to be a plain file the worker appends to, not something the orchestrator
      infers, given decision #14's provider-agnostic design). The orchestrator's role at each
      heartbeat tick is only to read whatever's new in that file since the position it read last,
      turn it into a comment (reusing `addComment`, no new tracker primitive), and advance its
      read-position marker.
    - Cron tick frequency needs to be at least as fine as the smaller of these two intervals to be
      useful (the harness polls every 2 minutes; same cadence works fine here).

13. **Global settings file (new)**: `~/.config/ai-intake-mcp/settings.json`, distinct from
    `projects.json` (#7, "which repos") and `.env` (`src/config.ts`, credentials). Holds the
    tunable operational defaults from #12 (and any future ones) as one place to change them
    without touching per-project registry entries:
    ```jsonc
    {
      "watchdog": {
        // Per-phase, resolved (Review Finding #6): implementation's numbers came from the user's
        // own observed Gemini durations (25-40 min); planning is typically much faster, so it gets
        // its own, tighter pair — a dead planning worker shouldn't sit unnoticed for 30 minutes.
        "implementation": { "graceSeconds": 1800, "maxAttempts": 3, "heartbeatSeconds": 1500 },
        "planning":        { "graceSeconds": 600,  "maxAttempts": 3, "heartbeatSeconds": 300  }
      },
      "concurrency": {
        // decision #5 — planning only; implementation's cap is a fixed structural 1, never a
        // config value (see decision #4's reason), so it has no entry here.
        "planning": 3
      },
      "permissions": {
        // decision #9's global defaults — every project uses these unless a project overrides
        // "permissionProfile" individually (Claude only; see #7's schema note on why Gemini can't).
        "claude": "~/.config/ai-intake-mcp/permissions/claude.json",
        "gemini": "~/.gemini/policies/ai-intake-mcp-headless.toml"
      }
    }
    ```
    `maxAttempts` stays the same (3) across both phases — nothing suggested retry *count* should
    differ, only detection speed. decision #12's watchdog sub-pass (#10) picks the `implementation`
    or `planning` sub-object per marker's own `phase` field (decision #8), so one sweep over a
    project's `workers/` directory naturally applies the right numbers to each marker.

    A project's `projects.json` entry can override any of these individually via its `overrides`
    bag (#7 already designed this as an open, additive structure for exactly this purpose) —
    e.g. `"overrides": { "watchdog": { "implementation": { "maxAttempts": 5 } } }` for one flaky
    project's implementation phase only, leaving every
    other project on the global default.

14. **AI provider adapter layer — pluggable from day one, not Claude-specific.** Per your steer:
    "we must assume any AI agent could do the implementation, not just Claude." Every place above
    that spawns a headless worker does so through a provider adapter contract, ported conceptually
    from the harness's `lib/ai/<name>.sh` seam (`claude.sh`, `gemini.sh`, `codex.sh`,
    `antigravity.sh`, `local-llm.sh`) into TS (e.g. `src/ai/<name>.ts`), not hardcoded to
    `claude -p`. Minimum contract per provider: launch a detached headless run given a prompt
    (planning or implementation), a worktree, a permission-profile (resolved per decision #9,
    since its shape differs by provider), and an optional model override; return enough to track
    it (pid, log path) for the running-slot marker and watchdog.

    **v1 scope, resolved: Claude and Gemini both ship, not Claude-first-only.** Claude is the
    default (`AI_PROVIDER=claude`, mirroring the harness), but Gemini's adapter is built alongside
    it from day one, not deferred — decision #9's permission-sandboxing work (the TOML policy
    engine, `interactive = false` scoping) was already done specifically because Gemini is a real
    v1 target, not speculative. Codex, Antigravity, and local-LLM stay contract-supported but
    deferred — added on demand later, same as any other provider, once there's an actual reason
    to.

    **Per-phase, even per-ticket, provider selection** — directly answering "we may be swapping
    agents for planning and implementation stages": port the harness's existing
    `ai-plan-<profile>`/`ai-impl-<profile>` Jira-label mechanism (`intake-poll.sh`'s
    `resolve_ai_profile`, plus its legacy `ai-provider-<name>` label), resolving against named
    `provider:model` profiles defined in the new global `settings.json` (decision #13) — e.g.
    `{"aiProfiles": {"fast-impl": "gemini:gemini-2.5-pro"}}` — with a project's `overrides` (#7)
    able to set its own default profile per phase. A ticket carrying `ai-impl-fast-impl` gets
    implemented by Gemini even if `ai-plan-*` (or no label at all, i.e. the project/global default)
    put Claude on the planning pass. This is exactly why decision #2's plan-file self-containedness
    point is load-bearing, not decorative: the two passes may genuinely be different models with
    nothing in common but the committed plan file and the Jira comment thread.

15. **Headless prompts are new, provider-neutral documents — not `docs://planning-procedure`/
    `docs://implementation-procedure` reused verbatim.** Those two MCP resources are written
    *to* an interactive developer ("you talk to the developer directly," per
    `docs/planning-procedure.md`'s own header) and assume an MCP-capable session calling
    `ai-intake-mcp`'s tools itself — neither is true headlessly (decision #1: the orchestrator
    calls the functions, not the AI; there's no developer). So headless mode needs its own two
    prompt documents (plain instructions any capable coding-agent CLI can follow — no MCP tool
    calls in them, no assumption of a specific provider's features): a **headless planning
    prompt** (author/refine the plan file per §§1-4 of the existing procedure, which stay valid
    **verbatim** — see decision #17 on why this must be a literal shared include, not a
    separately-maintained paraphrase — only §5's "call `tracker_add_comment`/`tracker_transition`
    yourself" and the sandboxing assumption change, since the orchestrator does those afterward —
    and, new, append to the progress log per decision #16 after each meaningful unit of planning
    work, since #12's heartbeat now covers planning too)
    and a **headless
    implementation prompt** (implement the approved plan, run the project's `make` targets, write
    the result file per decision #1's protocol instead of touching Jira, and append to the
    progress log per decision #16 after each meaningful unit of work). Both live in `ai-intake-mcp`
    itself (e.g. `prompts/headless-planning.md` / `prompts/headless-implementation.md`, mirroring
    the harness's `prompts/intake-planning.md` convention) since they're operational instructions
    to a worker process, not developer-facing docs — unlike the MCP resources, they don't need to
    be served over the protocol at all, just read into the launch prompt by the provider adapter.

16. **Progress log — how a provider-agnostic heartbeat gets real content, for either phase.** The
    heartbeat's "summary since last update + what's next" (decision #12, now scoped to planning
    and implementation both) can't come from the orchestrator inferring it (it isn't watching the
    work happen) or from a provider-specific streaming/hook API (decision #14 rules that out — must
    work the same for any provider). The only mechanism that works for *any* coding-agent CLI is
    one it already knows how to do: write to a file. Both headless prompts (#15) instruct the
    worker to append a short entry to a well-known path after completing each meaningful step —
    for implementation, a step of the plan's Implementation Order; for planning, a natural
    checkpoint (e.g. finished reading the ticket/codebase, drafted a first pass, resolved an open
    question) —
    e.g. `<worktree>/.ai/progress/<TICKET-KEY>.log` (gitignored, never committed; pure runtime
    scratch, consistent with nothing-required-in-the-repo), each entry two lines: `Done: <what was
    just finished>` / `Next: <what's about to start>`. The running-slot marker tracks a read
    position (line count, not a timestamp — more precise than diffing by time) alongside
    `lastHeartbeatAt`; each heartbeat tick, the orchestrator reads every entry appended since that
    position, composes a comment (`Done` lines since last heartbeat, bulleted; the most recent
    `Next` line), and advances the position. **Fallback**: if nothing new was appended since the
    last heartbeat (the worker's stuck mid-step, or simply didn't get to a natural checkpoint),
    fall back to restating the last known `Next` line rather than posting an empty-feeling comment.

17. **The "highly detailed plan" bar is identical for headless and interactive planning, and
    partly structurally enforced, not just instructed.** Your ask directly: plans must always be
    highly detailed, regardless of which surface authored them.
    - **No separate, lighter headless standard.** The headless planning prompt (#15) doesn't
      paraphrase `docs://planning-procedure` §§1-4's "write for a weaker executor" / plan-shape
      requirements (exact file paths, literal copy-pasteable commands, an acceptance check per
      step, a required `## Boundaries`, accumulated `## Open Questions`) — it includes that content
      **verbatim** (a shared source file both prompts pull from, or the headless prompt literally
      quotes it), so the two can never drift into "the headless one is thinner" over time.
    - **New structural gate: a required, non-empty `## Implementation Order` section.** Today only
      `## Boundaries` (`planHasBoundariesSection`, checked at `implement_ticket` time) and
      resolved `## Open Questions` (`planHasUnresolvedOpenQuestions`, checked at `approve_plan`
      time) are programmatically enforced — nothing checks that a plan actually has an
      implementation order at all. Add `planHasImplementationOrderSection` (`src/plan-file.ts`,
      same shape as the existing two) and check it everywhere a plan is accepted as done: interactive
      `approve_plan` (alongside its existing Open-Questions check) **and** the headless planning
      pass, right before the orchestrator ever posts to Jira/transitions to `state:review` (decision
      #2) — a plan missing this section is never silently allowed through. **Failure path,
      resolved (was Review Finding #3.1)**: NOT routed to `needs-input` — that channel is for the
      *ticket author*, and a missing Implementation Order is the *worker's* mistake, not something
      an author can fix. Instead treated as a failed planning attempt: restart via the watchdog's
      existing retry path (decision #12), with a correction note injected into the relaunch prompt
      ("your previous plan was missing a required `## Implementation Order` section — add one"),
      same retry budget as any other stall, escalate with a comment once attempts are exhausted —
      exactly like any other planning failure, not a special case. **Honesty about what this can
      and can't catch**: a structural check
      can verify the section *exists and isn't empty*, not that its steps are genuinely literal —
      that quality bar still rests on the shared prompt wording above and on human review at
      approval time. Not a substitute for #15's shared instructions, a backstop under them.
    - **Closes a real gap for headless-approved tickets**: `approve_plan` is what currently flips
      the plan file's `Status: draft` → `ready` (`setPlanStatus`) — but if a human approves a
      headlessly-authored plan by changing the Jira label directly on the board rather than calling
      `approve_plan` interactively (plausible, even likely, given decision #2's whole point is
      "review and approve from Jira"), nothing would ever flip the plan file's `Status`, and
      `implementTicketTool`'s existing status check would then just block forever. So: the
      implementation pass (#3), the first time it picks up a `state:implement` ticket whose plan
      file is still `Status: draft`, must itself run the **same** checks `approve_plan` runs
      (Open Questions resolved, now also Implementation Order present) and set `Status: ready`
      itself before proceeding — reusing `planHasUnresolvedOpenQuestions`/the new
      `planHasImplementationOrderSection`, not duplicating the logic, so a plan can never reach
      implementation without passing the identical gate regardless of which path approved it.
      **Failure path, resolved (was Review Finding #3.2)**: if those checks *fail* here — a human
      moved the Jira label to `state:implement` on a plan that still has unresolved Open Questions
      or no Implementation Order — the orchestrator bounces the ticket back to `state:review` (not
      an escalation) with a comment naming exactly what's unresolved and why implementation can't
      start yet. A human just needs to notice and either fix the plan or re-approve properly; this
      isn't a stalled-worker situation, so it doesn't consume watchdog retry budget or count as an
      escalation.

18. **Comment-driven re-pickup for `state:needs-input`** — resolves Review Finding #1 (a verified
    dead end: nothing ever transitions a ticket back to `state:plan`, so the planning-pass query
    alone can never rediscover a bounced ticket). Per your call: reply in the ticket, not a manual
    relabel. The headless planning pass runs a **second discovery query each tick**, alongside
    `state:plan` (decision #2): tickets in `state:needs-input`, same `jiraProjectKeys`/`appTag`
    scoping, where **the ticket's own comment thread shows an author reply after the automation's
    last comment** — no new local state needed, this is derived fresh from `issue.comments`
    (already returned by `fetchIssue`) on every check, the same stateless-search shape as
    `tracker_search` itself.
    - **Detection mechanism**: find the *last* comment carrying the automation's footer fingerprint
      (`src/footer.ts`'s `commentFooter` — note its exact text varies by calling client, e.g. "🤖
      _Posted by Claude via ai-intake-mcp_" vs. "🤖 _Posted by Gemini via ai-intake-mcp_", so match
      on the **stable substring** `"via ai-intake-mcp_"`, the same constant-portion-fingerprint
      approach the harness's `JIRA_AI_COMMENT_FOOTER` already uses for its own, structurally
      identical, watchdog stall-detection comment check). If any comment **after** that one lacks
      the fingerprint, treat it as an author reply — ready for re-pickup, dispatched through the
      exact same path as a `state:plan` match (create/resume the same worktree, re-run the headless
      planning prompt — `docs://planning-procedure` §2's existing "match → refine, don't
      regenerate" behavior already handles this being a re-pickup, not a fresh plan).
    - **Accepted tradeoff, not a bug**: this doesn't try to judge whether the reply actually
      *answers* the blocking question — any non-automation comment after the last automation
      comment triggers a re-pickup attempt. A tangential reply (e.g. a teammate's unrelated comment)
      would cause a wasted planning re-launch that just re-evaluates, finds the question still
      open, and bounces back to `needs-input` again with a fresh comment (and a fresh fingerprint
      to wait past). Self-correcting, just occasionally wasteful — not worth building stricter
      answer-detection for.
    - Bounce comments (decision #2's "has blocking questions" case) should say plainly "reply on
      this ticket with your answer(s) and automation will pick it back up" — the mechanism only
      works if the author actually knows to reply rather than, say, editing the ticket description
      instead.

19. **Cron-overlap guard — same mechanism as the harness.** Resolves Review Finding #2. One
    `flock -n` around the entire cron entrypoint, exactly like `intake-poll.sh`'s wrapper
    (`exec /usr/bin/flock -n .intake/poll.lock bash intake-poll.sh`) — a single lock file for the
    whole sequential sweep (decision #10), not one per project, since the sweep itself is one
    process making its way through every registered project in order. Lock file:
    `~/.config/ai-intake-mcp/state/automation.lock` (sibling to the per-project `workers/`
    directories under decision #8's state tree). `-n` (non-blocking) matches the harness's choice
    deliberately: if a previous run is still going when the next cron tick fires, the new
    invocation exits immediately rather than queuing — the same "skip this tick, the next one will
    catch up" behavior, not a pile-up of waiting cron processes.

20. **App-tag collision check on registration, live against Jira — resolves Review Finding #4 and
    decision #7's "still open" registration-validation question.** Your call: the check, not just a
    documented warning — "the easiest is user error, but I like the check." Before a new
    `projects.json` entry (decision #7) is written, query Jira for any ticket already carrying
    `labels = "app:<appTag>"` (the tag from the repo's own `.ai/intake-mcp.json`, decision #6/#7),
    then classify what's found:
    - **No tickets at all** → fresh tag, register freely.
    - **Tickets found, all carrying `ai-intake-mcp`'s own `state:*` vocabulary
      (`plan`/`needs-input`/`review`/`implement`/`working`/`verify`/`problem` — decision #2's
      earlier vocabulary correction) and all already pointing at *this same* repo path in
      `projects.json`** → this is just re-registering/updating an existing project, allow.
    - **Anything else — tickets found carrying a state label outside that vocabulary (a strong
      signal of the harness's own longer `jira-tags.sh` vocabulary, e.g.
      `state:ready-for-planning`), or found under a *different* repo path already in
      `projects.json`** → refuse registration with a clear error naming what was found (which
      ticket(s), which label), since this is exactly the double-dispatch risk Review Finding #4
      described: a separate `ai-intake-harness` install (or a misconfigured second entry in this
      same registry) already claiming that tag.
    - **Jira query fails (network/auth error)** → fail closed, refuse registration and ask to
      retry — don't silently skip the safety check just because the check itself couldn't run.

    **Sparked a related idea, worth building alongside this**: an interactive **registration
    wizard**, mirroring the harness's own `install.sh`, since this check needs a proper flow around
    it rather than a bare "edit `projects.json` by hand" instruction:
    1. Prompt for the repo path; verify it's a git repo.
    2. Read its `.ai/intake-mcp.json` for `jiraProjectKeys`/`appTag` (decision #6/#7 — reused, not
       re-asked; offer to run `write_repo_config` first if the file doesn't exist yet).
    3. Run this decision's collision check; refuse with the explanation above if it fails.
    4. Prompt for the few registry-level fields that actually need a human choice: display `name`
       (default: basename of the path), `worktreeRoot` (default: the sibling-directory convention
       from decision #7's schema) — skip prompting for the rest of the `overrides` bag by default
       (permission profile, concurrency cap, watchdog tuning); those stay hand-edited in
       `projects.json` for the uncommon case that needs them, not wizard-prompted every time.
    5. Write (or update) the entry in `projects.json`; idempotent on repo path, same as the
       harness's `install.sh` being safe to re-run.
    6. Final sanity check: confirm the Jira project key(s) are actually reachable (a live query, not
       just config validation) — same spirit as the harness's `install.sh --test-only`.

21. **Verification strategy — not addressed anywhere above until asked; a real gap, closed here.**
    Four layers, extending the existing suite rather than inventing a new approach:
    - **Unit tests (vitest, same pattern as the existing 18-file suite)** for everything that's
      pure logic or file I/O: the `tracker_search` JQL builder (#6), the comment-fingerprint
      re-pickup check (#18), marker read/write and the concurrency-cap checks (#5/#8), the watchdog
      stall/heartbeat/escalation logic (#12), progress-log parsing (#16), the new structural plan
      check `planHasImplementationOrderSection` (#17), `settings.json`/`projects.json` loading and
      override resolution (#7/#13), and the app-tag collision classification (#20). All of these
      follow the existing `test/tools/implement-ticket.test.ts` pattern exactly: real `git`
      operations against a `mkdtempSync` temp repo, mocked Jira `fetch` responses — no new testing
      infrastructure needed.
    - **Provider adapters (#14) are tested with `node:child_process` mocked (`vi.mock`), never a
      real `claude`/`gemini` CLI invocation.** A unit test asserts the adapter constructs the right
      command/args/env/permission-profile-path per provider and writes the running-slot marker with
      the right PID — it never actually runs an AI. Real headless CLI runs are slow, cost money, and
      are nondeterministic; none of that belongs in a test suite that runs on every commit.
    - **An integration test of the full per-project three-sub-pass loop (decision #10)** against a
      mocked Jira client (same fetch-stubbing approach) and a **fake provider adapter** — a
      trivial stub that immediately writes a canned result file (success / blocked / simulated
      stall) instead of spawning anything real. This is what actually exercises the interesting
      cross-decision behavior end-to-end: does the concurrency cap really skip a second
      implementation dispatch, does a simulated dead PID really get restarted and then escalated
      after 3 attempts, does the heartbeat comment really compose from progress-log entries, does
      Status really get promoted to `ready` on first implementation touch. This is new
      infrastructure this feature needs that the existing suite doesn't have yet (nothing today
      exercises multiple sequential passes over time) — the harness's own `test/integration/*.bats`
      suite (`dispatch_implementation.bats`, `watchdog.bats`) is the closest existing analog to
      port the *shape* of, not the bash itself.
    - **A `--dry-run` flag on the real cron entrypoint**, same as the harness's own
      `intake-poll.sh --dry-run` — runs the full loop against a **real** Jira board with real
      registered projects, but logs every action (dispatch, comment, transition) instead of taking
      it. This is the step between "unit/integration tests pass" and "trust this to run
      unattended": a human reviews what it *would* have done against real, current ticket data
      before ever flipping dry-run off. **Dogfooding candidate**: `ai-intake-mcp` already
      self-hosts on the shared DAV board (`app:ai-intake-mcp`, `.ai/intake-mcp.json`) — the natural
      first real registration to validate against, dry-run first, exactly the same self-hosting
      pattern the harness itself uses (`app:ai-intake-harness`).

22. **Verification is now a standing requirement of every plan this tool generates, not a
    per-feature afterthought — and this plan dogfoods it too.** Per your directive: "the
    verification should always be part of the plans... add that to the MCP... Think
    Test-Driven-Development." Two real, immediate edits made directly to the shipped tool as part of
    this design session (not deferred to "when this gets built"):
    - **`docs/planning-procedure.md`** (the `docs://planning-procedure` MCP resource — the exact
      document decision #15 already commits the future headless planning prompt to quoting
      verbatim, so this change automatically covers both interactive *and* future headless planning
      the moment it's written, with zero extra work) now requires a `## Testing strategy` section on
      every plan, same standing as `## Boundaries` — never optional, never added only when asked.
      Its content: every Implementation order step that changes behavior is split into a **test
      step** (write test(s) for the passing path and, where meaningful, the failure/error path,
      with an acceptance check that they **fail for the expected reason** against current code) and
      an **implementation step** (minimal code to satisfy them, acceptance check that they now
      **pass** plus the full existing suite still passes) — classic TDD red-green, made a structural
      requirement of the plan format itself, not just a testing philosophy someone might apply.
    - **`docs/implementation-procedure.md`** updated to match on the execution side: a test step's
      acceptance check is explicitly "fails, for the expected reason" (and if a "new" test passes
      immediately, that's a stop condition — it isn't testing anything yet), never collapsed into
      writing the implementation first because the change "seems obvious."
    - **This plan's own eventual Implementation Order will follow the same pairing** when it moves
      from `draft/` to `active/` and gets fleshed into literal steps — every new piece named in
      decision #21 (the JQL builder, the comment-fingerprint check, marker/concurrency logic, the
      watchdog, the provider adapters, the registration wizard's collision check, etc.) gets its
      test step and implementation step written as separate, ordered steps, not bundled. Decision
      #21's four verification layers describe *what* gets tested and *how* (unit/integration/dry-run);
      this decision is about *the order things get written in* — tests first, always.
    - **Structural enforcement, extending decision #17's pattern**: when `planHasImplementationOrderSection`
      (decision #17) gets built, add a sibling `planHasTestingStrategySection` alongside it, checked
      at the same two gates (`approve_plan`, and the headless planning pass before ever posting to
      Jira) — a plan missing `## Testing strategy` is treated exactly like one missing
      `## Boundaries` or `## Implementation Order`: never silently allowed through.

## Reused unchanged

`worktreeCreate` / `findWorktreeForTicket` / `worktreeRemove` (`src/worktree.ts`), plan-file helpers
(`src/plan-file.ts`), `fetchIssue` / `currentStateLabel` / `transitionState` / `addComment` /
`applyLabels` (`src/jira/tags.ts`), `loadGlobalConfig` (`src/config.ts`), the Jira client/auth
(token + cookie fallback), the per-repo `.ai/intake-mcp.json` format, the `make <target>` build
model from the implementation-phase plan, `docs://planning-procedure` §§1-4's "write for a weaker
executor" / plan-file-shape guidance (now load-bearing for cross-provider handoff, decision #2), the
harness's `lib/ai/<name>.sh` adapter *shape* and its `ai-plan-<profile>`/`ai-impl-<profile>` label
mechanism (conceptually ported to TS, decision #14 — not the bash itself).

## New work

- **`jiraProjectKeys` schema migration** (decision #6) — `RepoConfig`, `readRepoConfig`/
  `writeRepoConfig` (`src/repo-context.ts`), `tracker_get_issue`'s guardrail, and the
  `write_repo_config` tool's params all move from a single key to a list, with the singular field
  still read as backward compat.
- Ticket-discovery / `tracker_search` equivalent — nothing like this exists in `ai-intake-mcp` yet
  (today a ticket key is always given by the human); needs porting from `jira-tags.sh`'s JQL
  pattern, generalized to `project in (...)` across a repo's whole `jiraProjectKeys` collection
  (`project in ("K1","K2") AND labels = "app:Y" AND labels = "state:Z" AND assignee =
  currentUser() ORDER BY created ASC`) into `src/jira/`.
- **Comment-fingerprint re-pickup check** (decision #18) — the `state:needs-input` query plus the
  "author replied after our last comment" scan over `issue.comments`, matching on the stable
  `"via ai-intake-mcp_"` substring of `commentFooter`'s output.
- The result-file protocol for headless worker → orchestrator handoff (plan decision, impl
  outcome) — provider-neutral by construction (decision #1), since it's just a file any CLI can
  write.
- **The global project registry, its app-tag collision check, and the registration wizard**
  (decision #20) — the live Jira query + classification logic, and the interactive CLI flow around
  it (repo path → read `.ai/intake-mcp.json` → collision check → a few registry fields → write
  `projects.json` → live reachability check).
- **The AI provider adapter layer** (decision #14) — the TS `src/ai/<name>.ts` contract itself,
  plus **both** the Claude and Gemini implementations for v1 (not Claude-only); the per-phase/per-ticket
  `ai-plan-<profile>`/`ai-impl-<profile>` label resolution against `settings.json`'s `aiProfiles`;
  and, per decision #9, each provider's own permission-profile materialization: Claude via
  `--settings <path>` (no filesystem write needed — points straight at the global JSON file);
  Gemini via a one-time (not per-launch) write/sync of the global TOML file to
  `~/.gemini/policies/ai-intake-mcp-headless.toml` — NOT per-worktree, since Workspace-tier
  policies don't work in the installed CLI (0.58.0).
- **The two headless prompt documents** (decision #15) — `prompts/headless-planning.md` /
  `prompts/headless-implementation.md`, including the progress-log instruction (decision #16).
- **The progress-log reader + heartbeat composer** (decision #16) — read-position tracking on the
  running-slot marker, `Done`/`Next` parsing, the fallback path when nothing new was appended.
- Per-project running-slot marker + both concurrency checks (decision #5): implementation's fixed
  structural cap of 1, and planning's configurable global-default-plus-override cap.
- The cron entrypoint/wrapper itself, including the `flock -n` overlap guard (decision #19) and a
  `--dry-run` flag (decision #21).
- **The test suite itself** (decision #21): unit tests for every new pure-logic piece above, mocked
  `node:child_process` for the provider adapters, and a new integration-test harness (fake provider
  + mocked Jira client) that can actually simulate multiple sequential cron ticks — nothing in the
  existing suite does that yet.
- The watchdog pass (decision #12) — stall detection, restart-in-place with a retry budget,
  escalation comment once exhausted, plus heartbeat comments for still-alive workers.
- The global `settings.json` loader + per-project override resolution (decision #13).
- **`planHasImplementationOrderSection` and `planHasTestingStrategySection`** (decisions #17/#22)
  in `src/plan-file.ts`, wired into both `approve_plan` and the headless planning pass's
  post-processing; plus the headless implementation pass's own first-touch `Status: draft → ready`
  promotion (running the same checks) for Jira-approved-directly tickets. A shared-source headless
  planning prompt that quotes `docs://planning-procedure` §§1-4 verbatim rather than paraphrasing
  it — already carries the new `## Testing strategy` requirement for free (decision #22).

## Review findings (2026-09-03) — bugs, gaps, missing areas

A full pass over this document, cross-checked against the actual `ai-intake-mcp` and
`ai-intake-harness` source rather than re-reading the plan in isolation. Ranked roughly by
severity. Nothing here has been unilaterally decided — genuine judgment calls stay listed, not
resolved, pending discussion.

1. ~~No mechanism exists for headless automation to re-discover a ticket after `state:needs-input`
   is answered~~ — **resolved, see decision #18: comment-driven re-pickup** (reply in the ticket,
   your call — not a manual relabel). Original finding, kept for the record: verified via
   `src/jira/tags.ts`'s `TRANSITION_TARGETS` (excludes `"plan"`) and a repo-wide grep confirming no
   code anywhere transitions a ticket back to `state:plan` from `state:needs-input` — the
   interactive flow never hits this because `plan_ticket` is always given a ticket key directly and
   never searches by state.

2. ~~No cron-overlap guard mentioned anywhere~~ — **resolved, see decision #19**: same `flock -n`
   mechanism as the harness, one lock file for the whole sequential sweep.

3. ~~Decision #17's failure paths are unspecified~~ — **resolved, see decision #17's updated
   text**: a missing Implementation Order during headless planning is treated as a failed planning
   attempt (watchdog retry with an injected correction note, escalate on exhaustion — never routed
   to `needs-input`, since that's the ticket author's channel, not a worker mistake); a
   Status-promotion check failing at implementation time bounces back to `state:review` with an
   explanatory comment (not an escalation, not a watchdog retry — a human just needs to notice).

4. ~~Cross-system `app:<name>` tag collision~~ — **resolved, see decision #20**: a live check
   against Jira on registration (not just a documented warning — your call), covering both the
   cross-system case (an `ai-intake-harness` poller already on that tag) and the same-system case
   (two `projects.json` entries misconfigured with the same tag). Also produced decision #20's
   registration wizard.

5. ~~Decision #10 omits the watchdog pass~~ — **resolved, see decision #10's updated text**: one
   loop over the registry, three sub-passes per project (planning, implementation, watchdog) run
   back-to-back before moving to the next project — not a separate whole-registry watchdog sweep.

6. ~~Watchdog timing was tuned for implementation, now also governs planning by default~~ —
   **resolved, see decisions #12/#13**: planning gets its own, tighter defaults — 10 min grace /
   5 min heartbeat, vs. implementation's 30 min / 25 min — same 3-attempt retry budget for both.
   `settings.json`'s `watchdog` key is now nested per phase; the per-project `overrides` bag
   follows the same shape.

7. **[Low] Decision #16's progress-log checkpoint for planning is vaguer than implementation's.**
   Implementation has a clean, structural anchor (a step of the plan's Implementation Order);
   planning's "a natural checkpoint (e.g. finished reading the ticket/codebase, drafted a first
   pass...)" is a soft suggestion, not something the headless planning prompt can point at
   concretely yet. Not wrong, just needs tightening once that prompt is actually drafted (decision
   #15).

8. **[Low] Unspecified: what happens when a registered project is disabled (`enabled: false`,
   decision #7) while it has an active marker/worker running?** Presumably it should just stop new
   dispatch and let any in-flight worker finish (watchdog still sweeps it), not force-kill anything
   — but the plan doesn't say so explicitly.

9. **[Low] Unspecified: `worktreeCreate` failing outright** (git error, disk full, permission
   denied) before any marker/PID exists at all. The harness has a specific one-shot escalation path
   for exactly this (`dispatch_escalate_once`, worktree-provisioning failures) — this plan doesn't
   yet say what the orchestrator does if worktree creation itself fails before decision #8's marker
   can even be written.

## Open questions

- ~~Registry file schema~~ — **resolved**, see decision #7: `path`/`name`/`enabled`/`overrides`,
  the latter an open, additive bag. Registration validation also resolved — see decision #20's
  app-tag collision check and registration wizard.
- ~~Watchdog specifics~~ — **resolved**, see decisions #12/#13: 30 min grace, 3 max attempts,
  25 min heartbeat for alive workers, all living in a new global `settings.json` with per-project
  overrides.
- ~~Whether the watchdog/heartbeat sweep should also cover planning~~ — **resolved: yes.** Decision
  #12 now sweeps every marker file regardless of phase (found there's no state-label signal to
  scope it by anyway); decisions #8/#16 updated to a uniform per-ticket marker scheme and
  progress-log convention covering both phases.
- ~~Heartbeat content~~ — **resolved**, see decisions #12/#16: a worker-maintained progress log
  (`Done`/`Next` entries), read since the last position, composed into the comment; falls back to
  restating the last `Next` line if nothing new landed.
- ~~AI-provider assumption~~ — **resolved**, see decisions #14/#15: pluggable provider adapter
  layer (Claude default, Gemini also shipped for v1 — see below), per-phase and per-ticket
  selectable via labels, with its own provider-neutral headless prompts rather than reusing the
  interactive MCP-resource docs verbatim.
- ~~Whether planning concurrency truly needs no cap~~ — **resolved: it needs one**, see decision
  #5. Global default (`settings.json`'s `concurrency.planning`, proposed 3) plus a per-project
  override — the same global-default-plus-override shape as permissions (#9) and watchdog timing
  (#13). Implementation's cap stays a fixed, non-configurable 1 (a physical constraint per decision
  #4, not a policy choice) — only planning got a real tunable cap.
- ~~Permission profile authoring~~ — **resolved: one global profile for all projects**, per
  decision #9. Per-provider shape (Claude JSON via `--settings`, Gemini TOML via
  `~/.gemini/policies/`), declared in `settings.json` (#13); a project can still override Claude's
  path individually if it truly needs to, but not Gemini's (machine-global by tier, until
  gemini-cli issue #18186 is fixed upstream).
- ~~Whether/how a project opts into headless automation explicitly~~ — **resolved: registration
  alone is the opt-in, no new repo-level flag.** This was already implicit in decisions #7/#20 but
  never stated as the answer: a repo having `.ai/intake-mcp.json` (committed, shared with
  teammates) is necessary for interactive use but never sufficient for headless automation — a
  repo is only ever touched by it if someone explicitly runs the registration wizard (#20) on
  *their own* machine, adding it to *that machine's* `projects.json` (which lives outside the repo
  entirely, in `~/.config/ai-intake-mcp/`). A teammate with `ai-intake-mcp` installed for their own
  interactive use never risks headless automation kicking in against a shared repo just because the
  file exists — nothing runs unattended unless a cron is also installed and that repo explicitly
  registered on it. Considered and declined: a repo-level opt-out flag (e.g.
  `"headlessAutomation": false` in `.ai/intake-mcp.json`) that the wizard would refuse to override
  — your call was that explicit registration is already enough, keep it simple.
- ~~Whether `appTag` should also become a collection alongside `jiraProjectKeys`~~ — **resolved:
  no, confirmed singular** (decision #6) — uniqueness enforced separately by decision #20's
  registration-time collision check, not by allowing multiple tags.
- ~~Whether every provider in the harness's `lib/ai/*.sh` set needs a headless TS adapter for
  v1~~ — **resolved: Claude and Gemini both ship for v1** (decision #14); Codex, Antigravity, and
  local-LLM stay contract-supported but deferred, added on demand later.
