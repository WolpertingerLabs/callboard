/**
 * Permission categories for the twelve storage/artifact tools, on every
 * name-based categorizer that sees them.
 *
 * pi receives callboard tools bare (`customTools`) and
 * pins every one in `EXACT_CATEGORIES`, so the category is a decision rather
 * than a tokenizer accident. A tokens-only categorizer (no exact table, the way
 * the retired ACP adapter worked) sees the full `mcp__callboard-tools__<name>`
 * label, so its answers are measured here as generic coverage, not assumed.
 */
import { describe, expect, it } from "vitest";
import { categorizePiToolName } from "../adapters/pi/permissionAdapter.js";
import { getToolCategorizer } from "./categorizers.js";
import { makeNameCategorizer } from "./nameCategorizer.js";

/** Tokens only, no exact table. */
const categorizeByTokens = makeNameCategorizer();

const EXPECTED = {
  list_storage_keys: "fileRead",
  list_storage_items: "fileRead",
  read_storage_item: "fileRead",
  list_artifacts: "fileRead",
  read_artifact: "fileRead",
  render_artifact: "fileRead",
  create_storage_key: "fileWrite",
  save_storage_item: "fileWrite",
  delete_storage_item: "fileWrite",
  delete_storage_key: "fileWrite",
  save_artifact: "fileWrite",
  delete_artifact: "fileWrite",
} as const;

const NAMES = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

describe("storage/artifact tool categories", () => {
  it.each(NAMES)("pi: %s", (name) => {
    expect(categorizePiToolName(name)).toBe(EXPECTED[name]);
    expect(getToolCategorizer("pi")(name)).toBe(EXPECTED[name]);
  });

  it("render_artifact is pinned, not inferred: nothing in its name tokenizes", () => {
    // Remove the exact entry and this is what pi would say — which is why
    // the entry exists (the same reason as render_file's).
    expect(categorizeByTokens("render_artifact")).toBe("codeExecution");
  });

  it.each(NAMES.filter((n) => n !== "render_artifact"))("tokens only (full label): %s tokenizes to the same category", (name) => {
    expect(categorizeByTokens(`mcp__callboard-tools__${name}`)).toBe(EXPECTED[name]);
  });

  it("tokens only: render_artifact gets the strictest gate — exactly as render_file already does", () => {
    // With no exact table neither render tool is recognised: both fail closed
    // to codeExecution (they prompt under a codeExecution=ask policy; never
    // silently allowed). Parity with render_file is the property pinned here.
    expect(categorizeByTokens("mcp__callboard-tools__render_artifact")).toBe("codeExecution");
    expect(categorizeByTokens("mcp__callboard-tools__render_artifact")).toBe(categorizeByTokens("mcp__callboard-tools__render_file"));
  });
});
