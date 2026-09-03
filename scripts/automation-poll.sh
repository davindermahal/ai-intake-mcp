#!/bin/sh
# Cron-overlap guard (decision #19) — same mechanism as ai-intake-harness's intake-poll.sh wrapper:
# `flock -n` around the whole sequential sweep. If a previous tick is still running when the next
# cron invocation fires, this exits immediately (non-zero) rather than queuing or running twice.
#
# Install via cron, e.g. every 2 minutes (matches the harness's own cadence — needs to be at least
# as fine as the smaller of the two watchdog heartbeat intervals, decision #12):
#   */2 * * * * /path/to/ai-intake-mcp/scripts/automation-poll.sh
set -eu

# cron's own PATH is minimal (commonly just "/usr/bin:/bin") and doesn't include wherever
# claude/gemini are actually installed (typically ~/.local/bin per their own install docs) —
# confirmed live during headless-automation-qa.md's Phase I soak test: the very first real cron
# tick failed with "spawn claude ENOENT" despite `claude` working fine interactively. Prepending
# these common install locations, rather than requiring every consumer to discover and work around
# this themselves (e.g. via a custom cron wrapper, ai-intake-harness's approach), keeps this script
# usable as-is, exactly as docs/headless-automation.md's install instructions assume.
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK_PATH="${HOME}/.config/ai-intake-mcp/state/automation.lock"
mkdir -p "$(dirname "$LOCK_PATH")"

# `node --import tsx` resolves "tsx" as an ordinary package import — relative to the process's cwd
# (or the nearest package.json above it), not the script file's own location. cron invokes this
# script with cwd=$HOME (or whatever it defaults to), which has no node_modules/tsx anywhere above
# it, so the bare "node --import tsx ..." used here previously failed with ERR_MODULE_NOT_FOUND on
# every real cron tick despite working fine when run manually from inside the project directory
# (confirmed live during headless-automation-qa.md's Phase I soak test — this is exactly the kind of
# gap that phase exists to catch). cd into the project root first so resolution always succeeds
# regardless of the invoking cwd.
cd "$SCRIPT_DIR/.."

exec flock -n "$LOCK_PATH" node --import tsx "$SCRIPT_DIR/automation-poll.ts" "$@"
