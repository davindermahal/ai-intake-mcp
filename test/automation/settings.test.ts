import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectOverrides } from "../../src/automation/registry.js";
import type { AutomationSettings } from "../../src/automation/settings.js";

const DEFAULTS: AutomationSettings = {
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

// settings.ts reads a hardcoded ~/.config/ai-intake-mcp/settings.json path — same seam/rationale
// as test/config.test.ts's mock of node:fs's readFileSync.
const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: readFileSyncMock }));

const {
  loadAutomationSettings,
  resolveWatchdogSettings,
  resolvePlanningConcurrencyCap,
  resolvePermissionProfilePath,
} = await import("../../src/automation/settings.js");

function enoent(): NodeJS.ErrnoException {
  const err = new Error("no such file") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

beforeEach(() => {
  readFileSyncMock.mockReset();
  readFileSyncMock.mockImplementation(() => {
    throw enoent();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadAutomationSettings", () => {
  it("returns built-in defaults when settings.json doesn't exist", () => {
    const settings = loadAutomationSettings();
    expect(settings).toEqual({
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
    });
  });

  it("rethrows a non-ENOENT error reading the file", () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("permission denied");
    });
    expect(() => loadAutomationSettings()).toThrow(/permission denied/);
  });

  it("merges a partial concurrency override onto defaults, leaving everything else default", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ concurrency: { planning: 5 } }));
    const settings = loadAutomationSettings();
    expect(settings.concurrency.planning).toBe(5);
    expect(settings.watchdog.implementation.graceSeconds).toBe(1800);
  });

  it("merges a partial watchdog phase override field-by-field", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ watchdog: { implementation: { maxAttempts: 5 } } }));
    const settings = loadAutomationSettings();
    expect(settings.watchdog.implementation).toEqual({
      graceSeconds: 1800,
      maxAttempts: 5,
      heartbeatSeconds: 1500,
    });
    expect(settings.watchdog.planning).toEqual({ graceSeconds: 600, maxAttempts: 3, heartbeatSeconds: 300 });
  });

  it("merges permissions overrides", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ permissions: { claude: "/custom/claude.json" } }));
    const settings = loadAutomationSettings();
    expect(settings.permissions.claude).toBe("/custom/claude.json");
    expect(settings.permissions.gemini).toBe("~/.gemini/policies/ai-intake-mcp-headless.toml");
  });

  it("reads aiProfiles as a flat provider:model map", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ aiProfiles: { "fast-impl": "gemini:gemini-2.5-pro" } }));
    expect(loadAutomationSettings().aiProfiles).toEqual({ "fast-impl": "gemini:gemini-2.5-pro" });
  });

  it("throws when a numeric field is given the wrong type", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ concurrency: { planning: "three" } }));
    expect(() => loadAutomationSettings()).toThrow(/concurrency\.planning must be a number/);
  });

  it("throws on malformed top-level JSON (not an object)", () => {
    readFileSyncMock.mockReturnValue("[]");
    expect(() => loadAutomationSettings()).toThrow(/malformed/);
  });
});

describe("resolveWatchdogSettings", () => {
  const settings = DEFAULTS;

  it("returns the global default when no override is given", () => {
    expect(resolveWatchdogSettings(settings, undefined, "planning")).toEqual(settings.watchdog.planning);
  });

  it("applies a per-project override for one phase only", () => {
    const overrides: ProjectOverrides = { watchdog: { implementation: { maxAttempts: 5 } } };
    expect(resolveWatchdogSettings(settings, overrides, "implementation")).toEqual({
      graceSeconds: 1800,
      maxAttempts: 5,
      heartbeatSeconds: 1500,
    });
    expect(resolveWatchdogSettings(settings, overrides, "planning")).toEqual(settings.watchdog.planning);
  });
});

describe("resolvePlanningConcurrencyCap", () => {
  const settings = DEFAULTS;

  it("returns the global default when no override is given", () => {
    expect(resolvePlanningConcurrencyCap(settings, undefined)).toBe(3);
  });

  it("returns a per-project override when given", () => {
    expect(resolvePlanningConcurrencyCap(settings, { concurrency: { planning: 1 } })).toBe(1);
  });
});

describe("resolvePermissionProfilePath", () => {
  const settings = DEFAULTS;

  it("returns the global Claude default when no override is given", () => {
    expect(resolvePermissionProfilePath(settings, undefined, "claude")).toBe(
      "~/.config/ai-intake-mcp/permissions/claude.json",
    );
  });

  it("applies a per-project Claude override", () => {
    const overrides: ProjectOverrides = { permissionProfile: "/custom/claude.json" };
    expect(resolvePermissionProfilePath(settings, overrides, "claude")).toBe("/custom/claude.json");
  });

  it("ignores permissionProfile for Gemini — machine-global by tier, decision #9", () => {
    const overrides: ProjectOverrides = { permissionProfile: "/custom/gemini.toml" };
    expect(resolvePermissionProfilePath(settings, overrides, "gemini")).toBe(
      "~/.gemini/policies/ai-intake-mcp-headless.toml",
    );
  });
});
