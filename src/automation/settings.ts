import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectOverrides } from "./registry.js";

/**
 * Global operational defaults (decision #13, headless-automation plan) — tunables shared across
 * every registered project, distinct from `projects.json` ("which repos") and `.env`
 * (`src/config.ts`, credentials). A project's `overrides` bag (decision #7) can override any of
 * these individually; the `resolve*` functions below are where that per-project override actually
 * gets applied, one setting at a time, lazily, wherever it's consumed.
 */

export interface WatchdogPhaseSettings {
  graceSeconds: number;
  maxAttempts: number;
  heartbeatSeconds: number;
}

export interface WatchdogSettings {
  implementation: WatchdogPhaseSettings;
  planning: WatchdogPhaseSettings;
}

export interface PermissionSettings {
  claude: string;
  gemini: string;
}

export interface AutomationSettings {
  watchdog: WatchdogSettings;
  /** Planning only — implementation's cap is a fixed structural 1 (decision #4/#5), never a
   * config value, so it has no entry here. */
  concurrency: { planning: number };
  permissions: PermissionSettings;
  /** Named `provider:model` profiles (decision #14), e.g. `{"fast-impl": "gemini:gemini-2.5-pro"}`. */
  aiProfiles: Record<string, string>;
}

const SETTINGS_PATH = join(homedir(), ".config", "ai-intake-mcp", "settings.json");

/** Numbers from the user's own observed Gemini implementation durations (25-40 min); planning is
 * typically much faster, so it gets its own, tighter pair (decision #12/#13). */
const DEFAULT_SETTINGS: AutomationSettings = {
  watchdog: {
    implementation: { graceSeconds: 1800, maxAttempts: 3, heartbeatSeconds: 1500 },
    planning: { graceSeconds: 600, maxAttempts: 3, heartbeatSeconds: 300 },
  },
  concurrency: { planning: 3 },
  permissions: {
    claude: "~/.config/ai-intake-mcp/permissions/claude.json",
    gemini: "~/.gemini/policies/ai-intake-mcp-headless.toml",
  },
  aiProfiles: {},
};

function malformed(detail: string): Error {
  return new Error(`${SETTINGS_PATH} is malformed — ${detail}.`);
}

function mergeWatchdogPhase(
  base: WatchdogPhaseSettings,
  path: string,
  raw: unknown,
): WatchdogPhaseSettings {
  if (raw === undefined) return base;
  if (typeof raw !== "object" || raw === null) throw malformed(`${path} must be an object`);
  const obj = raw as Record<string, unknown>;
  const merged = { ...base };
  for (const key of ["graceSeconds", "maxAttempts", "heartbeatSeconds"] as const) {
    if (obj[key] === undefined) continue;
    if (typeof obj[key] !== "number") throw malformed(`${path}.${key} must be a number`);
    merged[key] = obj[key];
  }
  return merged;
}

