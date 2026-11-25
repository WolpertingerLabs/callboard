import { describe, it, expect } from "vitest";
import { partitionStaged } from "./lint-staged.mjs";

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
