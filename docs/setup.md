# Setup

One-time, per-developer setup. Nothing here is per-project — you do this once regardless of how many
repos you plan a ticket in. For the day-to-day workflow once this is done, see
[`usage.md`](usage.md). Once you also want unattended, on-a-cron automation across registered repos
instead of (or alongside) driving this interactively, see
[`headless-automation.md`](headless-automation.md) — a separate mode, validated end to end against a
real Jira board (see that doc's own status line for details).

## The fast path

```bash
git clone https://github.com/davindermahal/ai-intake-mcp ~/dev/ai-intake-mcp
cd ~/dev/ai-intake-mcp
./install.sh
```

`install.sh` builds the project, registers the server with whichever of Claude Code/Gemini CLI it
finds on your `PATH` (skipping either that isn't installed), and creates
`~/.config/ai-intake-mcp/.env` from a placeholder template if one doesn't already exist. It stops
there and tells you to fill that file in with real Jira credentials, then re-run `./install.sh` —
the second run skips everything already done and just verifies (`npm run health-check`). Safe to
re-run any time: nothing it does is destructive, and an existing `.env` is never overwritten.

`make setup` does the same thing, if you'd rather type that.

The rest of this doc explains what each of those steps actually does and why, plus the pieces
`install.sh` doesn't cover (permission settings). Read on if something goes wrong, you're on a
platform it doesn't handle well, or you're just curious.

## 1. Clone and build

During the experimental phase this points at a local git clone, not a published npm package
(decision #1 in the plan doc). `install.sh` does this build step for you; by hand:

```bash
cd ~/dev/ai-intake-mcp && npm install && npm run build
```

To pick up updates later: `git pull && ./install.sh` in that same clone.

**Rebuilding isn't enough on its own for a session that's already running.** `ai-intake-mcp` is a
local stdio process — once your agent CLI has spawned it, that process keeps running the code it
started with; Node doesn't hot-reload, and re-running `claude mcp add`/`gemini mcp add` only rewrites
the *registration*, it doesn't kill/restart an already-connected server (confirmed empirically: a
rebuild mid-session left the live tools running the old code until the connection was explicitly
reconnected). A **new** session started after `git pull && ./install.sh` picks up the update
automatically, since it spawns a fresh process — but any session you already have open needs its
`ai-intake-mcp` MCP connection reconnected (or the session restarted) before it reflects the update.

## 2. Register the server at user scope

Register once, not per-project — a local stdio MCP server inherits the cwd of whatever agent CLI
spawned it, so the same registration works from any repo you open your agent in (decision #1).
`install.sh` does this for you, detecting which CLI(s) you have installed; by hand:

```bash
claude mcp add --scope user ai-intake -- node ~/dev/ai-intake-mcp/dist/index.js
gemini mcp add --scope user ai-intake node ~/dev/ai-intake-mcp/dist/index.js
```

## 3. Set up Jira credentials

Credentials are global, not per-project (decision #8) — one file, `~/.config/ai-intake-mcp/.env`.
`install.sh` creates this from [`.env.example`](../.env.example) for you (never overwriting one that
already exists); by hand:

```bash
mkdir -p ~/.config/ai-intake-mcp
cp .env.example ~/.config/ai-intake-mcp/.env
chmod 600 ~/.config/ai-intake-mcp/.env
```

Then edit it in with real values. Get a token from
https://id.atlassian.com/manage-profile/security/api-tokens.

**No token available** (blocked by org policy)? Leave `JIRA_INTAKE_API_TOKEN` unset instead — the
server falls back to extracting a session cookie from a locally logged-in browser (decision #9). v1
supports **Chrome/Chromium on Linux only**; requires a live, unlocked desktop session with the OS
keyring (libsecret/GNOME Keyring) available, and you logged into Jira in that browser. A fresh cookie
is extracted on every call, never cached to disk.

Optional overrides, only needed if your board's native status names differ from the defaults —
already commented out in `.env.example`:

```
TRACKER_NATIVE_STATUS_IN_PROGRESS=In Progress
TRACKER_NATIVE_STATUS_CODE_REVIEW=Code Review
JIRA_COOKIE_BROWSER=chrome
```

## 4. Verify

`install.sh` runs this for you as its last step (`npm run health-check`); by hand, from inside the
repo:

```bash
npm run health-check
```

Or, from inside any git repo, ask your agent to call the `health_check` MCP tool directly. Either
way it confirms credentials load, the Jira site is reachable, and the configured in-progress native
status exists on the board.

## 5. Plan a ticket

The first time you plan a ticket in a given repo, you'll be asked once for that repo's Jira project
key and app tag (auto-bootstraps `.ai/intake-mcp.json`, decision #4) — never asked again after that.

Invocation syntax differs by client (decision #6):

- **Gemini CLI** (bare prompt name, no server prefix): `/plan_ticket DAV-4`
- **Claude Code** (always server-prefixed): `/mcp__ai-intake__plan_ticket DAV-4`

## 6. Approve and implement a ticket

Once a plan is written and moved to `state:review`, a human reviews it and calls `approve_plan`
(e.g. "approve DAV-4's plan") — this is the explicit approval action; nothing auto-approves. Then,
same invocation pattern as planning:

- **Gemini CLI**: `/implement_ticket DAV-4`
- **Claude Code**: `/mcp__ai-intake__implement_ticket DAV-4`

This resumes the ticket's existing worktree (created during planning), confirms the plan is
approved, and follows `docs://implementation-procedure` — reading `.ai/intake-mcp.md` for this
project's `make` targets (asking once and writing the file if it doesn't exist yet), implementing,
running `make build`/`test`/`lint` as applicable, committing locally, and reporting back. It never
pushes, merges, or deploys — that stays a manual step for you.

## 7. Recommended permission settings (optional)

The tool surface is narrow by construction (decision #11) — each tool does exactly one fixed,
bounded thing, and every state-changing write is additionally gated server-side against Jira
itself. It's reasonable to allow-list the whole surface for that reason, but this is opt-in per
developer, not enforced. `worktree_remove` is excluded — it's the one genuinely destructive tool in
the surface and should still prompt for confirmation:

```json
{
  "permissions": {
    "allow": [
      "mcp__ai-intake__health_check",
      "mcp__ai-intake__tracker_get_issue",
      "mcp__ai-intake__tracker_add_comment",
      "mcp__ai-intake__tracker_transition",
      "mcp__ai-intake__worktree_create",
      "mcp__ai-intake__write_repo_config",
      "mcp__ai-intake__approve_plan",
      "mcp__ai-intake__implement_ticket"
    ]
  }
}
```

**Implementation sessions grant the agent full shell/`Edit` access** (unlike planning, which only
ever needs the MCP tools above). `git push` and a local non-fast-forward `git merge` are blocked
automatically — `worktree_create` installs a `pre-push`/`pre-merge-commit` guard scoped to that one
worktree (hardening-phase plan, decision #1), so there's nothing to configure here yourself, and it
works the same regardless of which agent CLI is driving. Two things it still can't reach: a
**fast-forward** local merge (no merge commit is created, so the hook never fires) and a
**remote-side** merge (`gh pr merge`, the GitHub UI) — neither is a local git operation any hook can
intercept. Those stay a manual discipline, same as always.
