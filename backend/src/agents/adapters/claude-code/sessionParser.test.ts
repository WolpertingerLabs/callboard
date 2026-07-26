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
    const [msg] = parseMessages([toolResultLine([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }])]);
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

// ── CLI plumbing ────────────────────────────────────────────────────
//
// Interrupting a running turn (by sending a follow-up message, or by
// stopping) leaves records in the session log that are not conversation:
// the CLI's interruption marker, the `isMeta` "Continue from where you left
// off." nudge it injects on resume, and the model's canned reply to that
// nudge. All three used to render as ordinary chat bubbles, two of them
// attributed to the user.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userLine(content: any, extra: Record<string, unknown> = {}) {
  return { type: "user", message: { role: "user", content }, timestamp: "2026-01-01T10:00:00.000Z", ...extra };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assistantLine(content: any) {
  return { type: "assistant", message: { role: "assistant", content }, timestamp: "2026-01-01T10:00:01.000Z" };
}

describe("parseMessages — CLI plumbing is not conversation", () => {
  it("drops the isMeta resume nudge and the canned reply it draws out", () => {
    const parsed = parseMessages([
      userLine("real question"),
      userLine("Continue from where you left off.", { isMeta: true }),
      assistantLine([{ type: "text", text: "No response requested." }]),
      assistantLine([{ type: "text", text: "real answer" }]),
    ]);
    expect(parsed.map((m) => m.content)).toEqual(["real question", "real answer"]);
  });

  it("keeps a real continuation the nudge produced", () => {
    // Only the canned acknowledgment is plumbing — if the model actually got
    // back to work, that turn is the user's content and must survive.
    const parsed = parseMessages([
      userLine("Continue from where you left off.", { isMeta: true }),
      assistantLine([{ type: "text", text: "Picking up where I left off: ..." }]),
    ]);
    expect(parsed.map((m) => m.content)).toEqual(["Picking up where I left off: ..."]);
  });

  it("drops isMeta entries that are not the resume nudge", () => {
    // Slash-command argument blocks and skill preambles arrive the same way.
    const parsed = parseMessages([userLine("## Arguments\n\n`skip-install`", { isMeta: true }), assistantLine([{ type: "text", text: "ok" }])]);
    expect(parsed.map((m) => m.content)).toEqual(["ok"]);
  });

  it("only drops the canned reply when it directly follows a hidden nudge", () => {
    const parsed = parseMessages([userLine("hi"), assistantLine([{ type: "text", text: "No response requested." }])]);
    expect(parsed.map((m) => m.content)).toEqual(["hi", "No response requested."]);
  });

  it("survives the attachment / last-prompt entries the CLI writes between the nudge and the reply", () => {
    // Shaped as they actually appear on disk: bookkeeping keys only, with no
    // `message` and no `content`, which is why they carry no conversation.
    const parsed = parseMessages([
      userLine("Continue from where you left off.", { isMeta: true }),
      { type: "attachment", attachment: { type: "queued_command" }, entrypoint: "cli", timestamp: "2026-01-01T10:00:00.500Z" },
      { type: "last-prompt", lastPrompt: "…", leafUuid: "u-1", timestamp: "2026-01-01T10:00:00.600Z" },
      assistantLine([{ type: "text", text: "No response requested." }]),
    ]);
    expect(parsed).toEqual([]);
  });

  it("renders both interruption markers as system boundaries, not user messages", () => {
    for (const marker of ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]) {
      const [msg] = parseMessages([userLine(marker)]);
      expect(msg).toMatchObject({ role: "system", type: "system", subtype: "interrupted", content: "Interrupted by user" });
    }
  });

  it("leaves assistant prose about interruptions alone", () => {
    const [msg] = parseMessages([assistantLine([{ type: "text", text: "That restart got interrupted by user activity, retrying." }])]);
    expect(msg).toMatchObject({ role: "assistant", type: "text" });
  });

  it("keeps a user message that merely quotes the marker", () => {
    // Exact-match only: a user asking about the marker is still a real message.
    const [msg] = parseMessages([userLine("why does it say [Request interrupted by user] here?")]);
    expect(msg).toMatchObject({ role: "user", type: "text" });
  });

  it("leaves an interrupted turn readable end to end", () => {
    // The shape a follow-up-mid-run actually produces.
    const parsed = parseMessages([
      userLine("MESSAGE ONE"),
      assistantLine([{ type: "text", text: "partial answer" }]),
      userLine("[Request interrupted by user]"),
      userLine("Continue from where you left off.", { isMeta: true }),
      assistantLine([{ type: "text", text: "No response requested." }]),
      userLine("MESSAGE TWO"),
    ]);
    expect(parsed.map((m) => [m.role, m.content])).toEqual([
      ["user", "MESSAGE ONE"],
      ["assistant", "partial answer"],
      ["system", "Interrupted by user"],
      ["user", "MESSAGE TWO"],
    ]);
  });
});
