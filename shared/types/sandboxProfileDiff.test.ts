import { describe, expect, it } from "vitest";
import { foldRecipeDiff, recipeLineDiff, recipeReviewDiff } from "./sandboxProfileDiff.js";

const canonical = (setup: string, packages: string[] = ["x11-apps"]) => JSON.stringify({ schema: 1, name: "eyes", packages, setup, gl: "none" }, null, 2);

describe("recipeReviewDiff", () => {
  it("diffs the setup script line by line, and leaves it out of the fields' diff", () => {
    const before = canonical("set -x\necho one\nmkdir -p /opt/profile\n");
    const after = canonical("set -x\necho two\nmkdir -p /opt/profile\n");
    const diff = recipeReviewDiff(before, after);
    expect(diff.setup).toEqual([
      { op: "same", text: "set -x" },
      { op: "remove", text: "echo one" },
      { op: "add", text: "echo two" },
      { op: "same", text: "mkdir -p /opt/profile" },
    ]);
    expect(diff.fields.every((line) => line.op === "same")).toBe(true);
    expect(diff.fields.some((line) => line.text.includes("setup"))).toBe(false);
    // What it replaces: the canonical JSON diff puts the whole script on one line each side.
    const naive = recipeLineDiff(before, after).filter((line) => line.op !== "same");
    expect(naive).toHaveLength(2);
  });
  it("an added or removed script is all adds or all removes, with no phantom empty line", () => {
    expect(recipeReviewDiff(canonical(""), canonical("a\nb\n")).setup).toEqual([
      { op: "add", text: "a" },
      { op: "add", text: "b" },
    ]);
    expect(recipeReviewDiff(canonical("a\n"), canonical("")).setup).toEqual([{ op: "remove", text: "a" }]);
    expect(recipeReviewDiff(canonical(""), canonical("")).setup).toEqual([]);
  });
  it("still diffs the other fields", () => {
    const diff = recipeReviewDiff(canonical("a\n"), canonical("a\n", ["x11-apps", "fonts-dejavu"]));
    expect(diff.setup.every((line) => line.op === "same")).toBe(true);
    expect(diff.fields.filter((line) => line.op === "add").map((line) => line.text.trim())).toEqual(['"x11-apps",', '"fonts-dejavu"']);
  });
});

describe("foldRecipeDiff", () => {
  it("keeps context around changes and folds long unchanged runs", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ op: i === 10 ? ("add" as const) : ("same" as const), text: String(i) }));
    expect(foldRecipeDiff(lines, 2)).toEqual([{ op: "fold", count: 8 }, ...lines.slice(8, 13), { op: "fold", count: 7 }]);
  });
  it("never folds a single line", () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({ op: i === 3 ? ("remove" as const) : ("same" as const), text: String(i) }));
    expect(foldRecipeDiff(lines, 2)).toEqual(lines);
    const same = lines.map((line) => ({ ...line, op: "same" as const }));
    expect(foldRecipeDiff(same)).toEqual([{ op: "fold", count: 5 }]);
  });
});
