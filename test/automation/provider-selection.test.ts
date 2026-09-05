import { describe, expect, it } from "vitest";
import type { ProjectOverrides } from "../../src/automation/registry.js";
import { resolveProvider } from "../../src/automation/provider-selection.js";
import type { AutomationSettings } from "../../src/automation/settings.js";

const settings: AutomationSettings = {
  watchdog: {
    implementation: { graceSeconds: 1800, maxAttempts: 3, heartbeatSeconds: 1500 },
    planning: { graceSeconds: 600, maxAttempts: 3, heartbeatSeconds: 300 },
  },
  concurrency: { planning: 3 },
  permissions: {
    claude: "~/.config/ai-intake-mcp/permissions/claude.json",
    gemini: "~/.gemini/policies/ai-intake-mcp-headless.toml",
  },
  aiProfiles: { "fast-impl": "gemini:gemini-2.5-pro", "careful-plan": "claude" },
};

describe("resolveProvider", () => {
  it("defaults to Claude with no model override when nothing else applies", () => {
    expect(resolveProvider([], "planning", settings, undefined)).toEqual({ provider: "claude", model: undefined });
  });

  it("resolves an ai-plan-<profile> label to the named profile's provider:model", () => {
    expect(resolveProvider(["ai-plan-fast-impl"], "planning", settings, undefined)).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  it("resolves an ai-impl-<profile> label independently of the planning label", () => {
    const labels = ["ai-plan-careful-plan", "ai-impl-fast-impl"];
    expect(resolveProvider(labels, "planning", settings, undefined)).toEqual({ provider: "claude", model: undefined });
    expect(resolveProvider(labels, "implementation", settings, undefined)).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  it("falls back to a project override's default profile per phase when no ticket label is present", () => {
    const overrides: ProjectOverrides = { aiProfiles: { implementation: "fast-impl" } };
    expect(resolveProvider([], "implementation", settings, overrides)).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    expect(resolveProvider([], "planning", settings, overrides)).toEqual({ provider: "claude", model: undefined });
  });

  it("prefers a ticket label over a project override default", () => {
    const overrides: ProjectOverrides = { aiProfiles: { planning: "fast-impl" } };
    expect(resolveProvider(["ai-plan-careful-plan"], "planning", settings, overrides)).toEqual({
      provider: "claude",
      model: undefined,
    });
  });

  it("throws when a ticket label names a profile that doesn't exist in settings.aiProfiles", () => {
    expect(() => resolveProvider(["ai-plan-unknown"], "planning", settings, undefined)).toThrow(
      /No aiProfile named "unknown"/,
    );
  });

  it("throws when a profile value names an unrecognized provider", () => {
    const badSettings: AutomationSettings = { ...settings, aiProfiles: { bogus: "chatgpt:gpt-5" } };
    expect(() => resolveProvider(["ai-plan-bogus"], "planning", badSettings, undefined)).toThrow(
      /unknown provider "chatgpt"/,
    );
  });
});
