import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "shared";
import { parseUiToolResult } from "./uiToolResult";

/**
 * The strict `render_artifact` validation branch in `parseUiToolResult`, via
 * the real UI-tool registry. The end-to-end render lives in
 * `uiToolResult.artifact.test.tsx`.
 */

const good = {
  type: "render_artifact",
  artifact_id: "cramhouse",
  version: 1,
  sha256: "0f".repeat(32),
  name: "Cramhouse",
  content_type: "html",
  storage_key: "birds-of-western-europe",
  storage_access: "readwrite",
  caption: "Birds",
  display_mode: "inline",
};

function parse(payload: unknown, name = "render_artifact") {
  const use: ParsedMessage = { type: "tool_use", role: "assistant", toolUseId: "c", toolName: name, content: "{}" };
  const result: ParsedMessage = { type: "tool_result", role: "user", toolUseId: "c", content: JSON.stringify(payload) };
  return parseUiToolResult(use, result);
}

describe("render_artifact result validation", () => {
  it("accepts a complete result unchanged", () => {
    expect(parse(good)).toEqual(good);
  });

  it("accepts the minimal unbound shape", () => {
    const minimal = { type: "render_artifact", artifact_id: "notes", version: 7, name: "Notes", content_type: "markdown", storage_access: "none" };
    expect(parse(minimal)).toEqual(minimal);
  });

  it.each(["html", "svg", "markdown"])("accepts content_type %s", (content_type) => {
    expect(parse({ ...good, content_type })).not.toBeNull();
  });

  it.each([
    ["wrong type tag", { type: "render_canvas" }],
    ["missing artifact_id", { artifact_id: undefined }],
    ["artifact_id with a slash", { artifact_id: "a/../b" }],
    ["uppercase artifact_id", { artifact_id: "Cramhouse" }],
    ["version 0", { version: 0 }],
    ["fractional version", { version: 1.5 }],
    ["string version", { version: "1" }],
    ["sha256 not 64 hex", { sha256: "abc" }],
    ["uppercase sha256", { sha256: "0F".repeat(32) }],
    ["non-string sha256", { sha256: 1 }],
    ["empty name", { name: "" }],
    ["non-string name", { name: 3 }],
    ["image content_type", { content_type: "image" }],
    ["unknown storage_access", { storage_access: "admin" }],
    ["missing storage_access", { storage_access: undefined }],
    ["storage_key traversal", { storage_key: "../etc" }],
    ["uppercase storage_key", { storage_key: "Birds" }],
    ["storage_key '..'", { storage_key: ".." }],
    ["non-string storage_key", { storage_key: 5 }],
    ["access granted with no key", { storage_key: undefined, storage_access: "read" }],
    ["non-string caption", { caption: 1 }],
    ["unknown display_mode", { display_mode: "popup" }],
    ["error envelope", { isError: true }],
  ])("rejects %s", (_label, override) => {
    expect(parse({ ...good, ...override })).toBeNull();
  });

  it("rejects non-JSON and arrays", () => {
    const use: ParsedMessage = { type: "tool_use", role: "assistant", toolUseId: "c", toolName: "render_artifact", content: "{}" };
    expect(parseUiToolResult(use, { type: "tool_result", role: "user", toolUseId: "c", content: "not json" })).toBeNull();
    expect(parseUiToolResult(use, { type: "tool_result", role: "user", toolUseId: "c", content: "[]" })).toBeNull();
  });

  it("a render_artifact payload under a canvas tool name is not an artifact", () => {
    expect(parse(good, "create_canvas")).toBeNull();
  });
});
