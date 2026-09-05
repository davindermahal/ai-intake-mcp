import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAppTagCollision, verifyProjectKeysReachable } from "../../src/automation/registration.js";
import type { ProjectRegistry } from "../../src/automation/registry.js";
import { JiraClient } from "../../src/jira/client.js";
import type { GlobalConfig } from "../../src/config.js";

const config: GlobalConfig = {
  jiraSiteUrl: "https://example.atlassian.net",
  jiraEmail: "bot@example.com",
  jiraApiToken: "test-token",
  trackerNativeStatusInProgress: "In Progress",
  trackerNativeStatusCodeReview: "Code Review",
  jiraCookieBrowser: "chrome",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function issueJson(key: string, labels: string[]) {
  return {
    key,
    fields: {
      summary: "x",
      status: { name: "To Do" },
      description: null,
      comment: { comments: [] },
      labels,
      assignee: null,
    },
  };
}

function makeClient(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({ config, fetchImpl });
}

let parentDir: string;
let repoRoot: string;

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-registration-test-"));
  repoRoot = join(parentDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  mkdirSync(join(repoRoot, ".ai"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".ai", "intake-mcp.json"),
    JSON.stringify({ jiraProjectKeys: ["DAV"], appTag: "app:my-repo" }),
    "utf8",
  );
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

describe("checkAppTagCollision", () => {
  it("is fresh when no ticket carries the tag at all", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));
    const registry: ProjectRegistry = { projects: [] };

    const result = await checkAppTagCollision(makeClient(fetchImpl), "app:my-repo", repoRoot, registry);
    expect(result).toEqual({ outcome: "fresh" });
  });

  it("is an existing-registration when tickets use our vocabulary and the registry already claims this path+tag", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ issues: [issueJson("DAV-1", ["state:plan", "app:my-repo"])] }),
    );
    const registry: ProjectRegistry = {
      projects: [{ path: repoRoot, name: "my-repo", enabled: true, overrides: undefined }],
    };

    const result = await checkAppTagCollision(makeClient(fetchImpl), "app:my-repo", repoRoot, registry);
    expect(result).toEqual({ outcome: "existing-registration" });
  });

  it("is a collision when a ticket carries a foreign state-label vocabulary", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ issues: [issueJson("DAV-1", ["state:ready-for-planning", "app:my-repo"])] }),
    );
    const registry: ProjectRegistry = { projects: [] };

    const result = await checkAppTagCollision(makeClient(fetchImpl), "app:my-repo", repoRoot, registry);
    expect(result.outcome).toBe("collision");
  });

  it("is a collision when the tag is already claimed by a different registered repo path", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ issues: [issueJson("DAV-1", ["state:plan", "app:my-repo"])] }),
    );
    const registry: ProjectRegistry = {
      projects: [{ path: "/somewhere/else", name: "other", enabled: true, overrides: undefined }],
    };

    const result = await checkAppTagCollision(makeClient(fetchImpl), "app:my-repo", repoRoot, registry);
    expect(result.outcome).toBe("collision");
  });

  it("is a collision when our vocabulary matches but nothing in the registry claims the tag", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ issues: [issueJson("DAV-1", ["state:plan", "app:my-repo"])] }),
    );
    const registry: ProjectRegistry = { projects: [] };

    const result = await checkAppTagCollision(makeClient(fetchImpl), "app:my-repo", repoRoot, registry);
    expect(result.outcome).toBe("collision");
  });

  it("fails closed when the Jira query itself fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const registry: ProjectRegistry = { projects: [] };

    const result = await checkAppTagCollision(makeClient(fetchImpl), "app:my-repo", repoRoot, registry);
    expect(result.outcome).toBe("query-failed");
  });
});

describe("verifyProjectKeysReachable", () => {
  it("is reachable when the query succeeds", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));
    const result = await verifyProjectKeysReachable(makeClient(fetchImpl), ["DAV"]);
    expect(result).toEqual({ reachable: true });
  });

  it("is not reachable when the query fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 404 }));
    const result = await verifyProjectKeysReachable(makeClient(fetchImpl), ["NOPE"]);
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });
});
