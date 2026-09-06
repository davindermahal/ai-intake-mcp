# Plan (draft): `ai-intake-mcp` — migrate to `@modelcontextprotocol/server` v2 and add HTTP transport

**Status**: draft
**Created**: 2026-09-06
**Updated**: 2026-09-06
**Related**: `src/index.ts` (`main()`, transport wiring), `package.json` (`@modelcontextprotocol/sdk`
dependency, `zod` pin), the sibling plan in `ai-intake-documentation-mcp`'s own
`.ai/plans/draft/2026-09-06-add-optional-http-transport-default-stdio.md` (same HTTP contract,
written alongside this one — that repo needs no SDK migration, already on v2)

## Motivation

Two separate but related problems converged into one plan:

1. **This package is on the deprecated v1 SDK** (`@modelcontextprotocol/sdk`), while
   `ai-intake-documentation-mcp` is already on the current v2 package
   (`@modelcontextprotocol/server`). Different SDK majors across the two sibling servers is worth
   closing — same protocol, same ecosystem, no reason for them to diverge.
2. **Teammates without `gemini-sandbox-toolkit` have no easy way to run this server.** Today it's
   stdio-only, which means every client spawns its own local process — and hits the exact trap
   `gemini-sandbox-toolkit` had to work around: the package requires Node >=24, `better-sqlite3`/
   `keytar` need native compilation (no Node 24 prebuilt binaries exist yet, checked directly
   against `better-sqlite3`'s GitHub releases), and none of that is obvious from a generic
   "Connection closed" MCP error. An HTTP transport lets a teammate run **one** long-lived local
   instance (paying that setup cost once) and point any client at a URL instead.

Default behavior must not change: stdio stays the default transport. HTTP is opt-in.

## Part 1: v1 → v2 SDK migration

Use the official codemod rather than a hand rewrite:

```bash
npx @modelcontextprotocol/codemod@latest v1-to-v2 .
grep -rn '@mcp-codemod-error' .   # anything it couldn't safely rewrite -- handle by hand
tsc --noEmit
npm test
```

**Why this should be small for this codebase specifically:** `src/index.ts` already uses the
modern `server.registerTool()` / `registerResource()` / `registerPrompt()` config-object API, not
the removed v1 variadic `.tool()` / `.resource()` / `.prompt()` forms. So the codemod's job is
mostly mechanical import-path rewriting:
- `@modelcontextprotocol/sdk/server/mcp.js` → `@modelcontextprotocol/server`
- `@modelcontextprotocol/sdk/server/stdio.js` → `@modelcontextprotocol/server/stdio`
- `@modelcontextprotocol/sdk/types.js` → split between `@modelcontextprotocol/core` (schema
  constants) and whichever package a given file already imports

### The one real risk: zod

`package.json` currently pins `"zod": "^3.24.1"`. v2 **requires zod >=4.2.0** — and the failure
mode if this is missed is not a build error. It typechecks and starts cleanly; schema conversion
fails silently at registration, and the *first* `tools/list` call comes back with a
`fromJsonSchema()` error while the process keeps running. This needs to be a deliberate,
separately-verified step:

1. Bump `zod` to `^4.2.0`.
2. Actually call `tools/list` against the migrated server (not just `tsc --noEmit`) and confirm
   every tool still describes itself correctly — this is the step that catches what typechecking
   won't.
3. Spot-check a couple of tool calls that exercise `z.string()`/`z.enum()`/`z.array()` inputs
   (`tracker_transition`'s `state` enum and `write_repo_config`'s `jira_project_keys` array are
   good candidates) since Zod v3→v4 has its own behavioral surface beyond the MCP SDK's own
   requirements.

### Dependency changes

- Remove: `@modelcontextprotocol/sdk`
- Add: `@modelcontextprotocol/server`, `@modelcontextprotocol/node` (HTTP adapter, see Part 2)
- Bump: `zod` `^3.24.1` → `^4.2.0`
- Unaffected: `better-sqlite3`, `keytar` — unrelated to the MCP SDK; the Node-24/native-compile
  situation in `gemini-sandbox-toolkit`'s `sandbox.Dockerfile` doesn't change either way.

## Part 2: optional HTTP transport

Once on v2, add a small transport-selection block to `main()` in `src/index.ts` — this is the
whole change, no restructuring of the tool/resource/prompt registrations above it:

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import { createServer } from "node:http";

async function main(): Promise<void> {
  if (process.env.MCP_TRANSPORT === "http") {
    const port = Number(process.env.MCP_HTTP_PORT ?? 3939);
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    createServer(async (req, res) => {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }).listen(port, "127.0.0.1");
    console.error(`ai-intake-mcp listening on http://127.0.0.1:${port}/mcp`);
  } else {
    await server.connect(new StdioServerTransport());
  }
}
```

`MCP_TRANSPORT` unset (or anything other than `"http"`) is stdio, unchanged from today.
`localhostHostValidation()` / `localhostOriginValidation()` are `@modelcontextprotocol/node`'s own
defaults for exactly this scenario — bind loopback-only, reject cross-origin requests — matching
"one teammate runs their own instance," not a network-exposed shared service. No framework
dependency needed (`@modelcontextprotocol/node` wraps plain `node:http`).

Credentials are unaffected: `loadGlobalConfig()` still reads the same local env vars it does
today. A locally-run HTTP instance is single-user, same trust boundary as stdio today — this plan
does **not** cover multi-tenant/shared-server auth, see Open questions.

## Deployment options for teammates (not picking one — this is their call per-person)

- **`gemini-sandbox-toolkit`** — already zero-setup (baked into the sandbox image). For anyone
  willing to use the sandbox, this whole plan is moot for them.
- **stdio, unchanged** — `gemini mcp add --scope user ai-intake npx -y @davindermahal/ai-intake-mcp@<version>`.
  No persistent process, no port. Still needs Node >=24 + a native-addon toolchain (Xcode CLT on
  macOS) for the one-time `better-sqlite3` compile.
- **Local HTTP instance** — `MCP_TRANSPORT=http npx -y @davindermahal/ai-intake-mcp@<version>`
  (foreground, or backgrounded with `pm2`/`launchd`/`systemd --user` if it should survive a
  terminal closing or a reboot — a real per-person choice, not free), then
  `gemini mcp add ai-intake http://127.0.0.1:3939/mcp --transport http`. Same Node/native-toolchain
  prerequisite as stdio — HTTP removes the *sandbox-specific* traps, not this one.

## Key decisions

- **Default transport stays stdio.** HTTP is opt-in via `MCP_TRANSPORT=http`.
- **No shared/hosted server for now.** Each teammate who wants HTTP runs their own local instance
  against their own credentials — explicitly deferred, not designed here (see Open questions).

## Open questions (blocking before this moves to `active/`)

1. **Persistence tooling for a local HTTP instance.** Do we want to document/ship a `pm2`/
   `launchd`/`systemd --user` recipe, or leave "keep it running" entirely to each teammate?
2. **Port default.** `3939` is a placeholder — pick something unlikely to collide with a teammate's
   other local services, or make it configurable-only with no default.
3. **A future shared/hosted instance.** Explicitly out of scope here — would need real
   multi-tenant auth design (whose Jira identity, session isolation), not a natural extension of
   this plan. Revisit only if it becomes an actual need, not preemptively.
4. **CI/test coverage for the HTTP path.** `vitest` suite currently only exercises the server over
   an in-memory transport (per `src/index.ts`'s own comment) — decide whether the HTTP transport
   needs its own test coverage (a real `NodeStreamableHTTPServerTransport` round-trip) before this
   ships, or whether the stdio in-memory tests are considered sufficient given the transport layer
   is entirely SDK-provided code.

## Verification

1. `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` — review the diff, resolve any
   `@mcp-codemod-error` markers.
2. `npm run build && npm test` — full existing suite must still pass.
3. Manual `tools/list` check post-zod-bump (see Part 1) — do not skip this even if `tsc` is clean.
4. stdio smoke test (regression): `echo '<initialize handshake>' | node dist/index.js` — same
   check `gemini-sandbox-toolkit`'s `debug.sh` already does against the baked-in install.
5. HTTP smoke test (new): `MCP_TRANSPORT=http node dist/index.js &`, then a real HTTP `initialize`
   POST to `http://127.0.0.1:3939/mcp`, confirming the same `serverInfo` response stdio returns.
6. Confirm `gemini mcp add ai-intake http://127.0.0.1:3939/mcp --transport http` on a real `gemini`
   (not sandboxed) actually lists and calls a tool end to end.
