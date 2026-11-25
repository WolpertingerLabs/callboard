import { describe, it, expect } from "vitest";
import { partitionStaged, splitNulPaths } from "./lint-staged.mjs";

describe("partitionStaged", () => {
  it("sends drawlatch src to drawlatch's config, relative to its directory", () => {
    expect(partitionStaged(["packages/drawlatch/src/remote/server.ts", "backend/src/index.ts"])).toEqual({
      root: ["backend/src/index.ts"],
      drawlatch: ["src/remote/server.ts"],
    });
  });

  it("skips drawlatch files its own lint does not cover, and non-JS files", () => {
    const staged = [
      "packages/drawlatch/frontend/src/App.tsx",
      "packages/drawlatch/bin/drawlatch.js",
      "packages/drawlatch/src/connections/github.json",
      "README.md",
    ];
    expect(partitionStaged(staged)).toEqual({ root: [], drawlatch: [] });
  });

  it("is empty for nothing staged", () => {
    expect(partitionStaged([])).toEqual({ root: [], drawlatch: [] });
  });
});

describe("splitNulPaths", () => {
  it("keeps non-ASCII and space-bearing paths intact (git -z output is unquoted)", () => {
    const out = "backend/src/café.ts\0packages/drawlatch/src/naïve file.ts\0";
    expect(splitNulPaths(out)).toEqual(["backend/src/café.ts", "packages/drawlatch/src/naïve file.ts"]);
    expect(partitionStaged(splitNulPaths(out))).toEqual({ root: ["backend/src/café.ts"], drawlatch: ["src/naïve file.ts"] });
  });

  it("is empty for no output", () => {
    expect(splitNulPaths("")).toEqual([]);
  });
});
