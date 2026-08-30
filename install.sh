#!/bin/bash
# One-time developer setup for ai-intake-mcp. See docs/setup.md for what each step does and why.
#
# Runs on the HOST, not in Docker: the compiled server must run as a plain `node` process so it
# inherits the calling agent CLI's cwd (see the plan doc's "Development environment" — decision #1)
# — a container can't do that. The Makefile's Docker-wrapped targets are a contributor build/test
# convenience; this script is the actual install path.
#
# Safe to re-run: registration is skipped if already present, and an existing
# ~/.config/ai-intake-mcp/.env is never overwritten.
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.config/ai-intake-mcp"
ENV_FILE="$CONFIG_DIR/.env"

echo "==> Installing dependencies and building..."
( cd "$REPO_ROOT" && npm install && npm run build )

echo ""
echo "==> Registering the MCP server..."
if command -v claude >/dev/null 2>&1; then
    if claude mcp list 2>/dev/null | grep -q "^ai-intake"; then
        echo "    claude: already registered, skipping"
    else
        claude mcp add --scope user ai-intake -- node "$REPO_ROOT/dist/index.js"
        echo "    claude: registered"
    fi
else
    echo "    claude CLI not found on PATH, skipping"
fi

if command -v gemini >/dev/null 2>&1; then
    if gemini mcp list 2>&1 | grep -q "ai-intake:"; then
        echo "    gemini: already registered, skipping"
    else
        gemini mcp add --scope user ai-intake node "$REPO_ROOT/dist/index.js"
        echo "    gemini: registered"
    fi

    # Gemini CLI gates MCP servers (even user-scope ones) behind a per-folder trust setting: the
    # first time you run `gemini` from a directory it hasn't seen, it prompts to trust that folder
    # before enabling any MCP servers there. Deliberately NOT automated here — that prompt is a
    # real review point, and this script only knows about $REPO_ROOT anyway; every other project
    # repo you use ai-intake-mcp from needs its own trust decision the same way. Accept it when
    # asked, or run `gemini` once in a given repo ahead of time.
else
    echo "    gemini CLI not found on PATH, skipping"
fi

echo ""
echo "==> Setting up credentials..."
mkdir -p "$CONFIG_DIR"
if [ -f "$ENV_FILE" ]; then
    echo "    $ENV_FILE already exists — leaving it alone"
else
    cp "$REPO_ROOT/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "    Created $ENV_FILE with placeholder values — edit it, then re-run ./install.sh to verify."
fi

echo ""
echo "==> Verifying..."
if ( cd "$REPO_ROOT" && npm run --silent health-check ); then
    echo ""
    echo "Done. See docs/usage.md for how to actually use it."
else
    echo ""
    echo "Setup finished, but the health check above failed — fix $ENV_FILE and re-run ./install.sh."
    exit 1
fi
