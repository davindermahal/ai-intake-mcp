import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// registry.ts reads a hardcoded ~/.config/ai-intake-mcp/projects.json path — same seam/rationale
// as test/config.test.ts's mock of node:fs's readFileSync.
const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: readFileSyncMock }));

const { loadProjectRegistry } = await import("../../src/automation/registry.js");

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

describe("loadProjectRegistry", () => {
  it("returns an empty registry when projects.json doesn't exist", () => {
    expect(loadProjectRegistry()).toEqual({ projects: [] });
  });

  it("rethrows a non-ENOENT error reading the file", () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("permission denied");
    });
    expect(() => loadProjectRegistry()).toThrow(/permission denied/);
  });

  it("throws on malformed top-level JSON (missing projects array)", () => {
    readFileSyncMock.mockReturnValue("{}");
    expect(() => loadProjectRegistry()).toThrow(/malformed/);
  });

  it("throws when a project entry has no path", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ projects: [{ name: "x" }] }));
    expect(() => loadProjectRegistry()).toThrow(/path must be a non-empty string/);
  });

  it("defaults name to basename(path) and enabled to true", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ projects: [{ path: "/home/you/dev/my-app" }] }));
    expect(loadProjectRegistry()).toEqual({
      projects: [{ path: "/home/you/dev/my-app", name: "my-app", enabled: true, overrides: undefined }],
    });
  });

  it("reads explicit name and enabled: false", () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ projects: [{ path: "/x/my-app", name: "renamed", enabled: false }] }),
    );
    const registry = loadProjectRegistry();
    expect(registry.projects[0]).toMatchObject({ name: "renamed", enabled: false });
  });

  it("passes the overrides bag through unvalidated (open bag, decision #7)", () => {
    const overrides = {
      concurrency: { planning: 1 },
      watchdog: { implementation: { maxAttempts: 5 } },
      someFutureKey: { anything: true },
    };
    readFileSyncMock.mockReturnValue(JSON.stringify({ projects: [{ path: "/x/my-app", overrides }] }));
    expect(loadProjectRegistry().projects[0]?.overrides).toEqual(overrides);
  });

  it("throws when overrides is present but not an object", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ projects: [{ path: "/x/my-app", overrides: "nope" }] }));
    expect(() => loadProjectRegistry()).toThrow(/overrides must be an object/);
  });

  it("loads multiple projects independently", () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ projects: [{ path: "/x/a" }, { path: "/x/b", enabled: false }] }),
    );
    const registry = loadProjectRegistry();
    expect(registry.projects.map((p) => p.name)).toEqual(["a", "b"]);
    expect(registry.projects.map((p) => p.enabled)).toEqual([true, false]);
  });
});
