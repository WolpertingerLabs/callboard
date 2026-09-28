// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ParsedMessage } from "shared";
import ToolCallBubble from "./ToolCallBubble";
import { parseUiToolResult } from "./uiToolResult";

/**
 * `render_artifact` through the real UI-tool registry.
 * Recognition goes through the unstubbed `callboardUiTool()` and
 * `CALLBOARD_UI_TOOLS`; the strict validation branch itself is covered in
 * `uiToolResult.artifactBranch.test.ts`.
 */

const SHA = "5e".repeat(32);

// The renderer re-checks the result against the artifact as it is now before mounting anything.
vi.mock("../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getArtifact: vi.fn(async () => ({
      id: "cramhouse",
      name: "Cramhouse",
      contentType: "html",
      storageAccess: "readwrite",
      currentVersion: 2,
      created: "c",
      updated: "u",
      versions: [{ version: 2, created: "c", size: 1, sha256: SHA }],
    })),
  };
});

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
  sha256: SHA,
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
    async (name) => {
      const [toolUse, toolResult] = pair(name);
      expect(parseUiToolResult(toolUse, toolResult)).toEqual(artifact);
      const { container } = render(<ToolCallBubble toolUse={toolUse} toolResult={toolResult} isRunning={false} />);
      const frame = await waitFor(() => {
        const f = container.querySelector("iframe");
        if (!f) throw new Error("not mounted yet");
        return f;
      });
      expect(frame.getAttribute("src")).toMatch(/^\/api\/artifacts\/cramhouse\/versions\/2\/render\?bridge=[0-9a-f]{32}$/);
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    },
  );

  it("a foreign namespace stays generic", () => {
    expect(parseUiToolResult(...pair("render_artifact", artifact, "mcp__third_party"))).toBeNull();
  });
});
