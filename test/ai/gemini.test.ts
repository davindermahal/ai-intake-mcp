import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { launchGemini } = await import("../../src/ai/gemini.js");
const { readMarker } = await import("../../src/automation/markers.js");

let dir: string;
let promptPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-gemini-adapter-test-"));
  promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, "Author or refine the plan.", "utf8");
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ pid: 9999, unref: vi.fn() });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("launchGemini", () => {
  it("spawns `gemini -p <prompt>` detached in the worktree, with no --settings-equivalent flag", () => {
    const result = launchGemini({
      projectName: "my-app",
      ticketKey: "DAV-6",
      phase: "planning",
      promptPath,
      worktreePath: join(dir, "worktree"),
      permissionProfilePath: "~/.gemini/policies/ai-intake-mcp-headless.toml",
      logDir: join(dir, "logs"),
      attempts: 1,
      stateRoot: dir,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "gemini",
      ["-p", "Author or refine the plan."],
      expect.objectContaining({ cwd: join(dir, "worktree"), detached: true }),
    );
    expect(result.pid).toBe(9999);
    expect(result.logPath).toBe(join(dir, "logs", "DAV-6.log"));
  });

  it("appends -m when a model override is given", () => {
    launchGemini({
      projectName: "my-app",
      ticketKey: "DAV-6",
      phase: "planning",
      promptPath,
      worktreePath: join(dir, "worktree"),
      permissionProfilePath: "~/.gemini/policies/ai-intake-mcp-headless.toml",
      model: "gemini-2.5-pro",
      logDir: join(dir, "logs"),
      attempts: 1,
      stateRoot: dir,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "gemini",
      ["-p", "Author or refine the plan.", "-m", "gemini-2.5-pro"],
      expect.anything(),
    );
  });

  it("writes the running-slot marker with the launched pid", () => {
    launchGemini({
      projectName: "my-app",
      ticketKey: "DAV-6",
      phase: "implementation",
      promptPath,
      worktreePath: join(dir, "worktree"),
      permissionProfilePath: "~/.gemini/policies/ai-intake-mcp-headless.toml",
      logDir: join(dir, "logs"),
      attempts: 1,
      stateRoot: dir,
    });

    const marker = readMarker("my-app", "DAV-6", dir);
    expect(marker).toMatchObject({ ticketKey: "DAV-6", phase: "implementation", pid: 9999 });
  });
});
