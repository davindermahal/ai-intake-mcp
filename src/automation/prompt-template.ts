/**
 * Placeholder substitution for the headless prompt templates (`prompts/headless-planning.md`,
 * `prompts/headless-implementation.md`, decision #15) — the static template files use `{{NAME}}`
 * tokens (e.g. `{{TICKET_KEY}}`, `{{CONTEXT_FILE_PATH}}`); the orchestrator fills them in per launch
 * with the actual ticket key and the real, resolved state-tree paths (decision #1's result-file
 * protocol, `src/automation/result-file.ts`).
 */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(`renderPrompt: template references {{${key}}} but no value was provided for it.`);
    }
    return values[key] as string;
  });
}
