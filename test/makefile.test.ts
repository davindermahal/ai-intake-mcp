import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contradictedSkipTargets, makefileTargetNames } from "../src/makefile.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-intake-mcp-makefile-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeMakefile(content: string): string {
  const path = join(dir, "Makefile");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("makefileTargetNames", () => {
  it("extracts plain target names", () => {
    const path = writeMakefile("build:\n\tnpm run build\n\ntest:\n\tnpm test\n");
    expect(makefileTargetNames(path)).toEqual(new Set(["build", "test"]));
  });

  it("ignores .PHONY", () => {
    const path = writeMakefile(".PHONY: build test\n\nbuild:\n\tnpm run build\n");
    expect(makefileTargetNames(path)).toEqual(new Set(["build"]));
  });

  it("ignores variable assignments (:=)", () => {
    const path = writeMakefile('IMAGE := my-image\nRUN   := docker run $(IMAGE)\n\nbuild: image\n\techo hi\n');
    expect(makefileTargetNames(path)).toEqual(new Set(["build"]));
  });

  it("ignores recipe lines and comments", () => {
    const path = writeMakefile("# a comment: not a target\nbuild:\n\techo 'not: a target either'\n");
    expect(makefileTargetNames(path)).toEqual(new Set(["build"]));
  });

  it("returns an empty set when there is no Makefile", () => {
    expect(makefileTargetNames(join(dir, "nonexistent-Makefile"))).toEqual(new Set());
  });
});

describe("contradictedSkipTargets", () => {
  it("returns targets that are both declared skipped and defined in the Makefile", () => {
    const path = writeMakefile("build:\n\techo build\n\nlint:\n\techo lint\n");
    expect(contradictedSkipTargets(path, ["lint", "test"])).toEqual(["lint"]);
  });

  it("returns an empty array when no declared skip target is actually defined", () => {
    const path = writeMakefile("build:\n\techo build\n");
    expect(contradictedSkipTargets(path, ["lint", "test"])).toEqual([]);
  });
});
