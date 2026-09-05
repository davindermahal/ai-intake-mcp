import type { ProjectOverrides } from "./registry.js";
import type { AutomationSettings } from "./settings.js";

/**
 * Per-phase, per-ticket AI provider selection (decision #14, headless-automation plan) — ports the
 * harness's `ai-plan-<profile>`/`ai-impl-<profile>` Jira-label mechanism
 * (`intake-poll.sh`'s `resolve_ai_profile`), resolving against named `provider:model` profiles
 * defined in `settings.json`'s `aiProfiles` (decision #13). A ticket label always wins over a
 * project's own `overrides.aiProfiles.<phase>` default; if neither is present, Claude with no model
 * override is the fixed default (mirroring the harness's `AI_PROVIDER=claude`).
 */
export interface ResolvedProvider {
  provider: "claude" | "gemini";
  model: string | undefined;
}

const LABEL_PREFIX: Record<"planning" | "implementation", string> = {
  planning: "ai-plan-",
  implementation: "ai-impl-",
};

const DEFAULT_PROVIDER: ResolvedProvider = { provider: "claude", model: undefined };

function findProfileLabel(labels: string[], phase: "planning" | "implementation"): string | undefined {
  const prefix = LABEL_PREFIX[phase];
  const label = labels.find((l) => l.startsWith(prefix));
  return label ? label.slice(prefix.length) : undefined;
}

function parseProfileValue(profileName: string, value: string): ResolvedProvider {
  const [provider, ...modelParts] = value.split(":");
  if (provider !== "claude" && provider !== "gemini") {
    throw new Error(
      `aiProfile "${profileName}" ("${value}") names an unknown provider "${provider}" — expected ` +
        `"claude" or "gemini".`,
    );
  }
  return { provider, model: modelParts.length > 0 ? modelParts.join(":") : undefined };
}

export function resolveProvider(
  labels: string[],
  phase: "planning" | "implementation",
  settings: AutomationSettings,
  overrides: ProjectOverrides | undefined,
): ResolvedProvider {
  const profileName = findProfileLabel(labels, phase) ?? overrides?.aiProfiles?.[phase];
  if (!profileName) return DEFAULT_PROVIDER;

  const profileValue = settings.aiProfiles[profileName];
  if (!profileValue) {
    throw new Error(
      `No aiProfile named "${profileName}" in settings.json's aiProfiles (referenced for ${phase}).`,
    );
  }
  return parseProfileValue(profileName, profileValue);
}
