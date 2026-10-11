import { describe, expect, it } from "vitest";
import { appendAttachmentBlocks, formatAttachmentBlock, splitAttachmentBlocks } from "./attachment.js";

const meta = { id: "abc", name: 'a "quoted" <name>.txt', path: "/data/images/abc_a.txt", size: 5, mimeType: "text/plain" };

describe("attachment blocks", () => {
  it("round-trips the typed text and every file, escaping attributes", () => {
    const prompt = appendAttachmentBlocks("  hello\nthere  ", [
      formatAttachmentBlock(meta, { content: "hi\n" }),
      formatAttachmentBlock({ ...meta, id: "def", name: "b.pdf" }, { reason: "binary" }),
    ]);
    expect(splitAttachmentBlocks(prompt)).toEqual({
      text: "hello\nthere",
      files: [
        { ...meta, inline: true },
        { ...meta, id: "def", name: "b.pdf", inline: false },
      ],
    });
  });

  it("handles a message that is only attachments, and an empty inlined file", () => {
    const prompt = appendAttachmentBlocks("", [formatAttachmentBlock(meta, { content: "" })]);
    expect(splitAttachmentBlocks(prompt)).toMatchObject({ text: "", files: [{ id: "abc", inline: true }] });
  });

  it("leaves text without blocks exactly as it was", () => {
    expect(splitAttachmentBlocks("  <b>bold</b>  ")).toEqual({ text: "  <b>bold</b>  ", files: [] });
    expect(appendAttachmentBlocks("  same  ", [])).toBe("  same  ");
  });
});
