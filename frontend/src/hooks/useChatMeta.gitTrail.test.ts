import { describe, expect, it } from "vitest";
import { parseChatMeta } from "./useChatMeta";

describe("parseChatMeta — hasGitTrail", () => {
  it("is true once the trail has recorded a branch", () => {
    expect(parseChatMeta(JSON.stringify({ gitTrail: [{ cwd: "/r", repoPath: "/r", branch: "a", firstSeen: "t", lastSeen: "t" }] })).hasGitTrail).toBe(true);
  });

  it.each([["{}"], [JSON.stringify({ gitTrail: [] })], [JSON.stringify({ gitTrail: "nope" })], ["not json"]])("is absent for %s", (metadata) => {
    expect(parseChatMeta(metadata).hasGitTrail).toBeUndefined();
  });
});
