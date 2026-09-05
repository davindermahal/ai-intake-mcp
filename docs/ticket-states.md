# Ticket states

Served as the `docs://ticket-states` MCP resource — reference only. `ai-intake-mcp` uses its own,
shortened `state:*` label vocabulary (decision #3 in the plan doc), not `ai-intake-harness`'s literal
strings. A ticket cannot move between the two pipelines — each reads a different label as its source
of truth. This is a deliberate, accepted consequence of keeping these two systems non-integrated (see
the plan doc's "Goal"), not an oversight.

| Label | Meaning | `tracker_transition` target? |
|---|---|---|
| `state:plan` | Ticket has entered the pipeline; not yet worked. Applied automatically the first time `tracker_get_issue` sees an untouched ticket. | No — bootstrap-only. |
| `state:needs-input` | Waiting on the ticket's author to answer a question raised during planning. | Yes. |
| `state:review` | Plan written, awaiting human approval. | Yes. |
| `state:implement` | Human approved the plan; ready for implementation. | **No** — reachable only via `approve_plan`, which also flips the plan file's `Status` to `ready`. Calling `tracker_transition` with this target directly is refused. |
| `state:working` | Implementation session started. | Yes — set automatically by `implement_ticket`. |
| `state:verify` | Implementation complete, all declared `make` targets passed, work committed locally. | Yes — set automatically at the end of a successful `implement_ticket` session. |
| `state:problem` | Implementation blocked — an unfixable failure, or something needing a human decision. Deliberately a distinct label from `state:needs-input`, which specifically means "the *author* needs to answer a planning question" — a build/test failure isn't that. | Yes — set automatically at the end of a blocked `implement_ticket` session. |
| `state:done` | Finished (merged). | No tool in `ai-intake-mcp` ever sets this — a later, human/merge-time step, out of scope. |

## App-tag scoping

Each ticket also carries an `app:<repo>` label (e.g. `app:my-repo`) identifying which repo's
`ai-intake-mcp` instance owns it — this is what makes a shared Jira board safe to use from multiple
repos at once (decision #4). `tracker_get_issue` refuses to act on a ticket tagged for a different
repo, and adopts (tags) a ticket that has no `app:*` label yet.

## Assignee gate

Every state-changing write (`tracker_transition`) requires the ticket be assigned to the account
`ai-intake-mcp` authenticates as. An unassigned ticket is auto-assigned on first write; a ticket
assigned to someone else is refused outright. `tracker_add_comment` is not gated — see decision #3.
