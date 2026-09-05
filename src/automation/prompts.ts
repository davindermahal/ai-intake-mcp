import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates the static headless prompt templates (`prompts/headless-planning.md`,
 * `prompts/headless-implementation.md`, decision #15) relative to this module's own file, not
 * `process.cwd()` — the orchestrator runs against a *target* repo's cwd (the worktree it just
 * created), not `ai-intake-mcp`'s own. Works identically whether this module runs as compiled
 * `dist/automation/prompts.js` or directly as `src/automation/prompts.ts` (tsx) — both sit at the
 * same depth under the package root, two directories above `prompts/`.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export type PromptName = "headless-planning" | "headless-implementation";

export function promptTemplatePath(name: PromptName): string {
  return join(MODULE_DIR, "..", "..", "prompts", `${name}.md`);
}
