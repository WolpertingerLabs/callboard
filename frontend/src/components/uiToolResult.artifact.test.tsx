// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ParsedMessage } from "shared";
import { isCallboardUiTool } from "shared/types/callboard-ui-tools.js";
import ToolCallBubble from "./ToolCallBubble";
import { parseUiToolResult } from "./uiToolResult";

/**
 * `render_artifact` through the real UI-tool registry.
 *
 * NEEDS THE BACKEND MERGE. Recognition goes through `callboardUiTool()`, which
 * only knows `render_artifact` once the backend branch adds it to
 * `CALLBOARD_UI_TOOLS` in shared/. Until then this whole file is skipped — the
 * `describe.skipIf` below is the one switch, and it turns itself on when the
 * registry gains the name. The strict validation branch itself is covered today
 * in `uiToolResult.artifactBranch.test.ts`, which stubs the registry.
 */

const REGISTERED = isCallboardUiTool("render_artifact");

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

describe.skipIf(!REGISTERED)("[needs backend merge] render_artifact via the real CALLBOARD_UI_TOOLS", () => {
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
