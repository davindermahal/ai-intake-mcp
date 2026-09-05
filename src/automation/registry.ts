import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Global project registry (decision #7, headless-automation plan) — `ai-intake-mcp`'s interactive
 * tools only ever know "the repo the calling agent's cwd is in"; headless automation needs an
 * explicit list of repos it's allowed to drive. A repo's own Jira scoping (`jiraProjectKeys`/
 * `appTag`, decision #6) is never duplicated here — this file is only "which repos, and how
 * automation should treat each one."
 */

export interface WatchdogPhaseOverride {
  graceSeconds?: number;
  maxAttempts?: number;
  heartbeatSeconds?: number;
}

/**
 * Every field independently optional (decision #7's "open bag") so new override keys can be added
 * later without a schema migration. The registry loader below only shape-checks that `overrides`
 * itself is an object — each field's actual meaning/validity is resolved lazily, wherever that
 * setting is actually consumed (see `src/automation/settings.ts`'s `resolve*` functions).
 */
export interface ProjectOverrides {
  /** Claude only — Gemini's policy engine is machine-global by tier, so this is a no-op for it
   * (decision #9). Resolvers must ignore this field when the project's provider is Gemini. */
  permissionProfile?: string;
  worktreeRoot?: string;
  concurrency?: { planning?: number };
  watchdog?: { implementation?: WatchdogPhaseOverride; planning?: WatchdogPhaseOverride };
  aiProfiles?: { planning?: string; implementation?: string };
  [key: string]: unknown;
}

export interface ProjectEntry {
  path: string;
  name: string;
  enabled: boolean;
  overrides?: ProjectOverrides;
}

export interface ProjectRegistry {
  projects: ProjectEntry[];
}

const REGISTRY_PATH = join(homedir(), ".config", "ai-intake-mcp", "projects.json");

function malformed(detail: string): Error {
  return new Error(`${REGISTRY_PATH} is malformed — ${detail}.`);
}

function parseOverrides(raw: unknown, index: number): ProjectOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw malformed(`projects[${index}].overrides must be an object`);
  }
  return raw as ProjectOverrides;
}

function parseProjectEntry(raw: unknown, index: number): ProjectEntry {
  if (typeof raw !== "object" || raw === null) {
    throw malformed(`projects[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    throw malformed(`projects[${index}].path must be a non-empty string`);
  }
  if (obj.name !== undefined && typeof obj.name !== "string") {
    throw malformed(`projects[${index}].name must be a string`);
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
    throw malformed(`projects[${index}].enabled must be a boolean`);
  }
  return {
    path: obj.path,
    name: typeof obj.name === "string" ? obj.name : basename(obj.path),
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    overrides: obj.overrides !== undefined ? parseOverrides(obj.overrides, index) : undefined,
  };
}

/** Loads `~/.config/ai-intake-mcp/projects.json`. A missing file is a valid, empty registry —
 * headless automation simply has nothing registered yet, same "file optional" precedent as
 * `loadGlobalConfig`. */
export function loadProjectRegistry(): ProjectRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { projects: [] };
    throw err;
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { projects?: unknown }).projects)) {
    throw malformed('expected { "projects": [...] }');
  }

  const rawProjects = (parsed as { projects: unknown[] }).projects;
  return { projects: rawProjects.map((p, i) => parseProjectEntry(p, i)) };
}

/** Writes the registry back to `~/.config/ai-intake-mcp/projects.json`, pretty-printed. */
export function saveProjectRegistry(registry: ProjectRegistry): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  const serializable = {
    projects: registry.projects.map((p) => ({
      path: p.path,
      name: p.name,
      enabled: p.enabled,
      ...(p.overrides !== undefined ? { overrides: p.overrides } : {}),
    })),
  };
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
}

/** Idempotent on repo path (decision #20's registration wizard, step 5) — registering the same path
 * again replaces that entry in place rather than appending a duplicate. Returns a new registry;
 * doesn't mutate the one passed in. */
export function upsertProject(registry: ProjectRegistry, entry: ProjectEntry): ProjectRegistry {
  const index = registry.projects.findIndex((p) => p.path === entry.path);
  if (index === -1) return { projects: [...registry.projects, entry] };
  const projects = [...registry.projects];
  projects[index] = entry;
  return { projects };
}
