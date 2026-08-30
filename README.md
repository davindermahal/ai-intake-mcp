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

## Design

See [`.ai/plans/active/ai-intake-mcp-on-demand-planning.md`](.ai/plans/active/ai-intake-mcp-on-demand-planning.md)
(planning phase) and [`.ai/plans/active/ai-intake-mcp-implementation-phase.md`](.ai/plans/active/ai-intake-mcp-implementation-phase.md)
(implementation phase) for the full design records, and [`.ai/README.md`](.ai/README.md) for how
this project's `.ai/` directory is organized.

## Setup

```bash
git clone https://github.com/davindermahal/ai-intake-mcp ~/dev/ai-intake-mcp
cd ~/dev/ai-intake-mcp && ./install.sh
```

See [`docs/setup.md`](docs/setup.md) for what that does and does not automate (Jira credentials
still need to be filled in by hand).

## License

No license is granted. This repository is public for visibility only — all rights are reserved,
and no reuse, modification, or redistribution rights are granted to third parties.
