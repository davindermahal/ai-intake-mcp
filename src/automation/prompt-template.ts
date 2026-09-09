import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "..", "docs");

/**
 * Splices `{{INCLUDE:relative/to/docs/path.md}}` tokens with that file's contents, read relative to
 * `docs/` — the one shared-fragment mechanism (confluence-references-in-planning.md Key decision #7)
 * used by both `registerDocResource` (interactive planning, `src/index.ts`) and `renderPrompt` below
 * (headless planning) so a Confluence-context instruction added once reaches both without hand-copying
 * it. `{{INCLUDE:...}}`'s `:`/`/`/`.` characters can't match `renderPrompt`'s `\{\{(\w+)\}\}` pattern,
 * so the two token types never collide.
 */
export function resolveIncludes(content: string): string {
  return content.replace(/\{\{INCLUDE:([^}]+)\}\}/g, (_match, relPath: string) => {
    try {
      return readFileSync(join(DOCS_DIR, relPath), "utf8");
    } catch {
      throw new Error(`resolveIncludes: no such file for {{INCLUDE:${relPath}}} (looked in ${DOCS_DIR}).`);
    }
  });
}

/**
 * Placeholder substitution for the headless prompt templates (`prompts/headless-planning.md`,
 * `prompts/headless-implementation.md`, decision #15) — the static template files use `{{NAME}}`
 * tokens (e.g. `{{TICKET_KEY}}`, `{{CONTEXT_FILE_PATH}}`); the orchestrator fills them in per launch
 * with the actual ticket key and the real, resolved state-tree paths (decision #1's result-file
 * protocol, `src/automation/result-file.ts`). Resolves `{{INCLUDE:...}}` tokens first (above) so an
 * included fragment could itself contain a `{{VAR}}` token later, if one's ever needed.
 */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return resolveIncludes(template).replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(`renderPrompt: template references {{${key}}} but no value was provided for it.`);
    }
    return values[key] as string;
  });
}
