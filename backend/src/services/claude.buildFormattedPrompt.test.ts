import { describe, expect, it } from "vitest";
import { splitAttachmentBlocks } from "shared/types/index.js";
import { buildFormattedPrompt, titleSourceFor } from "./claude.js";

const textFile = { id: "f1", name: "notes.md", buffer: Buffer.from("# Notes"), mimeType: "text/markdown", storagePath: "/data/images/f1_notes.md" };
const image = { id: "i1", buffer: Buffer.from("png"), mimeType: "image/png", storagePath: "/data/images/i1.png" };

async function firstMessage(prompt: string | AsyncIterable<any>): Promise<any> {
  if (typeof prompt === "string") throw new Error("expected a multimodal prompt");
  for await (const message of prompt) return message;
}

describe("buildFormattedPrompt", () => {
  it("keeps a prompt with only file attachments a plain string, with the files after the text", () => {
    const prompt = buildFormattedPrompt("look at this", [textFile]);
    expect(typeof prompt).toBe("string");
    expect(splitAttachmentBlocks(prompt as string)).toMatchObject({ text: "look at this", files: [{ name: "notes.md", inline: true }] });
    expect(prompt).toContain("# Notes");
  });

  it("sends images as image blocks and files in the text block", async () => {
    const message = await firstMessage(buildFormattedPrompt("both", [image, textFile]));
    const [text, img] = message.message.content;
    expect(text.type).toBe("text");
    expect(splitAttachmentBlocks(text.text).files.map((f) => f.name)).toEqual(["notes.md"]);
    expect(img).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(message.message.content).toHaveLength(2);
  });

  it("leaves a prompt with no uploads untouched", () => {
    expect(buildFormattedPrompt("  plain  ", [])).toBe("  plain  ");
  });
});

describe("titleSourceFor", () => {
  it("titles from the typed prompt when there is one", () => {
    expect(titleSourceFor("fix the build", [textFile])).toBe("fix the build");
  });

  it("titles from the attached file names when the prompt is empty", () => {
    expect(titleSourceFor("  ", [image, textFile, { ...textFile, name: "data.csv" }])).toBe("Attached files: notes.md, data.csv");
  });

  it("skips titling with neither text nor files", () => {
    expect(titleSourceFor("", [image])).toBeNull();
    expect(titleSourceFor("", undefined)).toBeNull();
  });
});
