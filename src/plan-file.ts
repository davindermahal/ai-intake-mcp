import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Helpers for `.ai/plans/active/<KEY>-<slug>.md` — the plan file's `**Status**:` field is the
 * approval gate (implementation-phase plan, decision #4). */

const STATUS_LINE = /^(\*\*Status\*\*:)\s*.*$/m;
const UPDATED_LINE = /^(\*\*Updated\*\*:)\s*.*$/m;
const BOUNDARIES_HEADING = /^##\s+Boundaries\s*$/m;
const OPEN_QUESTIONS_HEADING = /^##\s+Open Questions\s*$/m;
const IMPLEMENTATION_ORDER_HEADING = /^##\s+Implementation order\s*$/im;
const TESTING_STRATEGY_HEADING = /^##\s+Testing strategy\s*$/im;
const NEXT_HEADING = /^##\s+\S/m;
const UNCHECKED_TASK_ITEM = /^-\s*\[\s\]/m;

/** The section body between a heading match and the next `##` heading (or end of file). */
function sectionBody(content: string, headingRegex: RegExp): string | undefined {
  const heading = headingRegex.exec(content);
  if (!heading) return undefined;
  const rest = content.slice(heading.index + heading[0].length);
  const nextHeading = NEXT_HEADING.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

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

/** True if the plan file has a non-empty `## Implementation order` section (decisions #17/#22,
 * headless-automation plan). A structural backstop, not a quality check — it can only verify the
 * section exists and isn't empty, not that its steps are genuinely literal/copy-pasteable. */
export function planHasImplementationOrderSection(planPath: string): boolean {
  const content = readFileSync(planPath, "utf8");
  const body = sectionBody(content, IMPLEMENTATION_ORDER_HEADING);
  return body !== undefined && body.trim().length > 0;
}

/** True if the plan file has a non-empty `## Testing strategy` section (decision #22,
 * headless-automation plan — `docs://planning-procedure`'s TDD requirement, same standing as
 * `## Boundaries`). */
export function planHasTestingStrategySection(planPath: string): boolean {
  const content = readFileSync(planPath, "utf8");
  const body = sectionBody(content, TESTING_STRATEGY_HEADING);
  return body !== undefined && body.trim().length > 0;
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
  const section = sectionBody(content, OPEN_QUESTIONS_HEADING);
  if (section === undefined) return false;
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
