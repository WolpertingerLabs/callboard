/**
 * Unit tests for the cross-harness handoff projection — the neutral middle
 * between one provider's parsed history and another provider's session writer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "shared/types/index.js";

// Image bytes come from callboard's image store; stub it so the projection
// can be tested without touching DATA_DIR.
const store = vi.hoisted(() => ({ images: new Map<string, { buffer: Buffer; mimeType: string }>() }));
vi.mock("../services/image-storage.js", () => ({
  ImageStorageService: {
    getImage: (id: string) => {
      const hit = store.images.get(id);
      return hit ? { buffer: hit.buffer, image: { mimeType: hit.mimeType } } : null;
    },
  },
}));

const { buildHandoffTurns, flattenForHandoff, truncateAtCutoff } = await import("./handoff.js");

beforeEach(() => {
  store.images.clear();
});

/** Register a fake stored image and return its id. */
function putImage(id: string, bytes = 10, mimeType = "image/png"): string {
  store.images.set(id, { buffer: Buffer.alloc(bytes, 7), mimeType });
  return id;
}

/** Terse ParsedMessage builder — only the fields the projection reads. */
function msg(partial: Partial<ParsedMessage> & Pick<ParsedMessage, "role" | "type" | "content">): ParsedMessage {
  return partial as ParsedMessage;
}

