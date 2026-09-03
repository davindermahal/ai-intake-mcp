import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { launchGemini } = await import("../../src/ai/gemini.js");
const { readMarker } = await import("../../src/automation/markers.js");
const { DEFAULT_STATE_ROOT } = await import("../../src/automation/result-file.js");

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
  it("spawns `gemini -p <prompt> --skip-trust --include-directories <stateRoot>` detached in the worktree, with no --settings-equivalent flag", () => {
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

    // --skip-trust (not a --settings-equivalent flag) is required on every launch: a worktree is a
    // brand-new directory gemini-cli has never seen, so without it the CLI refuses to run headlessly
    // at all (confirmed live during headless-automation QA Phase B, gemini-cli 0.58.0).
    // --include-directories: gemini-cli's equivalent of Claude's --add-dir, needed for the same
    // reason (confirmed live for Claude during Phase E — headless file access is confined to the
    // worktree by default, and context/progress/result files live under the state tree instead).
    expect(spawnMock).toHaveBeenCalledWith(
      "gemini",
      ["-p", "Author or refine the plan.", "--skip-trust", "--include-directories", dir],
      expect.objectContaining({ cwd: join(dir, "worktree"), detached: true }),
    );
    expect(result.pid).toBe(9999);
    expect(result.logPath).toBe(join(dir, "logs", "DAV-6.log"));
  });

  it("falls back to the real DEFAULT_STATE_ROOT for --include-directories when no stateRoot override is given", () => {
    const realMarkerPath = join(DEFAULT_STATE_ROOT, "my-app", "workers", "DAV-6.json");
    try {
      launchGemini({
        projectName: "my-app",
        ticketKey: "DAV-6",
        phase: "planning",
        promptPath,
        worktreePath: join(dir, "worktree"),
        permissionProfilePath: "~/.gemini/policies/ai-intake-mcp-headless.toml",
        logDir: join(dir, "logs"),
        attempts: 1,
        // no stateRoot — the real production path (every other test in this file overrides it)
      });

      const args = spawnMock.mock.calls[0]?.[1] as string[];
      expect(args[args.indexOf("--include-directories") + 1]).toBe(DEFAULT_STATE_ROOT);
    } finally {
      rmSync(realMarkerPath, { force: true });
    }
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
      ["-p", "Author or refine the plan.", "--skip-trust", "--include-directories", dir, "-m", "gemini-2.5-pro"],
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
