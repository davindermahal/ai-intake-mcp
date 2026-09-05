# Usage guide

A plain-language walkthrough of how to actually use `ai-intake-mcp` day to day. For one-time
install/config steps, see [`setup.md`](setup.md) instead — this doc assumes that's already done.

## The lifecycle, at a glance

```
Plan  →  Review  →  Approve  →  Implement  →  You merge
```

You trigger every step yourself, by asking your agent (Claude Code or Gemini CLI). Nothing runs on
a timer, nothing auto-approves, and nothing ever pushes or merges on its own — you're always the one
deciding when to move to the next stage.

Commands look slightly different depending on which agent you're using:

| Step | Gemini CLI | Claude Code |
|---|---|---|
| Plan | `/plan_ticket DAV-4` | `/mcp__ai-intake__plan_ticket DAV-4` |
| Approve | *(just ask)* | *(just ask)* |
| Implement | `/implement_ticket DAV-4` | `/mcp__ai-intake__implement_ticket DAV-4` |

## Step 1: Plan a ticket

From inside your project repo, with your agent CLI open, run:

```
/plan_ticket DAV-4
```

(swap `DAV-4` for whatever ticket you want planned)

Your agent will:
- Fetch the ticket from Jira and read its description/comments.
- Set up a dedicated git branch and working folder for this ticket (a "worktree") — a sibling
  folder next to your project, so your main checkout is left alone.
- Write a plan file describing the approach: what will change, in what order, and any open
  questions.
- Post a summary comment back to the Jira ticket, and update its status on the board.

**The very first time you plan a ticket in a given repo**, you'll be asked once for that repo's
Jira project key and a short tag identifying the repo — after that you're never asked again.

If the plan turned out to have a genuine open question (something only you, as the ticket's author,
can answer — not something the agent could reasonably guess), the ticket moves to a "needs your
input" status and the agent will tell you what it needs. Answer in a Jira comment (or just tell your
agent the answer directly) and re-run `/plan_ticket DAV-4` — it'll pick up where it left off rather
than starting over.

## Step 2: Review the plan

The plan lives at `.ai/plans/active/DAV-4-<slug>.md` inside the worktree the agent created (the
sibling folder, not your main checkout). Open it and read it like you would a PR description —
what's being built, what files change, and in what order.

You'll also see a summary comment on the Jira ticket itself, and its status will now show it's
awaiting your review.

## Step 3: Approve the plan

If the plan looks good, tell your agent to approve it:

> "Approve DAV-4's plan"

This is a deliberate, explicit action — nothing moves a plan into "ready to implement" on its own.
Approving does two things at once: marks the plan as approved, and updates the Jira ticket to match.
If you ask for a ticket that hasn't actually been through review yet, it'll refuse rather than
approve something that was never finished.

## Step 4: Implement the ticket

```
/implement_ticket DAV-4
```

Your agent will:
- Return to that same worktree/branch from step 1.
- Confirm the plan was actually approved (refuses otherwise — you can't skip step 3).
- Work through the plan's steps, editing code as it goes.
- Run your project's own build/test/lint commands to verify the work.
- Commit the changes locally, on that ticket's branch.
- Post a summary comment back to Jira and update the ticket's status.

**Nothing is ever pushed, merged, or deployed automatically** — implementation always stops at a
local commit, on a local branch, for you to review.

If implementation hits something it can't resolve on its own — a failing check it can't fix, or a
decision only you can make — it stops, explains what happened in a Jira comment, and flags the
ticket so it's obviously not finished, rather than guessing or pushing forward.

## Step 5: You review and merge

Check out the branch, review the diff the same way you'd review any PR, and merge it yourself when
you're happy with it. This step is entirely manual and always will be — `ai-intake-mcp` never
touches your remote.

## A few things worth knowing

- **You can plan without implementing.** If you just want the planning step (e.g. to hand
  implementation off to someone else, or do it yourself by hand), stop after step 2 or 3 — nothing
  forces you into step 4.
- **Multiple people can use this on the same Jira board.** Each repo is tagged so a ticket belonging
  to a different project is never accidentally touched, and every ticket is safety-checked against
  who it's currently assigned to before anything writes to it.
- **Re-running a step is safe.** If a worktree already exists for a ticket, planning/implementing
  resumes it rather than starting fresh or erroring.
- **Cleaning up afterward** (once a ticket's branch has been merged) is also an ask-your-agent
  action — it removes the leftover worktree/branch for you, but only for branches that are already
  merged, and it double-checks before doing anything destructive.

## Want the technical details?

This guide deliberately skips the internals. If you want to know exactly how approval/state
tracking works, what gets written where, or the reasoning behind specific design choices, see the
full design records: [`../.ai/plans/active/ai-intake-mcp-on-demand-planning.md`](../.ai/plans/active/ai-intake-mcp-on-demand-planning.md)
(planning) and [`../.ai/plans/active/ai-intake-mcp-implementation-phase.md`](../.ai/plans/active/ai-intake-mcp-implementation-phase.md)
(implementation).