describe("flattenForHandoff", () => {
  it("projects user and assistant text into turns", () => {
    const { turns } = flattenForHandoff([msg({ role: "user", type: "text", content: "hello" }), msg({ role: "assistant", type: "text", content: "hi there" })]);
    expect(turns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  it("folds tool calls and results into the adjacent assistant turn", () => {
    const { turns } = flattenForHandoff([
      msg({ role: "user", type: "text", content: "list files" }),
      msg({ role: "assistant", type: "tool_use", toolName: "Bash", content: '{"command":"ls"}' }),
      msg({ role: "user", type: "tool_result", toolName: "Bash", content: "a.txt\nb.txt" }),
      msg({ role: "assistant", type: "text", content: "Two files." }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: "user", text: "list files" });
    // The call, its result, and the assistant's conclusion merge into ONE
    // assistant turn — the tool result must not become a user turn, which
    // would fabricate a user message that never happened.
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.text).toContain('[tool: Bash] {"command":"ls"}');
    expect(turns[1]!.text).toContain("[tool result] a.txt\nb.txt");
    expect(turns[1]!.text).toContain("Two files.");
  });

  it("drops thinking, system and subagent messages", () => {
    const { turns } = flattenForHandoff([
      msg({ role: "user", type: "text", content: "go" }),
      msg({ role: "assistant", type: "thinking", content: "secret reasoning" }),
      msg({ role: "system", type: "system", content: "compact boundary", subtype: "compact_boundary" }),
      msg({ role: "assistant", type: "text", content: "sub output", teamName: "Explore" }),
      msg({ role: "assistant", type: "text", content: "done" }),
    ]);
    expect(turns).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("merges consecutive same-role messages", () => {
    const { turns } = flattenForHandoff([
      msg({ role: "user", type: "text", content: "one" }),
      msg({ role: "user", type: "text", content: "two" }),
      msg({ role: "assistant", type: "text", content: "ok" }),
    ]);
    expect(turns).toEqual([
      { role: "user", text: "one\n\ntwo" },
      { role: "assistant", text: "ok" },
    ]);
  });

  it("drops whitespace-only content rather than emitting blank turns", () => {
    const { turns } = flattenForHandoff([msg({ role: "user", type: "text", content: "real" }), msg({ role: "assistant", type: "text", content: "   \n  " })]);
    expect(turns).toEqual([{ role: "user", text: "real" }]);
  });

  it("truncates oversized tool output and says so", () => {
    const huge = "x".repeat(5000);
    const { turns } = flattenForHandoff([
      msg({ role: "user", type: "text", content: "read" }),
      msg({ role: "user", type: "tool_result", toolName: "Read", content: huge }),
    ]);
    const text = turns[1]!.text;
    expect(text.length).toBeLessThan(3000);
    expect(text).toContain("more characters truncated in handoff");
  });

  it("keeps the first turn's timestamp for ordering", () => {
    const { turns } = flattenForHandoff([msg({ role: "user", type: "text", content: "hi", timestamp: "2026-01-01T00:00:00Z" })]);
    expect(turns[0]!.timestamp).toBe("2026-01-01T00:00:00Z");
  });
});

describe("buildHandoffTurns", () => {
  it("prefixes a preamble exchange naming both harnesses", () => {
    const turns = buildHandoffTurns([msg({ role: "user", type: "text", content: "hi" })], "claude-code", "codex");
    expect(turns).toHaveLength(3);
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.text).toContain('from="Claude Code"');
    expect(turns[0]!.text).toContain('to="Codex"');
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.text).toContain("Claude Code");
    expect(turns[2]).toEqual({ role: "user", text: "hi" });
  });

  it("returns nothing when there is no history to carry", () => {
    // A preamble referencing a conversation the model cannot see is worse
    // than no session at all — callers treat [] as "nothing to fork".
    expect(buildHandoffTurns([], "claude-code", "codex")).toEqual([]);
    expect(buildHandoffTurns([msg({ role: "assistant", type: "thinking", content: "x" })], "claude-code", "codex")).toEqual([]);
  });
});

describe("truncateAtCutoff", () => {
  const history = [
    msg({ role: "user", type: "text", content: "one", timestamp: "2026-01-01T00:00:00Z" }),
    msg({ role: "assistant", type: "text", content: "two", timestamp: "2026-01-01T00:01:00Z" }),
    msg({ role: "user", type: "text", content: "three", timestamp: "2026-01-01T00:02:00Z" }),
  ];

  it("keeps everything up to and including the cutoff message", () => {
    const kept = truncateAtCutoff(history, "2026-01-01T00:01:00Z");
    expect(kept.map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("carries untimestamped messages along with their neighbours", () => {
    const withGap = [history[0]!, msg({ role: "assistant", type: "tool_use", toolName: "Bash", content: "{}" }), history[1]!, history[2]!];
    const kept = truncateAtCutoff(withGap, "2026-01-01T00:01:00Z");
    expect(kept).toHaveLength(3);
    expect(kept[1]!.type).toBe("tool_use");
  });

  it("returns nothing when no message falls at or before the cutoff", () => {
    expect(truncateAtCutoff(history, "2025-01-01T00:00:00Z")).toEqual([]);
  });

  it("returns nothing for an unparseable cutoff", () => {
    expect(truncateAtCutoff(history, "not-a-date")).toEqual([]);
  });
});

describe("flattenForHandoff images", () => {
  it("carries images attached to user messages", () => {
    putImage("img-1", 4);
    const { turns, imagesSkipped, imagesMissing } = flattenForHandoff([msg({ role: "user", type: "text", content: "look at this", imageIds: ["img-1"] })]);
    expect(turns[0]!.images).toEqual([{ mimeType: "image/png", base64: Buffer.alloc(4, 7).toString("base64") }]);
    expect(imagesSkipped).toBe(0);
    expect(imagesMissing).toBe(0);
  });

  it("does not attach images to assistant turns", () => {
    // No harness accepts image blocks on assistant output, so a tool result's
    // images are noted in text instead of being carried.
    const { turns } = flattenForHandoff([
      msg({ role: "user", type: "text", content: "screenshot it" }),
      msg({ role: "user", type: "tool_result", toolName: "Read", content: "read an image", imageIds: [putImage("img-2")] }),
    ]);
    const assistantTurn = turns.find((t) => t.role === "assistant")!;
    expect(assistantTurn.images).toBeUndefined();
    expect(assistantTurn.text).toContain("1 image not carried across the handoff");
  });

  it("merges images when consecutive user messages merge", () => {
    putImage("img-a");
    putImage("img-b");
    const { turns } = flattenForHandoff([
      msg({ role: "user", type: "text", content: "one", imageIds: ["img-a"] }),
      msg({ role: "user", type: "text", content: "two", imageIds: ["img-b"] }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.images).toHaveLength(2);
  });

  it("counts images that are no longer in the store", () => {
    const { turns, imagesMissing } = flattenForHandoff([msg({ role: "user", type: "text", content: "hi", imageIds: ["gone"] })]);
    expect(imagesMissing).toBe(1);
    expect(turns[0]!.images).toBeUndefined();
  });

  it("stops carrying images once the count cap trips", () => {
    const ids = Array.from({ length: 15 }, (_, i) => putImage(`img-${i}`, 4));
    const { turns, imagesSkipped } = flattenForHandoff([msg({ role: "user", type: "text", content: "many", imageIds: ids })]);
    expect(turns[0]!.images).toHaveLength(12);
    expect(imagesSkipped).toBe(3);
  });

  it("stops carrying images once the byte cap trips", () => {
    // Two 4 MB images exceed the 6 MB budget, so only the first is carried —
    // in conversation order, so early references keep resolving.
    const ids = [putImage("big-1", 4 * 1024 * 1024), putImage("big-2", 4 * 1024 * 1024)];
    const { turns, imagesSkipped } = flattenForHandoff([msg({ role: "user", type: "text", content: "two big", imageIds: ids })]);
    expect(turns[0]!.images).toHaveLength(1);
    expect(imagesSkipped).toBe(1);
  });

  it("discloses dropped images in the preamble, and stays quiet when none dropped", () => {
    const withDrop = buildHandoffTurns([msg({ role: "user", type: "text", content: "hi", imageIds: ["gone"] })], "claude-code", "codex");
    expect(withDrop[0]!.text).toContain("1 image referenced by this conversation could not be carried over");

    putImage("img-ok");
    const clean = buildHandoffTurns([msg({ role: "user", type: "text", content: "hi", imageIds: ["img-ok"] })], "claude-code", "codex");
    expect(clean[0]!.text).not.toContain("could not be carried over");
  });
});
