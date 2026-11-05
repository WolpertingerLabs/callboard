import { describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "shared/types/index.js";

const prompts = vi.hoisted(() => [] as string[]);
vi.mock("./chat-model-completion.js", () => ({
  runChatModelCompletion: async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    return `summary #${prompts.length}`;
  },
}));
vi.mock("./image-storage.js", () => ({ ImageStorageService: { getImage: () => null } }));

const { chunkBlocks, summariseForCompression, MAX_CHUNK_CHARS } = await import("./chat-summary.js");

describe("chunkBlocks", () => {
  it("packs blocks up to the limit without splitting one", () => {
    expect(chunkBlocks(["aaaa", "bbbb", "cccc"], 10)).toEqual(["aaaa\n\nbbbb", "cccc"]);
  });
  it("truncates a single block larger than the limit", () => {
    const [only] = chunkBlocks(["x".repeat(30)], 10);
    expect(only).toMatch(/^x{10}\n… \[truncated/);
  });
});

describe("summariseForCompression", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  it("summarises a long span in parts, then merges them", async () => {
    prompts.length = 0;
    const big = "y".repeat(MAX_CHUNK_CHARS - 100);
    const messages = [
      { role: "user", type: "text", content: big, timestamp: t(0) },
      { role: "assistant", type: "text", content: big, timestamp: t(1) },
      { role: "user", type: "text", content: "keep me", timestamp: t(5) },
    ] as ParsedMessage[];
    const { summary, chunks } = await summariseForCompression({ messages, timestamp: t(5), direction: "before", provider: "claude-code" });
    expect(chunks).toBe(2);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("part 1 of 2");
    expect(prompts[2]).toContain('<part index="2">\nsummary #2');
    expect(summary).toBe("summary #3");
  });
});
