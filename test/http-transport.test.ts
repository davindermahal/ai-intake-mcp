import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/index.js";

// Real HTTP round-trip against the MCP_TRANSPORT=http branch (draft plan:
// http-transport-and-v2-sdk-migration.md, open question #4) — this is the project's own
// loopback/origin-validation wiring, not SDK-internal code, so the in-memory-transport coverage in
// index.test.ts doesn't exercise it. Bound to an ephemeral port (127.0.0.1:0) so this never collides
// with a real MCP_HTTP_PORT.

let baseUrl: string;
let close: () => Promise<void>;

beforeEach(async () => {
  const httpServer = createHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  close = () => new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
});

afterEach(async () => {
  await close();
});

function initializeRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
    }),
  };
}

describe("MCP_TRANSPORT=http server", () => {
  it("answers a real HTTP initialize request with the same serverInfo stdio returns", async () => {
    const res = await fetch(baseUrl, initializeRequest());
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    const body = JSON.parse(dataLine!.slice("data: ".length));
    expect(body.result.serverInfo).toEqual({ name: "ai-intake-mcp", version: "0.1.0" });
  });

  it("rejects a request from a non-loopback Origin with 403", async () => {
    const init = initializeRequest();
    init.headers = { ...(init.headers as Record<string, string>), Origin: "https://evil.example.com" };
    const res = await fetch(baseUrl, init);
    expect(res.status).toBe(403);
  });
});
