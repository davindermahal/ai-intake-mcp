# Development commands. Every Node-related command runs inside the image built from ./Dockerfile,
# using its pinned Node 24 (.ai/plans/active/ai-intake-mcp-on-demand-planning.md, "Repo" and
# "Development environment") — the host machine never needs Node installed to develop this project.
# The repo is bind-mounted into the container, so installs/builds write straight back to the
# checked-out source (node_modules, dist, package-lock.json) as they normally would.
#
# `install`/`update`/`build`/`test`/`lint` need package.json, which doesn't exist until Phase 1
# scaffolds the TS project — until then only `image` and `shell` will work.

IMAGE := ai-intake-mcp-dev
RUN   := docker run --rm -v "$(CURDIR)":/workspace -w /workspace $(IMAGE)

.PHONY: image install update build test lint setup shell clean

image: # Build the dev Docker image (Node 24 + git).
	docker build -t $(IMAGE) .

setup: # One-time developer install: runs ./install.sh directly on the HOST, not in Docker — the
       # registered server must run as a plain `node` process (see install.sh's header comment).
	./install.sh

install: image # npm install, run inside the container.
	$(RUN) npm install

update: image # npm update, run inside the container.
	$(RUN) npm update

build: image # npm run build (TypeScript compile), run inside the container.
	$(RUN) npm run build

test: image # npm test, run inside the container.
	$(RUN) npm test

lint: image # npm run lint, run inside the container.
	$(RUN) npm run lint

shell: image # Interactive shell inside the container, repo mounted at /workspace.
	docker run --rm -it -v "$(CURDIR)":/workspace -w /workspace $(IMAGE) bash

clean: # Remove the dev Docker image.
	docker image rm $(IMAGE) 2>/dev/null || true
