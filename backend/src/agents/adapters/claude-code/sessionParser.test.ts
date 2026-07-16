/**
 * Unit tests for the Claude Code JSONL session parser — focused on
 * tool_result image extraction (Read on an image file), which interns the
 * base64 payload into the image store and attaches imageIds so the
 * frontend can render thumbnails instead of a stringified blob.
 */
import { describe, expect, it, vi } from "vitest";
import { parseMessages } from "./sessionParser.js";

vi.mock("../../../services/image-storage.js", () => ({
  storeBase64Image: vi.fn((data: string, mimeType: string) => `img-${mimeType.split("/")[1]}-${data.length}`),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolResultLine(content: any, timestamp = "2026-01-01T10:00:00.000Z") {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content }] },
    timestamp,
  };
}

describe("parseMessages — tool_result image extraction", () => {
  it("interns a base64 image block and attaches its id as imageIds", () => {
    const [msg] = parseMessages([
      toolResultLine([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]),
    ]);
    expect(msg).toMatchObject({
      type: "tool_result",
      toolUseId: "tu-1",
      content: "[Image: image/png]",
      imageIds: ["img-png-12"],
    });
  });

  it("keeps text blocks alongside image placeholders, in order", () => {
    const [msg] = parseMessages([
      toolResultLine([
        { type: "text", text: "before" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abcd" } },
        { type: "text", text: "after" },
      ]),
    ]);
    expect(msg.content).toBe("before\n[Image: image/jpeg]\nafter");
    expect(msg.imageIds).toEqual(["img-jpeg-4"]);
  });

  it("collects multiple images from one tool_result", () => {
    const [msg] = parseMessages([
      toolResultLine([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aa" } },
        { type: "image", source: { type: "base64", media_type: "image/webp", data: "bbbb" } },
      ]),
    ]);
    expect(msg.imageIds).toEqual(["img-png-2", "img-webp-4"]);
  });

  it("string tool_result content passes through with no imageIds", () => {
    const [msg] = parseMessages([toolResultLine("plain file contents")]);
    expect(msg).toMatchObject({ type: "tool_result", content: "plain file contents" });
    expect(msg.imageIds).toBeUndefined();
  });

  it("image blocks without base64 source fall back to JSON stringification", () => {
    const [msg] = parseMessages([toolResultLine([{ type: "image", source: { type: "url", url: "http://x/y.png" } }])]);
    expect(msg.content).toBe('{"type":"image","source":{"type":"url","url":"http://x/y.png"}}');
    expect(msg.imageIds).toBeUndefined();
  });
});