function mergeSettings(defaults: AutomationSettings, raw: unknown): AutomationSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw malformed("expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const watchdogRaw = obj.watchdog;
  if (watchdogRaw !== undefined && (typeof watchdogRaw !== "object" || watchdogRaw === null)) {
    throw malformed("watchdog must be an object");
  }
  const watchdogObj = (watchdogRaw ?? {}) as Record<string, unknown>;

  const concurrencyRaw = obj.concurrency;
  if (concurrencyRaw !== undefined && (typeof concurrencyRaw !== "object" || concurrencyRaw === null)) {
    throw malformed("concurrency must be an object");
  }
  const concurrencyObj = (concurrencyRaw ?? {}) as Record<string, unknown>;
  let planningConcurrency = defaults.concurrency.planning;
  if (concurrencyObj.planning !== undefined) {
    if (typeof concurrencyObj.planning !== "number") throw malformed("concurrency.planning must be a number");
    planningConcurrency = concurrencyObj.planning;
  }

  const permissionsRaw = obj.permissions;
  if (permissionsRaw !== undefined && (typeof permissionsRaw !== "object" || permissionsRaw === null)) {
    throw malformed("permissions must be an object");
  }
  const permissionsObj = (permissionsRaw ?? {}) as Record<string, unknown>;
  const permissions = { ...defaults.permissions };
  for (const key of ["claude", "gemini"] as const) {
    if (permissionsObj[key] === undefined) continue;
    if (typeof permissionsObj[key] !== "string") throw malformed(`permissions.${key} must be a string`);
    permissions[key] = permissionsObj[key];
  }

  let aiProfiles = defaults.aiProfiles;
  if (obj.aiProfiles !== undefined) {
    if (typeof obj.aiProfiles !== "object" || obj.aiProfiles === null || Array.isArray(obj.aiProfiles)) {
      throw malformed("aiProfiles must be an object");
    }
    const profilesObj = obj.aiProfiles as Record<string, unknown>;
    for (const [key, value] of Object.entries(profilesObj)) {
      if (typeof value !== "string") throw malformed(`aiProfiles.${key} must be a string`);
    }
    aiProfiles = profilesObj as Record<string, string>;
  }

  return {
    watchdog: {
      implementation: mergeWatchdogPhase(
        defaults.watchdog.implementation,
        "watchdog.implementation",
        watchdogObj.implementation,
      ),
      planning: mergeWatchdogPhase(defaults.watchdog.planning, "watchdog.planning", watchdogObj.planning),
    },
    concurrency: { planning: planningConcurrency },
    permissions,
    aiProfiles,
  };
}

/** Loads `~/.config/ai-intake-mcp/settings.json`. A missing file is valid — every field falls back
 * to its built-in default (same "file optional" precedent as `loadGlobalConfig`). */
export function loadAutomationSettings(): AutomationSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
    throw err;
  }
  return mergeSettings(DEFAULT_SETTINGS, parsed);
}

/** Per-phase watchdog settings, with a project's `overrides.watchdog.<phase>` applied field-by-field
 * on top of the global default (decision #12/#13). */
export function resolveWatchdogSettings(
  settings: AutomationSettings,
  overrides: ProjectOverrides | undefined,
  phase: "planning" | "implementation",
): WatchdogPhaseSettings {
  const base = settings.watchdog[phase];
  const override = overrides?.watchdog?.[phase];
  if (!override) return base;
  return {
    graceSeconds: override.graceSeconds ?? base.graceSeconds,
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    heartbeatSeconds: override.heartbeatSeconds ?? base.heartbeatSeconds,
  };
}

/** Planning concurrency cap, global default plus optional per-project override (decision #5). Never
 * called for implementation — that cap is a fixed structural 1, not a resolved setting. */
export function resolvePlanningConcurrencyCap(
  settings: AutomationSettings,
  overrides: ProjectOverrides | undefined,
): number {
  return overrides?.concurrency?.planning ?? settings.concurrency.planning;
}

/**
 * Expands a leading `~` to the real home directory. Every path this module hands to `spawn()`
 * (`src/ai/launch.ts`) goes through no shell, so nothing else would ever expand it — confirmed live
 * against the `claude` CLI during headless-automation QA (Phase B): `--settings
 * ~/.config/ai-intake-mcp/permissions/claude.json` with the tilde literally unexpanded fails with
 * `Error: Settings file not found`, which is exactly what `DEFAULT_SETTINGS.permissions.claude`
 * would have produced on every fresh install (no `~/.config/ai-intake-mcp/settings.json` yet).
 */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Resolved permission-profile path for a provider (decision #9). Claude honors a per-project
 * `overrides.permissionProfile`; Gemini never does — its policy engine is machine-global by tier
 * (gemini-cli issue #18186), so a per-project override would silently be a no-op and is ignored
 * here rather than pretending to apply it. */
export function resolvePermissionProfilePath(
  settings: AutomationSettings,
  overrides: ProjectOverrides | undefined,
  provider: "claude" | "gemini",
): string {
  if (provider === "claude" && overrides?.permissionProfile) {
    return expandHome(overrides.permissionProfile);
  }
  return expandHome(settings.permissions[provider]);
}
