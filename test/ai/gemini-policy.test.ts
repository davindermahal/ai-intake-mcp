import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGeminiPolicyToml, syncGeminiPolicy } from "../../src/ai/gemini-policy.js";

describe("buildGeminiPolicyToml", () => {
  const toml = buildGeminiPolicyToml();

  it("denies git push", () => {
    expect(toml).toMatch(/commandPrefix = "git push"/);
    expect(toml).toMatch(/decision = "deny"/);
  });

  it("scopes every rule to headless-only via interactive = false", () => {
    const ruleBlocks = toml.split("[[rule]]").slice(1);
    expect(ruleBlocks.length).toBeGreaterThan(0);
    for (const block of ruleBlocks) {
      expect(block).toMatch(/interactive = false/);
    }
  });

  it("is valid, parseable TOML rule syntax (well-formed key = value pairs)", () => {
    const ruleBlocks = toml.split("[[rule]]").slice(1);
    for (const block of ruleBlocks) {
      expect(block).toMatch(/toolName = "[^"]+"/);
      expect(block).toMatch(/priority = \d+/);
    }
  });
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-gemini-policy-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("syncGeminiPolicy", () => {
  it("writes the policy file to the given destination path", () => {
    const destPath = join(dir, "policies", "ai-intake-mcp-headless.toml");
    const result = syncGeminiPolicy(destPath);
    expect(result.path).toBe(destPath);
    expect(readFileSync(destPath, "utf8")).toBe(buildGeminiPolicyToml());
  });

  it("is idempotent — re-syncing produces byte-identical content", () => {
    const destPath = join(dir, "policies", "ai-intake-mcp-headless.toml");
    syncGeminiPolicy(destPath);
    const first = readFileSync(destPath, "utf8");
    syncGeminiPolicy(destPath);
    const second = readFileSync(destPath, "utf8");
    expect(second).toBe(first);
  });

  it("creates the destination directory if it doesn't exist yet", () => {
    const destPath = join(dir, "nested", "dir", "ai-intake-mcp-headless.toml");
    syncGeminiPolicy(destPath);
    expect(readFileSync(destPath, "utf8")).toContain("interactive = false");
  });
});
