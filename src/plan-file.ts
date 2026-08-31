import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Helpers for `.ai/plans/active/<KEY>-<slug>.md` — the plan file's `**Status**:` field is the
 * approval gate (implementation-phase plan, decision #4). */

const STATUS_LINE = /^(\*\*Status\*\*:)\s*.*$/m;
const UPDATED_LINE = /^(\*\*Updated\*\*:)\s*.*$/m;
const BOUNDARIES_HEADING = /^##\s+Boundaries\s*$/m;
const OPEN_QUESTIONS_HEADING = /^##\s+Open Questions\s*$/m;
const NEXT_HEADING = /^##\s+\S/m;
const UNCHECKED_TASK_ITEM = /^-\s*\[\s\]/m;

/** Finds `.ai/plans/active/<ticketKey>-*.md` inside a worktree. Undefined if none exists. */
export function findPlanFile(worktreePath: string, ticketKey: string): string | undefined {
  const activeDir = join(worktreePath, ".ai", "plans", "active");
  let entries: string[];
  try {
    entries = readdirSync(activeDir);
  } catch {
    return undefined;
  }
  const prefix = `${ticketKey}-`;
  const match = entries.find((name) => name.startsWith(prefix) && name.endsWith(".md"));
  return match ? join(activeDir, match) : undefined;
}

export function readPlanStatus(planPath: string): string {
  const content = readFileSync(planPath, "utf8");
  const match = STATUS_LINE.exec(content);
  if (!match) {
    throw new Error(`${planPath} has no **Status**: line — malformed plan file.`);
  }
  return match[0].replace(/^\*\*Status\*\*:/, "").trim();
}

/** True if the plan file has a `## Boundaries` heading. `docs/planning-procedure.md` requires every
 * plan to have one; `implement_ticket` refuses to hand off implementation to a plan without one
 * (docs/implementation-procedure.md) rather than let an executor treat its absence as "no limits". */
export function planHasBoundariesSection(planPath: string): boolean {
  const content = readFileSync(planPath, "utf8");
  return BOUNDARIES_HEADING.test(content);
}

/** True if the plan file's `## Open Questions` section has any unresolved `- [ ]` item.
 * `docs/planning-procedure.md` requires every Open Questions item — blocking or a non-blocking
 * "confirm at review" note alike — to be written as a `- [ ]`/`- [x]` task-list line;
 * `approve_plan` refuses to approve while any `- [ ]` remains, closing the gap where a plan reached
 * `state:review` with something still unaddressed and the human approving it never noticed. No
 * `## Open Questions` heading at all means nothing to resolve — not itself an approval blocker (that
 * would duplicate the `## Boundaries` check's job for an unrelated section). */
export function planHasUnresolvedOpenQuestions(planPath: string): boolean {
  const content = readFileSync(planPath, "utf8");
  const heading = OPEN_QUESTIONS_HEADING.exec(content);
  if (!heading) return false;
  const rest = content.slice(heading.index + heading[0].length);
  const nextHeading = NEXT_HEADING.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return UNCHECKED_TASK_ITEM.test(section);
}

/** Sets the plan file's `**Status**:` and bumps `**Updated**:` to today (UTC date). */
export function setPlanStatus(planPath: string, newStatus: string): void {
  const content = readFileSync(planPath, "utf8");
  if (!STATUS_LINE.test(content)) {
    throw new Error(`${planPath} has no **Status**: line — malformed plan file.`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const updated = content
    .replace(STATUS_LINE, `$1 ${newStatus}`)
    .replace(UPDATED_LINE, `$1 ${today}`);
  writeFileSync(planPath, updated, "utf8");
}
