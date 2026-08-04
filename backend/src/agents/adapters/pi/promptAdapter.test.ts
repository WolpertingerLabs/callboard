import { describe, it, expect } from "vitest";
import { resolvePiPrompt } from "./promptAdapter.js";

async function* stream(...messages: unknown[]): AsyncIterable<unknown> {
  for (const message of messages) yield message;
}

const userText = (text: string) => ({ message: { content: [{ type: "text", text }] } });

describe("resolvePiPrompt", () => {
  it("passes a plain string straight through", async () => {
    expect(await resolvePiPrompt("hello")).toEqual({ prompt: "hello", images: [] });
  });

  /**
   * The streaming form is the NORMAL path — `services/claude.ts` uses it
   * whenever MCP servers are present, which for callboard is nearly always. The
   * Cline adapter shipped without this and the first real chat failed.
   */
  it("flattens the streaming form callboard actually sends", async () => {
    const { prompt } = await resolvePiPrompt(stream(userText("first"), userText("second")));
    expect(prompt).toBe("first\n\nsecond");
  });

  it("accepts a bare string content field", async () => {
    expect((await resolvePiPrompt(stream({ message: { content: "plain" } }))).prompt).toBe("plain");
  });

  it("converts base64 images into pi's structured block, not a data URI", async () => {
    const { images } = await resolvePiPrompt(
      stream({ message: { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk=" } }] } }),
    );
    expect(images).toEqual([{ type: "image", data: "aGk=", mimeType: "image/jpeg" }]);
  });

  it("defaults a missing media type to png rather than dropping the image", async () => {
    const { images } = await resolvePiPrompt(stream({ message: { content: [{ type: "image", source: { type: "base64", data: "aGk=" } }] } }));
    expect(images[0]?.mimeType).toBe("image/png");
  });

  it("keeps text and images separate", async () => {
    const { prompt, images } = await resolvePiPrompt(
      stream({
        message: {
          content: [
            { type: "text", text: "look at this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
          ],
        },
      }),
    );
    expect(prompt).toBe("look at this");
    expect(images).toHaveLength(1);
  });

  it("drops a url image source rather than half-passing it", async () => {
    // callboard stores images itself and never produces url sources; one
    // appearing means something upstream changed.
    const { images } = await resolvePiPrompt(stream({ message: { content: [{ type: "image", source: { type: "url", url: "http://x/y.png" } }] } }));
    expect(images).toEqual([]);
  });

  it("survives an images-only prompt with empty text", async () => {
    const { prompt, images } = await resolvePiPrompt(
      stream({ message: { content: [{ type: "image", source: { type: "base64", data: "aGk=" } }] } }),
    );
    expect(prompt).toBe("");
    expect(images).toHaveLength(1);
  });

  it("ignores malformed and unknown blocks without throwing", async () => {
    const { prompt, images } = await resolvePiPrompt(
      stream({ message: { content: [null, 42, { type: "tool_use" }, { type: "text", text: "ok" }] } }, { message: {} }, {}),
    );
    expect(prompt).toBe("ok");
    expect(images).toEqual([]);
  });

  it("returns empty for an empty stream", async () => {
    expect(await resolvePiPrompt(stream())).toEqual({ prompt: "", images: [] });
  });
});
