/**
 * The streaming prompt form is the NORMAL path — `services/claude.ts` uses it
 * whenever MCP servers are present, which for callboard is nearly always. The
 * adapter shipped rejecting it, and a real chat through the API is what
 * surfaced that; these cases are the regression fence.
 */
import { describe, it, expect } from "vitest";
import { resolveClinePrompt } from "./promptAdapter.js";

async function* stream(...messages: unknown[]): AsyncIterable<unknown> {
  for (const message of messages) yield message;
}

/** The Claude-SDK-shaped user message `claude.ts` streams. */
function userMessage(content: unknown) {
  return { type: "user", message: { role: "user", content } };
}

describe("resolveClinePrompt", () => {
  it("passes a plain string straight through", async () => {
    await expect(resolveClinePrompt("just text")).resolves.toEqual({ prompt: "just text", userImages: [] });
  });

  it("flattens the streaming form callboard actually sends", async () => {
    await expect(resolveClinePrompt(stream(userMessage("hello")))).resolves.toEqual({ prompt: "hello", userImages: [] });
  });

  it("joins text blocks across messages", async () => {
    const prompt = stream(userMessage([{ type: "text", text: "first" }]), userMessage([{ type: "text", text: "second" }]));
    await expect(resolveClinePrompt(prompt)).resolves.toMatchObject({ prompt: "first\n\nsecond" });
  });

  it("splits images out as data URIs rather than inlining them in the text", async () => {
    // Cline's session input takes `prompt` and `userImages` separately, so the
    // two halves stay separate instead of being spliced into one blob.
    const prompt = stream(
      userMessage([
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ]),
    );
    await expect(resolveClinePrompt(prompt)).resolves.toEqual({
      prompt: "what is this?",
      userImages: ["data:image/png;base64,AAAA"],
    });
  });

  it("keeps an images-only prompt usable", async () => {
    const prompt = stream(userMessage([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }]));
    await expect(resolveClinePrompt(prompt)).resolves.toEqual({ prompt: "", userImages: ["data:image/jpeg;base64,BBBB"] });
  });

  it("drops what it cannot represent instead of throwing", async () => {
    const prompt = stream(
      userMessage([
        { type: "text", text: "keep" },
        { type: "tool_result", content: "drop" },
        // A url image source: callboard never produces one, so it is counted as
        // dropped and logged rather than silently half-working.
        { type: "image", source: { type: "url", url: "https://x/y.png" } },
        null,
      ]),
    );
    await expect(resolveClinePrompt(prompt)).resolves.toEqual({ prompt: "keep", userImages: [] });
  });

  it("survives an empty stream", async () => {
    await expect(resolveClinePrompt(stream())).resolves.toEqual({ prompt: "", userImages: [] });
  });
});
