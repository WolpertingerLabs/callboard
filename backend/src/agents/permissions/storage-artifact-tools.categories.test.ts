/**
 * Permission gates for the twelve storage/artifact tools.
 *
 * They are Callboard tools, so every engine decides them from the shared gate
 * table (callboardToolPolicy.ts) — pi under their bare names, Claude Code as
 * `mcp__callboard-tools__<name>`. The categories are the ones pi pinned before
 * the table existed; `source_path` additionally needs `fileRead`, because it
 * copies any file the callboard process can read.
 */
import { describe, expect, it } from "vitest";
import { callboardToolGate, callboardToolGateByBareName, claudeCallboardGate } from "./callboardToolPolicy.js";
import { getCallboardGateResolver } from "./categorizers.js";

const EXPECTED = {
  list_storage_keys: ["fileRead"],
  list_storage_items: ["fileRead"],
  read_storage_item: ["fileRead"],
  list_artifacts: ["fileRead"],
  read_artifact: ["fileRead"],
  render_artifact: ["fileRead"],
  create_storage_key: ["fileWrite"],
  save_storage_item: ["fileWrite"],
  delete_storage_item: ["fileWrite"],
  delete_storage_key: ["fileWrite"],
  save_artifact: ["fileWrite"],
  delete_artifact: ["fileWrite"],
} as const;

const NAMES = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

describe("storage/artifact tool gates", () => {
  it.each(NAMES)("%s: the same gate on every engine", (name) => {
    expect(callboardToolGate("callboard-tools", name, {})).toEqual(EXPECTED[name]);
    expect(callboardToolGateByBareName(name, {})).toEqual(EXPECTED[name]);
    expect(getCallboardGateResolver("pi")(name, {})).toEqual(EXPECTED[name]);
    expect(claudeCallboardGate(`mcp__callboard-tools__${name}`, {})).toEqual(EXPECTED[name]);
    expect(getCallboardGateResolver("claude-code")(`mcp__callboard-tools__${name}`, {})).toEqual(EXPECTED[name]);
  });

  it.each(["save_storage_item", "save_artifact"])("%s with source_path also needs fileRead", (name) => {
    expect(callboardToolGateByBareName(name, { source_path: "/etc/passwd" })).toEqual(["fileWrite", "fileRead"]);
  });
});
