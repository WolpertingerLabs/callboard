import { describe, expect, it } from "vitest";
import { parentDir } from "./paths";

describe("parentDir", () => {
  it.each([
    ["/a/b/c", "/a/b"],
    ["/a/b/", "/a"],
    ["/a/b///", "/a"],
    ["  /a/b  ", "/a"],
    ["/a", "/"],
    ["/", "/"],
    ["///", "/"],
  ])("%j → %j", (input, expected) => {
    expect(parentDir(input)).toBe(expected);
  });

  it.each(["", "   ", "a/b", "~/code", undefined, null])("%j has no parent to open", (input) => {
    expect(parentDir(input)).toBeUndefined();
  });
});
