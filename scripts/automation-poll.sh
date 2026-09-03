#!/bin/sh
# Cron-overlap guard (decision #19) — same mechanism as ai-intake-harness's intake-poll.sh wrapper:
# `flock -n` around the whole sequential sweep. If a previous tick is still running when the next
# cron invocation fires, this exits immediately (non-zero) rather than queuing or running twice.
#
# Install via cron, e.g. every 2 minutes (matches the harness's own cadence — needs to be at least
# as fine as the smaller of the two watchdog heartbeat intervals, decision #12):
#   */2 * * * * /path/to/ai-intake-mcp/scripts/automation-poll.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK_PATH="${HOME}/.config/ai-intake-mcp/state/automation.lock"
mkdir -p "$(dirname "$LOCK_PATH")"

exec flock -n "$LOCK_PATH" node --import tsx "$SCRIPT_DIR/automation-poll.ts" "$@"
