# ai-intake-mcp

On-demand ticket planning **and implementation** via an MCP server: a developer, working inside a
project repo with an MCP-capable agent CLI already open, names a ticket and gets the same
plan-then-build pipeline a tracker automation would otherwise run — no cron, no per-project install.

**Status: experimental, feature-complete through implementation, validated end to end against a
real Jira board.** Interfaces, tool names, and configuration formats may still change without
notice.

## What it does

A developer runs a command like `/plan_ticket DAV-4`, reviews the plan it writes, approves it, then
runs `/implement_ticket DAV-4` — the same plan-then-build pipeline a tracker automation would
otherwise run, entirely on demand, no cron, nothing installed in the project beyond the plan output
and two small config files.

**See [`docs/usage.md`](docs/usage.md) for the full walkthrough** — what each step actually does,
what you'll see, and what to do at each point. It's written for using the tool, not for the
internals.

## Headless automation

The same pipeline can also run unattended, on a cron, across one or more registered repos — no
developer present. Fully implemented and validated end to end against a real Jira board, including a
24.5h unattended cron soak (sign-off: **GO**, see
[`.ai/plans/completed/headless-automation-qa.md`](.ai/plans/completed/headless-automation-qa.md)).
**See [`docs/headless-automation.md`](docs/headless-automation.md)** for the step-by-step path to try
it yourself (dry-run first, then one manual run, then cron) — still start against a throwaway
repo/board, the same way the validation above did, before pointing it at anything real.

## Design

See [`.ai/plans/active/ai-intake-mcp-on-demand-planning.md`](.ai/plans/active/ai-intake-mcp-on-demand-planning.md)
(planning phase), [`.ai/plans/active/ai-intake-mcp-implementation-phase.md`](.ai/plans/active/ai-intake-mcp-implementation-phase.md)
(implementation phase), and [`.ai/plans/completed/headless-automation.md`](.ai/plans/completed/headless-automation.md)
(headless automation) for the full design records, and [`.ai/README.md`](.ai/README.md) for how
this project's `.ai/` directory is organized.

## Setup

### Option A — install directly, no cloning

Register the server straight from GitHub — `npx` fetches the repo and builds it on first launch, no
local clone or `dist/` to keep up to date by hand. Requires Node >=24 on the `PATH` of whatever spawns
the command below (a version manager like `nvm` is fine, as long as it resolves before the client
starts the server).

**Claude Code:**

```bash
claude mcp add --scope user ai-intake -- npx -y github:davindermahal/ai-intake-mcp
```

**Gemini CLI:**

```bash
gemini mcp add --scope user ai-intake npx -y github:davindermahal/ai-intake-mcp
```

Or add it directly to an MCP settings file (Claude Desktop's `claude_desktop_config.json`, or any
other client that reads the same `mcpServers` shape):

```json
{
  "mcpServers": {
    "ai-intake": {
      "command": "npx",
      "args": ["-y", "github:davindermahal/ai-intake-mcp"]
    }
  }
}
```

You still need Jira credentials at `~/.config/ai-intake-mcp/.env` — this path skips `install.sh`, so
create it by hand:

```bash
mkdir -p ~/.config/ai-intake-mcp
cat > ~/.config/ai-intake-mcp/.env <<'EOF'
JIRA_SITE_URL=https://your-site.atlassian.net
JIRA_INTAKE_EMAIL=you@your-domain.com
JIRA_INTAKE_API_TOKEN=your-api-token-here
EOF
chmod 600 ~/.config/ai-intake-mcp/.env
```

(No API token available? Leave `JIRA_INTAKE_API_TOKEN` unset instead — see
[`docs/setup.md`](docs/setup.md#3-set-up-jira-credentials) for the browser-cookie fallback.) Then
verify with `npm run health-check` from any clone, or by asking your agent to call the `health_check`
MCP tool directly.

`npx` caches its first build of the repo and reuses it on later launches; to pick up a real update
later, clear that cache (`rm -rf ~/.npm/_npx`) so the next launch re-fetches and rebuilds.

### Option B — clone and install

```bash
git clone https://github.com/davindermahal/ai-intake-mcp ~/dev/ai-intake-mcp
cd ~/dev/ai-intake-mcp && ./install.sh
```

See [`docs/setup.md`](docs/setup.md) for what that does and does not automate (Jira credentials
still need to be filled in by hand), and for the full walk-through either way.

## License

No license is granted. This repository is public for visibility only — all rights are reserved,
and no reuse, modification, or redistribution rights are granted to third parties.
