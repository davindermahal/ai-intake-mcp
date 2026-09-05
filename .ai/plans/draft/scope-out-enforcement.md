# Plan (draft): `ai-intake-mcp` — code-level enforcement of `Scope` → "Out"

**Status**: draft
**Created**: 2026-08-30
**Updated**: 2026-08-30
**Related**: `docs/planning-procedure.md` (plan file shape, `## Boundaries` requirement),
`docs/implementation-procedure.md` (hard limits), `src/plan-file.ts` (`planHasBoundariesSection`,
added alongside this idea as the first, simpler guardrail), `src/tools/tracker-transition.ts`,
`src/tools/implement-ticket.ts`

## Motivation

Weaker executors (Gemini named specifically) can't be trusted to stay in scope on instructions
alone. `docs/implementation-procedure.md` already requires plans to have a `## Boundaries` section
and instructs the implementer to treat `Scope` → "Out" and `Boundaries` as hard fences — but that's
enforced by an LLM reading and following prose. `planHasBoundariesSection` (already implemented)
only checks the section *exists*; nothing checks that the executor actually respected it. This plan
is the next step: verify the executor's real changes against the fenced list, in code.

## Why this is harder than the Boundaries-presence check

The Boundaries check is structural (does a heading exist — no false positives possible).
Scope-Out enforcement is content-based: it requires (1) a machine-parseable list of what's
off-limits, and (2) a point in the code that can see the executor's actual changes and compare them.

**Architectural constraint that shapes the whole design:** `ai-intake-mcp` never intermediates file
edits — Claude/Gemini/etc. edit files directly through the host tool, not through this MCP server.
There is no way to intercept "the executor is about to write to `src/auth.ts`" in real time. The only
thing this server can inspect is git state at the moments an agent calls one of *our* tools. So
real-time blocking is off the table; the only realistic design is a **checkpoint gate** — verify the
final diff at the moment the executor tries to declare the work done.

## Proposed design

1. **Formalize enough of "Out" to parse it.** Only backtick-quoted paths/globs count as
   machine-enforceable; free prose ("no schema changes") stays convention-only, unenforced by this
   mechanism. e.g.:
   ```
   **Out**:
   - `src/legacy/**` — do not touch, being removed in DAV-9
   ```
2. **Merge patterns from both `Scope` → "Out" and `## Boundaries`** (decided — see Key decisions).
   Both sections are meant to name off-limits files; planners shouldn't have to duplicate the same
   path in two places, and `## Boundaries` already requires concrete paths per the earlier change.
3. **New parser** in `src/plan-file.ts`, e.g. `extractOutOfScopePatterns(planPath): string[]`,
   pulling backtick-quoted paths from both headings.
4. **A small glob matcher** (`*`, `**`, directory-prefix matching) — nothing like this exists in the
   codebase yet; keep it minimal, no dependency needed for this scope.
5. **The gate**: at the moment of transition to `state:verify`, resolve the ticket's worktree+plan
   (if any), run `git diff --name-only <base>...HEAD` in the worktree, match changed files against
   the extracted patterns, and refuse the transition (throwing, naming the offending files) if any
   match. No worktree/plan for the ticket → skip silently (this tool is also used for tickets outside
   this flow).

## What this deliberately cannot catch

Anything that isn't a file path: new dependencies, added abstractions, scope creep confined to
allowed files. Those remain instruction-only, exactly as they are today.

## Key decisions

- **Pattern source: merge `Scope` → "Out" and `Boundaries`, don't pick one.** Confirmed with the
  developer (2026-08-30) — avoids forcing the planner to duplicate the same path under two headings.

## Open questions (blocking before this moves to `active/`)

1. **Where does the gate live?** Explicitly deferred by the developer (2026-08-30) — not decided.
   Two options surfaced, each with a real tradeoff:
   - **Gate `tracker_transition` when `state === "verify"`.** No new tool to remember to call, but
     couples a shared/generic tool (used by planning and other transitions too) to
     implementation-specific logic, and only fires for tickets that actually have a worktree+plan.
   - **New dedicated tool** (e.g. `check_scope`), called explicitly from
     `docs://implementation-procedure` before the success report. Cleaner separation of concerns, but
     nothing forces a weaker executor to actually call it — the same trust problem this whole effort
     is trying to route around.
2. **Hard block vs. warning.** Should a violation refuse the transition outright (consistent with the
   `Boundaries`-presence gate), or allow it through with an auto-appended warning comment? Leaning
   hard block for consistency, not yet confirmed.
3. **Glob semantics.** How much glob support is actually needed (`*`, `**`, plain directory prefixes)
   vs. how much is worth the implementation/test cost of a hand-rolled matcher — no glob library is
   currently a dependency of this project.
4. **Malformed/unparseable patterns.** If a plan's "Out" bullet isn't backtick-quoted or doesn't
   parse cleanly, does the gate skip it silently (risk: silently unenforced) or fail loudly (risk:
   blocks a transition over a formatting nit)?
