# System

## What this project is

An MCP server (Node 24/TypeScript, `@modelcontextprotocol/sdk`) that lets a developer plan **and
implement** an issue-tracker ticket on demand: sitting inside their own project repo with an
MCP-capable agent CLI already open, they name a ticket (e.g. `/plan_ticket DAV-4`) and the server +
agent together fetch the ticket, create or resume a git worktree for it, and guide the agent through
authoring a plan file and updating the ticket's state. Once a human approves the plan, the same
model extends to implementation: `/implement_ticket DAV-4` resumes that worktree, runs the project's
own `make` targets, commits locally, and reports back — no cron, no per-project install beyond a
tiny bit of config.

Full design records: `.ai/plans/active/ai-intake-mcp-on-demand-planning.md` (planning phase, v1) and
`.ai/plans/active/ai-intake-mcp-implementation-phase.md` (implementation phase, extends v1). This
file is a condensed reference, not a replacement for either.

## Core design decisions (condensed — see the plan docs for full rationale)

- **cwd = project context.** The server is registered once per developer at user scope; it
  resolves which repo it's operating on from the calling agent's working directory
  (`git rev-parse --show-toplevel`), confirmed empirically to work regardless of which
  subdirectory the agent was opened in.
- **No queue search.** The developer already names the exact ticket; there is no "discover what's
  ready" step.
- **Tracker mode: `jira-tags` only.** A shared Jira board, scoped per repo by an `app:<tag>` label,
  with the abstract workflow state carried as a `state:<step>` label (this project's own shortened
  vocabulary — see below) rather than the tracker's native status field.
- **One small, committed per-repo config file** (`.ai/intake-mcp.json`: `jiraProjectKey` + `appTag`)
  resolves which tracker project/tag applies to a given repo — auto-bootstrapped on first use, no
  separate install command. A second, optional, free-prose file (`.ai/intake-mcp.md`) carries
  whatever implementation-specific context doesn't fit a schema (which `make` targets this repo
  defines, dev-setup quirks) — read by the agent, not parsed, no dedicated tool writes it.
- **Worktree creation is a tool** (`worktree_create`), not a doc instruction — pure `git worktree
  add`. **No container/database is ever created or managed by this server, in any phase** —
  implementation commands run through a fixed `make install`/`build`/`test`/`lint`/`exec` target
  convention, invoked from inside the worktree; what a target does internally (an ephemeral
  container-per-command like this repo's own Dockerfile/Makefile, or exec-ing into one persistent
  dev container) is entirely the consumer project's own business.
- **Docs and starter prompts are served over MCP itself** (`resources/list`+`read`,
  `prompts/list`+`get`) — nothing is copied into the consumer project.
- **Credentials are global** (one file per developer machine, not per repo); auth mode (API token
  vs. browser-cookie fallback) is internal to the Jira client, invisible to the agent.
- **Sandboxing is mostly a property of the tools' own narrow implementation** — each tool does
  exactly one fixed, bounded thing (no arbitrary shell, no arbitrary Jira API access), so safety is
  uniform across developers regardless of their client's own permission settings. This holds fully
  for planning; implementation work necessarily grants the agent real `Edit`/`Bash` access. `git
  push` and a local non-fast-forward `git merge` are blocked anyway — `worktree_create` installs a
  `pre-push`/`pre-merge-commit` guard scoped to that one worktree (hardening-phase plan, decision
  #1) — but a fast-forward local merge and any remote-side merge (`gh pr merge`, the GitHub UI)
  remain outside what a local git hook can reach, an accepted, permanent gap.
- **Approval is a single, atomic action.** `approve_plan` is the only way a ticket reaches
  `state:implement` — it transitions Jira (gated on `state:review`) *then* flips the plan file's
  `Status` to `ready`, in that order, so a failed Jira call never leaves a plan file claiming an
  approval Jira never recorded. `tracker_transition` itself refuses `"implement"` as a raw target.

## `state:*` label vocabulary

| Label | Meaning | `tracker_transition` target? |
|---|---|---|
| `state:plan` | Ticket has entered the pipeline; not yet worked | No — bootstrap-only |
| `state:needs-input` | Waiting on the ticket author to answer a *planning* question | Yes |
| `state:review` | Plan written, awaiting human approval | Yes |
| `state:implement` | Human approved the plan | **No** — reachable only via `approve_plan` |
| `state:working` | Implementation session started | Yes — set automatically by `implement_ticket` |
| `state:verify` | Implementation complete, declared `make` targets passed, committed locally | Yes — set automatically on success |
| `state:problem` | Implementation blocked — a failure or a needed decision (distinct from `needs-input`, which specifically means "the author" needs to answer something) | Yes — set automatically on a blocked run |
| `state:done` | Finished (merged) | No tool here ever sets it — a later, human/merge-time step |

## Tool surface

- `tracker_get_issue(key)`, `tracker_add_comment(key, text)`, `tracker_transition(key, state)`
- `worktree_create(ticket_key)`, `worktree_remove(ticket_key, { force?, keep_branch? })`
- `write_repo_config(jiraProjectKey, appTag)`
- `approve_plan(ticket_key)` — the only path to `state:implement`
- `implement_ticket(ticket_key)` — resolves/resumes the worktree, confirms the approval gate,
  transitions to `state:working`; the actual implementation is driven by the agent following
  `docs://implementation-procedure` afterward, not by this tool's return value
- `health_check()`

## Non-goals

- Plain `jira` (single-project, native-status-driven) tracker mode — nothing needs it yet.
- `state:done` and anything past it (merge, deploy, closing the ticket) — a later, human step.
- Enforced (code-level) prevention of `git push`/merge during an implementation session — no
  tool-level containment is possible once an agent has real shell access; procedure-doc guidance and
  an opt-in settings snippet only.
- Any change to `ai-intake-harness` — that project's cron+poller continues running unchanged.
