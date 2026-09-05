import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../src/config.js";
import { JiraClient } from "../../src/jira/client.js";
import type { ProjectRegistry } from "../../src/automation/registry.js";
import type { RepoConfig } from "../../src/repo-context.js";

// registerResolvedProject writes through saveProjectRegistry, which touches the real
// ~/.config/ai-intake-mcp/projects.json — same seam/rationale as registry.test.ts's mock.
const { readFileSyncMock, writeFileSyncMock, mkdirSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));
vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

const { registerResolvedProject } = await import("../../src/automation/registration.js");

const config: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

const repoConfig: RepoConfig = { jiraProjectKeys: ["DAV"], appTag: "app:my-repo" };
const repoRoot = "/home/dev/my-repo";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch): JiraClient {
  // sleepImpl is a no-op: this suite doesn't exercise retry/backoff itself (see client.test.ts for
  // that), so a real 5xx response here shouldn't incur real retry delays.
  return new JiraClient({ config, fetchImpl, sleepImpl: async () => {} });
}

beforeEach(() => {
  readFileSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  mkdirSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerResolvedProject", () => {
  it("registers a fresh tag: writes the registry entry and confirms reachability", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("labels")) return jsonResponse({ issues: [] }); // collision check
      return jsonResponse({ issues: [] }); // reachability check
    });
    const registry: ProjectRegistry = { projects: [] };

    const result = await registerResolvedProject(makeClient(fetchImpl), registry, {
      repoRoot,
      repoConfig,
      displayName: "My Repo",
      enable: true,
    });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") throw new Error("unreachable");
    expect(result.collision.outcome).toBe("fresh");
    expect(result.entry).toEqual({ path: repoRoot, name: "My Repo", enabled: true, overrides: undefined });
    expect(result.reachability).toEqual({ reachable: true });

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [, written] = writeFileSyncMock.mock.calls[0] as [string, string];
    expect(JSON.parse(written)).toEqual({
      projects: [{ path: repoRoot, name: "My Repo", enabled: true }],
    });
  });

  it("defaults displayName to basename(repoRoot) and enable to true when omitted", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));
    const registry: ProjectRegistry = { projects: [] };

    const result = await registerResolvedProject(makeClient(fetchImpl), registry, { repoRoot, repoConfig });

    if (result.status !== "registered") throw new Error("unreachable");
    expect(result.entry).toEqual({ path: repoRoot, name: "my-repo", enabled: true, overrides: undefined });
  });

  it("refuses without writing the registry when the collision check finds a real collision", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        issues: [
          {
            key: "DAV-1",
            fields: {
              summary: "x",
              status: { name: "To Do" },
              description: null,
              comment: { comments: [] },
              labels: ["state:plan", "app:my-repo"],
              assignee: null,
            },
          },
        ],
      }),
    );
    const registry: ProjectRegistry = { projects: [] };

    const result = await registerResolvedProject(makeClient(fetchImpl), registry, { repoRoot, repoConfig });

    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.collision.outcome).toBe("collision");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("refuses without writing the registry when the collision check's Jira query fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const registry: ProjectRegistry = { projects: [] };

    const result = await registerResolvedProject(makeClient(fetchImpl), registry, { repoRoot, repoConfig });

    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.collision.outcome).toBe("query-failed");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("still reports 'registered' with reachability.reachable=false when the reachability check fails", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse({ issues: [] }); // collision check: fresh
      return new Response("boom", { status: 404 }); // reachability check fails
    });
    const registry: ProjectRegistry = { projects: [] };

    const result = await registerResolvedProject(makeClient(fetchImpl), registry, { repoRoot, repoConfig });

    if (result.status !== "registered") throw new Error("unreachable");
    expect(result.reachability.reachable).toBe(false);
    expect(result.reachability.error).toBeDefined();
    // The registry write already happened before the reachability check runs.
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });
});
