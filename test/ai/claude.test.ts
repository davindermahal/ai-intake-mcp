import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Adapters are tested with node:child_process mocked (decision #21) — never a real CLI invocation.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { launchClaude } = await import("../../src/ai/claude.js");
const { readMarker } = await import("../../src/automation/markers.js");

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
  it("spawns `claude -p <prompt> --settings <path>` detached in the worktree", () => {
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

    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["-p", "Implement the approved plan.", "--settings", "/config/permissions/claude.json"],
      expect.objectContaining({ cwd: join(dir, "worktree"), detached: true }),
    );
    expect(result.pid).toBe(4242);
    expect(result.logPath).toBe(join(dir, "logs", "DAV-5.log"));
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
