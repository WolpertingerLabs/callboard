// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ParsedMessage } from "shared";
import ToolCallBubble from "./ToolCallBubble";
import { parseUiToolResult } from "./uiToolResult";

/**
 * `render_artifact` through the real UI-tool registry.
 * Recognition goes through the unstubbed `callboardUiTool()` and
 * `CALLBOARD_UI_TOOLS`; the strict validation branch itself is covered in
 * `uiToolResult.artifactBranch.test.ts`.
 */

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

const artifact = {
  type: "render_artifact",
  artifact_id: "cramhouse",
  version: 2,
  name: "Cramhouse",
  content_type: "html",
  storage_key: "birds",
  storage_access: "read",
};

function pair(name: string, payload: unknown = artifact, namespace?: string): [ParsedMessage, ParsedMessage] {
  return [
    { type: "tool_use", role: "assistant", toolUseId: "call-1", toolName: name, toolNamespace: namespace, content: "{}" },
    { type: "tool_result", role: "user", toolUseId: "call-1", content: JSON.stringify(payload) },
  ];
}

describe("render_artifact via the real CALLBOARD_UI_TOOLS", () => {
  it.each(["render_artifact", "mcp__callboard-tools__render_artifact", "callboard-tools__render_artifact", "callboard-ui__render_artifact"])(
    "%s renders through ArtifactRenderer",
    (name) => {
      const [toolUse, toolResult] = pair(name);
      expect(parseUiToolResult(toolUse, toolResult)).toEqual(artifact);
      const { container } = render(<ToolCallBubble toolUse={toolUse} toolResult={toolResult} isRunning={false} />);
      const frame = container.querySelector("iframe");
      expect(frame?.getAttribute("src")).toBe("/api/artifacts/cramhouse/versions/2/render");
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    },
  );

  it("a foreign namespace stays generic", () => {
    expect(parseUiToolResult(...pair("render_artifact", artifact, "mcp__third_party"))).toBeNull();
  });
});
