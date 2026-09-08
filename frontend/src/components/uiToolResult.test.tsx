import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ParsedMessage } from "shared";
import ToolCallBubble from "./ToolCallBubble";
import { parseUiToolResult } from "./uiToolResult";

beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const image = {
  type: "render_file",
  url: "https://example.com/smoke.png",
  media_type: "image",
  mime_type: "image/png",
  display_mode: "inline",
  file_size: 0,
  caption: "Smoke image",
};
const canvas = { type: "render_canvas", canvas_id: "smoke-canvas", version: 2, name: "Smoke canvas", content_type: "html" };
function pair(name: string, payload: unknown = image, namespace?: string): [ParsedMessage, ParsedMessage] {
  return [
    { type: "tool_use", role: "assistant", toolUseId: "call-1", toolName: name, toolNamespace: namespace, content: "{}" },
    { type: "tool_result", role: "user", toolUseId: "call-1", content: JSON.stringify(payload) },
  ];
}

describe("trusted UI renderer contract", () => {
  it.each(["render_file", "mcp__callboard-tools__render_file", "callboard-tools__render_file", "callboard-ui__render_file", "mcp__callboard_ui__render_file"])(
    "preserves provider/history alias %s",
    (name) => {
      const [toolUse, toolResult] = pair(name);
      const { container } = render(<ToolCallBubble toolUse={toolUse} toolResult={toolResult} isRunning={false} />);
      expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/files/serve?url=https%3A%2F%2Fexample.com%2Fsmoke.png");
    },
  );
  it.each(["create_canvas", "update_canvas"])("renders native %s via existing CanvasRenderer and remounts identically", (name) => {
    const [toolUse, toolResult] = pair(name, canvas, "mcp__callboard_ui");
    const first = render(<ToolCallBubble toolUse={toolUse} toolResult={toolResult} isRunning={false} />);
    const src = first.container.querySelector("iframe")?.getAttribute("src");
    expect(src).toBe("/api/canvas/smoke-canvas/2");
    first.unmount();
    const second = render(
      <ToolCallBubble toolUse={JSON.parse(JSON.stringify(toolUse))} toolResult={JSON.parse(JSON.stringify(toolResult))} isRunning={false} />,
    );
    expect(second.container.querySelector("iframe")?.getAttribute("src")).toBe(src);
  });
  it.each([
    ["exec", undefined],
    ["functions.exec", undefined],
    ["render_file", "functions"],
    ["render_file", "mcp__third_party"],
    ["mcp__third-party__render_file", undefined],
    ["third-party__render_file", undefined],
    ["mcp__callboard_ui_evil__render_file", undefined],
    ["callboard-ui__render_file", "mcp__third_party"],
    ["mcp__render_file", undefined],
  ])("keeps lookalike %s (%s) generic", (name, namespace) => {
    const [toolUse, toolResult] = pair(name!, image, namespace);
    expect(parseUiToolResult(toolUse, toolResult)).toBeNull();
    const { container } = render(<ToolCallBubble toolUse={toolUse} toolResult={toolResult} isRunning={false} />);
    expect(container.querySelector("img, iframe, audio, video")).toBeNull();
  });
  it.each([
    null,
    { type: "render_file" },
    { ...image, file_size: "zero" },
    { ...image, url: "javascript:alert(1)" },
    { ...image, untrusted: "false" },
    { ...image, file_path: "/also.png" },
    { ...image, file_path: "/also.png", url: "javascript:alert(1)" },
    { ...image, caption: {} },
    { ...image, isError: true },
    { ...image, is_error: true },
    { ...image, media_type: "script" },
    { ...image, display_mode: "other" },
  ])("rejects malformed/failed media payload %#", (payload) => {
    expect(parseUiToolResult(...pair("callboard-ui__render_file", payload))).toBeNull();
  });
  it("keeps invalid JSON, mismatched IDs and failed/malformed canvas generic", () => {
    const [use, result] = pair("callboard-ui__render_file");
    expect(parseUiToolResult(use, { ...result, content: "Error: " + result.content })).toBeNull();
    expect(parseUiToolResult(use, { ...result, toolUseId: "different" })).toBeNull();
    for (const payload of [
      { type: "render_canvas" },
      { ...canvas, version: -1 },
      { ...canvas, version: 1.5 },
      { ...canvas, name: {} },
      { ...canvas, content_type: "script" },
      { ...canvas, isError: true },
    ])
      expect(parseUiToolResult(...pair("callboard-ui__create_canvas", payload))).toBeNull();
  });
  it("retains the untrusted-content warning gate", () => {
    const [toolUse, toolResult] = pair("render_file", { ...image, untrusted: true, untrusted_reason: "Smoke warning" });
    const { container } = render(<ToolCallBubble toolUse={toolUse} toolResult={toolResult} isRunning={false} />);
    expect(container.textContent).toContain("Smoke warning");
    expect(container.querySelector("img")).toBeNull();
  });
});
