import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../src/index.js";

// Verifies the real production wiring (every tool/prompt/resource this project defines is actually
// registered, with the schema/description it's supposed to have) without ever reaching the real
// stdio connect in src/index.ts (guarded behind isMainModule()) or any tool handler — listing over
// an in-memory transport only enumerates registered metadata, so this never touches real Jira
// credentials (hardening-phase plan, decision #4's index.ts spike: this approach turned out to be
// practical once the stdio-connect side effect was gated behind isMainModule()).

let client: Client;

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
});

describe("ai-intake-mcp server wiring", () => {
  it("registers every tool this project defines", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "approve_plan",
        "health_check",
        "implement_ticket",
        "tracker_add_comment",
        "tracker_create_issue",
        "tracker_get_issue",
        "tracker_transition",
        "worktree_create",
        "worktree_remove",
        "write_repo_config",
      ].sort(),
    );
  });

  it("marks worktree_remove as destructive and the others as not", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.worktree_remove?.annotations?.destructiveHint).toBe(true);
    expect(byName.approve_plan?.annotations?.destructiveHint).toBe(false);
  });

  it("registers both prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["implement_ticket", "plan_ticket"]);
  });

  it("registers all three docs resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(
      ["docs://implementation-procedure", "docs://planning-procedure", "docs://ticket-states"].sort(),
    );
  });

  it("serves a doc resource's real file content", async () => {
    const result = await client.readResource({ uri: "docs://planning-procedure" });
    expect(result.contents[0]?.text).toContain("# Planning procedure");
  });

  it("tracker_transition's state enum excludes plan and implement", async () => {
    const { tools } = await client.listTools();
    const transition = tools.find((t) => t.name === "tracker_transition");
    const stateEnum = (transition?.inputSchema.properties as Record<string, { enum?: string[] }>)?.state?.enum;
    expect(stateEnum).toEqual(["needs-input", "review", "working", "verify", "problem"]);
  });
});
