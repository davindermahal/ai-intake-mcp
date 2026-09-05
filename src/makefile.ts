import { readFileSync } from "node:fs";

const RULE_LINE = /^([A-Za-z0-9_.-]+)\s*:(?!=)/;

/**
 * Extracts the target names a Makefile actually defines — used only to catch a
 * `.ai/intake-mcp.json` `skipTargets` entry that contradicts a target the Makefile clearly has
 * (hardening-phase plan, decision #3). Deliberately simple: a rule line `name: prereqs...` at
 * column 0 (recipe lines start with a tab and are skipped), name restricted to make's typical
 * identifier charset. Doesn't handle `include`d makefiles, pattern rules, multi-target rule lines,
 * or macro-expanded target names — those stay outside what this check can see, the same category of
 * limit as everything else in this phase. Missing file → no targets, not an error (a project might
 * genuinely have no Makefile at all).
 */
export function makefileTargetNames(makefilePath: string): Set<string> {
  let content: string;
  try {
    content = readFileSync(makefilePath, "utf8");
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  for (const line of content.split("\n")) {
    if (line.startsWith("\t") || line.startsWith("#")) continue;
    const match = RULE_LINE.exec(line);
    if (match?.[1] && match[1] !== ".PHONY") names.add(match[1]);
  }
  return names;
}

/**
 * Which of `skipTargets` (from `.ai/intake-mcp.json`) the Makefile actually defines — a real,
 * catchable contradiction: the project both has the target and someone declared it doesn't apply.
 * Cannot verify the opposite direction (that a target which *does* exist was actually run and
 * passed) — no code here executes `make` on the agent's behalf; that remains entirely dependent on
 * the agent following `docs://implementation-procedure` §4.
 */
export function contradictedSkipTargets(makefilePath: string, skipTargets: readonly string[]): string[] {
  const names = makefileTargetNames(makefilePath);
  return skipTargets.filter((target) => names.has(target));
}
