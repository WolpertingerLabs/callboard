import { describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "shared/types/index.js";

vi.mock("../services/image-storage.js", () => ({ ImageStorageService: { getImage: () => null } }));

const { buildCompressedTurns, compressionSpans, splitAtCutoff, splitBeforeCutoff, transcriptBlocksForSummary } = await import("./compression.js");

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
const msg = (role: "user" | "assistant", s: number | undefined, content: string, extra: Partial<ParsedMessage> = {}): ParsedMessage =>
  ({ role, type: "text", content, ...(s !== undefined && { timestamp: t(s) }), ...extra }) as ParsedMessage;

const history: ParsedMessage[] = [
  msg("user", 0, "q1"),
  msg("assistant", 1, "a1"),
  { role: "assistant", type: "tool_use", toolName: "Bash", content: '{"command":"ls"}', timestamp: t(2) } as ParsedMessage,
  { role: "user", type: "tool_result", content: "file.txt" } as ParsedMessage, // untimestamped: rides with the tool_use
  msg("user", 10, "q2"),
  msg("assistant", 11, "a2"),
];

describe("cutoff splits", () => {
  it("splitAtCutoff keeps untimestamped followers on the through side", () => {
    const { through, later } = splitAtCutoff(history, t(2));
    expect(through).toHaveLength(4);
    expect(later.map((m) => m.content)).toEqual(["q2", "a2"]);
  });

  it("splitBeforeCutoff starts the kept part at the cutoff message", () => {
    const { earlier, kept } = splitBeforeCutoff(history, t(10));
    expect(earlier).toHaveLength(4);
    expect(kept.map((m) => m.content)).toEqual(["q2", "a2"]);
  });

  it("compressionSpans picks the summarised side by direction", () => {
    expect(compressionSpans(history, t(2), "after").summarised.map((m) => m.content)).toEqual(["q2", "a2"]);
    expect(compressionSpans(history, t(1), "before").summarised.map((m) => m.content)).toEqual(["q1"]);
  });
});

describe("buildCompressedTurns", () => {
  it("before: summary + ack, then the kept part, merged so roles alternate", () => {
    const turns = buildCompressedTurns(history, { cutoffTimestamp: t(10), direction: "before", summary: "SUM" });
    expect(turns.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[0]!.text).toMatch(/^\[Summary of the earlier conversation, compressed by the user\]/);
    expect(turns[0]!.text).toContain("SUM");
    expect(turns[0]!.text).toContain("bracketed text summaries");
    // Stamped before the kept part.
    expect(turns[0]!.timestamp! < t(10)).toBe(true);
    expect(turns[2]!.text).toBe("q2");
  });

  it("before: an assistant-first kept part follows the summary directly, keeping X's timestamp", () => {
    const turns = buildCompressedTurns(history, { cutoffTimestamp: t(11), direction: "before", summary: "SUM" });
    expect(turns.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(turns[1]).toMatchObject({ text: "a2", timestamp: t(11) });
  });

  it.each([
    ["user-first", 10],
    ["assistant-first", 11],
  ])("before (%s): the new session has a message at X's timestamp", (_label, s) => {
    const turns = buildCompressedTurns(history, { cutoffTimestamp: t(s), direction: "before", summary: "SUM" });
    expect(turns.some((x) => x.timestamp === t(s))).toBe(true);
  });

  it("after: kept part, then the summary exchange stamped after it", () => {
    const turns = buildCompressedTurns(history, { cutoffTimestamp: t(2), direction: "after", summary: "SUM" });
    expect(turns.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[1]!.text).toContain("[tool: Bash]");
    expect(turns[2]!.text).toMatch(/^\[Summary of the later conversation, compressed by the user\]/);
    expect(turns[2]!.timestamp! > t(2)).toBe(true);
  });

  it("returns [] when the kept part is empty", () => {
    expect(buildCompressedTurns(history, { cutoffTimestamp: t(30), direction: "before", summary: "SUM" })).toEqual([]);
  });
});

describe("transcriptBlocksForSummary", () => {
  it("labels turns and notes images without loading them", () => {
    const blocks = transcriptBlocksForSummary([msg("user", 0, "look", { imageIds: ["img1"] }), msg("assistant", 1, "seen")]);
    expect(blocks).toEqual(["User: look\n[1 image(s) attached]", "Assistant: seen"]);
  });
});
