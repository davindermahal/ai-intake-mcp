# Development environment only — not a deployment artifact.
#
# ai-intake-mcp must run as a local `node` process spawned directly by the developer's agent CLI
# so it inherits that CLI's working directory (see .ai/plans/active/ai-intake-mcp-on-demand-planning.md,
# decision #1). A containerized server would only see this container's filesystem, breaking that
# cwd -> project-root resolution. This image exists to give contributors an `npm install` /
# `npm run build` / `npm test` environment on a pinned Node version, independent of the host.
#
# No source is baked in: the Makefile (see repo root) bind-mounts the repo into the container at
# run time for every command, so this image builds successfully even before package.json exists
# and never goes stale relative to the checked-out source.

FROM node:24-bookworm

# git is required at runtime by worktree_create (git worktree add) and by the server's own
# repo-root resolution (git rev-parse --show-toplevel), so tests exercising that logic need it too.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["bash"]
