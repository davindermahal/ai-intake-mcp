# .ai/ orientation

**ai-intake-mcp** is an MCP server that lets a developer plan an issue-tracker ticket on demand,
from inside their own project repo, using whatever MCP-capable agent CLI they already have open —
no cron, no per-project install. See the repo root `README.md` for what it does; see
`.ai/plans/active/ai-intake-mcp-on-demand-planning.md` for the full design record.

This project is related to, but independent of, `ai-intake-harness` (a separate repo): that project
runs a cron-driven poller that automates a ticket's full lifecycle (planning *and*
implementation) across many consumer repos. This project covers planning only, triggered by a human
naming a ticket, with no dependency on that repo's code.

## Read order

1. **This file** — orientation.
2. [`system.md`](system.md) — what this project is, core design decisions, tool surface.
3. [`repo-map.md`](repo-map.md) — directory-by-directory map of the codebase.
4. `../README.md` (repo root) — what the tool does, current status.
5. `.ai/plans/active/ai-intake-mcp-on-demand-planning.md` — the full design record for the planning
   phase (v1, implemented): every decision, why it was made, what's still open.
5b. `.ai/plans/active/ai-intake-mcp-implementation-phase.md` — the design record for the
   implementation phase (extends v1; not yet implemented): turning an approved plan into
   implemented, verified, committed code.
6. `.ai/guides/ai-intake-mcp-vs-harness.md` — a functional comparison against `ai-intake-harness`,
   useful for understanding what this project deliberately does *not* do (and why).

## Plans convention

Three stages, each its own directory:

- **`.ai/plans/draft/`** — an idea or brainstorming session captured before it's fleshed into
  concrete implementation steps. Not forced to completeness just to have somewhere to put it; open
  questions are expected here.
- **`.ai/plans/active/`** — a fleshed-out plan, ready to implement or being implemented.
- **`.ai/plans/completed/`** — finished. Files here are never edited again, only superseded by a
  new plan.

Move the file between directories as it progresses; don't duplicate it.

### Verification requirement

Every plan that integrates with an external system (a real API, a real service) must define a real
verification checkpoint against that system — not just mocked/unit-test coverage. Mocked tests
confirm the code's logic; they don't confirm a request is actually valid against the real system.
Place this checkpoint as early and as narrowly-scoped as the plan allows (e.g. a smoke check at the
end of the phase that builds the integration, before later phases build on top of it) rather than
deferring it entirely to a final end-to-end/dogfood step — the narrower the checkpoint, the easier a
real-system surprise is to isolate. See
`.ai/plans/active/ai-intake-mcp-on-demand-planning.md`'s "Verification checkpoints" section for the
pattern.

This is now also a structural requirement of the plan format itself, not just a principle to
remember: every plan — whether authored interactively or by a headless worker — requires a non-empty
`## QA Plan` section (`docs/planning-procedure.md`, enforced by `planHasQAPlanSection`/
`approve_plan`, same standing as `## Boundaries`/`## Testing strategy`) stating what's covered by
automated tests and, separately, exactly what a human must still manually verify — "None" when
genuinely nothing needs it. A plan whose manual-QA surface is large enough to warrant its own
document splits it into a companion `.ai/plans/active/<slug>-qa.md`; see
`.ai/plans/completed/headless-automation-qa.md` for the shape one of those takes (moved to
`completed/` once its own sign-off phase passed).

## `.ai/docs/extracted/`

A generic drop point for scoped writeups extracted from this project for use outside it (e.g. for
article drafting) — not tied to any one extraction tool, so anyone can add to it even without
access to the specific skill that produced an existing file. Empty until something is extracted.

## `.ai/prompts/`

Empty for now. Reserved for any prompt content this server's tools/resources need to ship, once
implementation starts.
