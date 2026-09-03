import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IMPLEMENTATION_CONCURRENCY_CAP,
  canDispatchImplementation,
  canDispatchPlanning,
  countMarkersByPhase,
  deleteMarker,
  listMarkers,
  readMarker,
  writeMarker,
  type WorkerMarker,
} from "../../src/automation/markers.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "ai-intake-mcp-markers-test-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function marker(overrides: Partial<WorkerMarker> = {}): WorkerMarker {
  return {
    ticketKey: "DAV-1",
    phase: "planning",
    pid: 12345,
    launchedAt: "2026-09-02T00:00:00.000Z",
    lastHeartbeatAt: "2026-09-02T00:00:00.000Z",
    progressReadPosition: 0,
    attempts: 1,
    escalated: false,
    ...overrides,
  };
}

describe("readMarker / writeMarker / deleteMarker", () => {
  it("returns undefined when no marker exists", () => {
    expect(readMarker("my-app", "DAV-1", stateRoot)).toBeUndefined();
  });

  it("round-trips a written marker", () => {
    writeMarker("my-app", marker(), stateRoot);
    expect(readMarker("my-app", "DAV-1", stateRoot)).toEqual(marker());
  });

  it("deleteMarker removes it, and is idempotent when already gone", () => {
    writeMarker("my-app", marker(), stateRoot);
    deleteMarker("my-app", "DAV-1", stateRoot);
    expect(readMarker("my-app", "DAV-1", stateRoot)).toBeUndefined();
    expect(() => deleteMarker("my-app", "DAV-1", stateRoot)).not.toThrow();
  });

  it("overwrites an existing marker for the same ticket", () => {
    writeMarker("my-app", marker({ attempts: 1 }), stateRoot);
    writeMarker("my-app", marker({ attempts: 2 }), stateRoot);
    expect(readMarker("my-app", "DAV-1", stateRoot)?.attempts).toBe(2);
  });
});

describe("listMarkers / countMarkersByPhase", () => {
  it("returns an empty list when the project has no workers directory yet", () => {
    expect(listMarkers("my-app", stateRoot)).toEqual([]);
  });

  it("lists every marker file for a project", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1" }), stateRoot);
    writeMarker("my-app", marker({ ticketKey: "DAV-2", phase: "implementation" }), stateRoot);
    const markers = listMarkers("my-app", stateRoot);
    expect(markers.map((m) => m.ticketKey).sort()).toEqual(["DAV-1", "DAV-2"]);
  });

  it("counts markers by phase", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1", phase: "planning" }), stateRoot);
    writeMarker("my-app", marker({ ticketKey: "DAV-2", phase: "planning" }), stateRoot);
    writeMarker("my-app", marker({ ticketKey: "DAV-3", phase: "implementation" }), stateRoot);
    expect(countMarkersByPhase("my-app", "planning", stateRoot)).toBe(2);
    expect(countMarkersByPhase("my-app", "implementation", stateRoot)).toBe(1);
  });

  it("never mixes counts between two different projects", () => {
    writeMarker("app-a", marker({ ticketKey: "DAV-1", phase: "planning" }), stateRoot);
    writeMarker("app-b", marker({ ticketKey: "DAV-1", phase: "planning" }), stateRoot);
    writeMarker("app-b", marker({ ticketKey: "DAV-2", phase: "planning" }), stateRoot);
    expect(countMarkersByPhase("app-a", "planning", stateRoot)).toBe(1);
    expect(countMarkersByPhase("app-b", "planning", stateRoot)).toBe(2);
  });
});

describe("canDispatchPlanning", () => {
  it("allows dispatch while under the cap", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1" }), stateRoot);
    expect(canDispatchPlanning("my-app", 3, stateRoot)).toBe(true);
  });

  it("refuses dispatch once at the cap", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1" }), stateRoot);
    writeMarker("my-app", marker({ ticketKey: "DAV-2" }), stateRoot);
    writeMarker("my-app", marker({ ticketKey: "DAV-3" }), stateRoot);
    expect(canDispatchPlanning("my-app", 3, stateRoot)).toBe(false);
  });

  it("ignores an escalated marker — it no longer occupies a slot", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1", escalated: true }), stateRoot);
    writeMarker("my-app", marker({ ticketKey: "DAV-2", escalated: true }), stateRoot);
    writeMarker("my-app", marker({ ticketKey: "DAV-3", escalated: true }), stateRoot);
    expect(canDispatchPlanning("my-app", 3, stateRoot)).toBe(true);
  });

  it("does not count an implementation marker against the planning cap", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1", phase: "implementation" }), stateRoot);
    expect(canDispatchPlanning("my-app", 1, stateRoot)).toBe(true);
  });
});

describe("canDispatchImplementation", () => {
  it("is a fixed cap of 1, not configurable", () => {
    expect(IMPLEMENTATION_CONCURRENCY_CAP).toBe(1);
  });

  it("allows dispatch when no implementation worker is in flight", () => {
    expect(canDispatchImplementation("my-app", stateRoot)).toBe(true);
  });

  it("refuses a second concurrent implementation dispatch for the same project", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1", phase: "implementation" }), stateRoot);
    expect(canDispatchImplementation("my-app", stateRoot)).toBe(false);
  });

  it("ignores an escalated implementation marker", () => {
    writeMarker("my-app", marker({ ticketKey: "DAV-1", phase: "implementation", escalated: true }), stateRoot);
    expect(canDispatchImplementation("my-app", stateRoot)).toBe(true);
  });

  it("keeps two projects' implementation slots independent", () => {
    writeMarker("app-a", marker({ ticketKey: "DAV-1", phase: "implementation" }), stateRoot);
    expect(canDispatchImplementation("app-a", stateRoot)).toBe(false);
    expect(canDispatchImplementation("app-b", stateRoot)).toBe(true);
  });
});
