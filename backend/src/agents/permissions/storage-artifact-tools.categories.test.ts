/**
 * Permission categories for the twelve storage/artifact tools, on every
 * name-based categorizer that sees them.
 *
 * Cline and pi receive callboard tools bare (`extraTools` / `customTools`) and
 * pin every one in `EXACT_CATEGORIES`, so the category is a decision rather
 * than a tokenizer accident. ACP has no exact table — it is tokens-only on the
 * full `mcp__callboard-tools__<name>` label — so its answers are measured here,
 * not assumed.
 */
import { describe, expect, it } from "vitest";
import { categorizeClineToolName } from "../adapters/cline/permissionAdapter.js";
import { categorizePiToolName } from "../adapters/pi/permissionAdapter.js";
import { categorizeAcpToolName } from "../adapters/acp/permissionAdapter.js";
import { getToolCategorizer } from "./categorizers.js";

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
  it.each(NAMES)("cline: %s", (name) => {
    expect(categorizeClineToolName(name)).toBe(EXPECTED[name]);
    expect(getToolCategorizer("cline")(name)).toBe(EXPECTED[name]);
  });

  it.each(NAMES)("pi: %s", (name) => {
    expect(categorizePiToolName(name)).toBe(EXPECTED[name]);
    expect(getToolCategorizer("pi")(name)).toBe(EXPECTED[name]);
  });

  it("render_artifact is pinned, not inferred: nothing in its name tokenizes", () => {
    // Remove the exact entry and this is what cline/pi would say — which is why
    // the entry exists (the same reason as render_file's).
    expect(categorizeAcpToolName("render_artifact")).toBe("codeExecution");
  });

  it.each(NAMES.filter((n) => n !== "render_artifact"))("acp (full label): %s tokenizes to the same category", (name) => {
    expect(categorizeAcpToolName(`mcp__callboard-tools__${name}`)).toBe(EXPECTED[name]);
    expect(getToolCategorizer("acp")(`mcp__callboard-tools__${name}`)).toBe(EXPECTED[name]);
  });

  it("acp: render_artifact gets the strictest gate — exactly as render_file already does", () => {
    // ACP categorizes only by tokens and has no exact table, so neither render
    // tool is recognised there: both fail closed to codeExecution (they prompt
    // under a codeExecution=ask policy; never silently allowed). Parity with
    // render_file is the property pinned here. Giving ACP an exact table is a
    // change to its permission design, for both tools at once, not a side
    // effect of adding one of them.
    expect(categorizeAcpToolName("mcp__callboard-tools__render_artifact")).toBe("codeExecution");
    expect(categorizeAcpToolName("mcp__callboard-tools__render_artifact")).toBe(categorizeAcpToolName("mcp__callboard-tools__render_file"));
  });
});
