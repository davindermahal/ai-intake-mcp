import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Adapters are tested with node:child_process mocked (decision #21) — never a real CLI invocation.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { launchClaude } = await import("../../src/ai/claude.js");
const { readMarker } = await import("../../src/automation/markers.js");
const { DEFAULT_STATE_ROOT } = await import("../../src/automation/result-file.js");

let dir: string;
let promptPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-claude-adapter-test-"));
  promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, "Implement the approved plan.", "utf8");
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("launchClaude", () => {
  it("spawns `claude -p <prompt> --settings <path> --add-dir <stateRoot>` detached in the worktree", () => {
    const result = launchClaude({
      projectName: "my-app",
      ticketKey: "DAV-5",
      phase: "implementation",
      promptPath,
      worktreePath: join(dir, "worktree"),
      permissionProfilePath: "/config/permissions/claude.json",
      logDir: join(dir, "logs"),
      attempts: 1,
      stateRoot: dir,
    });

    // --add-dir is required: -p headless mode confines file tools to the worktree by default, and
    // the worker's context/progress/result files live under the state tree instead (confirmed live
    // during headless-automation QA Phase E — every real worker failed immediately without it).
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["-p", "Implement the approved plan.", "--settings", "/config/permissions/claude.json", "--add-dir", dir],
      expect.objectContaining({ cwd: join(dir, "worktree"), detached: true }),
    );
    expect(result.pid).toBe(4242);
    expect(result.logPath).toBe(join(dir, "logs", "DAV-5.log"));
  });

  it("falls back to the real DEFAULT_STATE_ROOT for --add-dir when no stateRoot override is given", () => {
    // No stateRoot — the real production path (every other test in this file overrides it to a
    // temp dir). launchProvider's writeMarker falls back to the same DEFAULT_STATE_ROOT for its
    // own marker write, so this one real file is cleaned up below rather than left on disk.
    const realMarkerPath = join(DEFAULT_STATE_ROOT, "my-app", "workers", "DAV-5.json");
    try {
      launchClaude({
        projectName: "my-app",
        ticketKey: "DAV-5",
        phase: "implementation",
        promptPath,
        worktreePath: join(dir, "worktree"),
        permissionProfilePath: "/config/permissions/claude.json",
        logDir: join(dir, "logs"),
        attempts: 1,
      });

      const args = spawnMock.mock.calls[0]?.[1] as string[];
      expect(args[args.indexOf("--add-dir") + 1]).toBe(DEFAULT_STATE_ROOT);
    } finally {
      rmSync(realMarkerPath, { force: true });
    }
  });

  it("appends --model when a model override is given", () => {
    launchClaude({
      projectName: "my-app",
      ticketKey: "DAV-5",
      phase: "planning",
      promptPath,
      worktreePath: join(dir, "worktree"),
      permissionProfilePath: "/config/permissions/claude.json",
      model: "claude-opus-5",
      logDir: join(dir, "logs"),
      attempts: 1,
      stateRoot: dir,
    });

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
  });

  it("writes the running-slot marker with the launched pid", () => {
    launchClaude({
      projectName: "my-app",
      ticketKey: "DAV-5",
      phase: "planning",
      promptPath,
      worktreePath: join(dir, "worktree"),
      permissionProfilePath: "/config/permissions/claude.json",
      logDir: join(dir, "logs"),
      attempts: 2,
      stateRoot: dir,
    });

    const marker = readMarker("my-app", "DAV-5", dir);
    expect(marker).toMatchObject({
      ticketKey: "DAV-5",
      phase: "planning",
      pid: 4242,
      attempts: 2,
      escalated: false,
      progressReadPosition: 0,
    });
  });

  it("throws when spawn returns no pid", () => {
    spawnMock.mockReturnValue({ pid: undefined, unref: vi.fn() });
    expect(() =>
      launchClaude({
        projectName: "my-app",
        ticketKey: "DAV-5",
        phase: "planning",
        promptPath,
        worktreePath: join(dir, "worktree"),
        permissionProfilePath: "/config/permissions/claude.json",
        logDir: join(dir, "logs"),
        attempts: 1,
        stateRoot: dir,
      }),
    ).toThrow(/no pid returned/);
  });
});
