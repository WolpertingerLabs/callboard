import { describe, expect, it } from "vitest";
import { appendAttachmentBlocks, attachmentPreviewText, formatAttachmentBlock, splitAttachmentBlocks } from "./attachment.js";

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

  it("only takes the trailing run of blocks; a block-shaped string the user typed stays text", () => {
    const typed = formatAttachmentBlock({ ...meta, id: "typed", name: "typed.txt" }, { content: "pasted" });
    const message = `see this:\n\n${typed}\n\nwhat is it?`;
    expect(splitAttachmentBlocks(message)).toEqual({ text: message, files: [] });

    const real = formatAttachmentBlock({ ...meta, id: "real" }, { content: "hi" });
    expect(splitAttachmentBlocks(appendAttachmentBlocks(message, [real]))).toEqual({ text: message, files: [{ ...meta, id: "real", inline: true }] });
  });

  it("previews the typed text, or the file names when there is none", () => {
    const blocks = [formatAttachmentBlock({ ...meta, name: "notes.md" }, { content: "x" }), formatAttachmentBlock({ ...meta, name: "data.csv" }, { reason: "binary" })];
    expect(attachmentPreviewText(appendAttachmentBlocks("hello", blocks))).toBe("hello");
    expect(attachmentPreviewText(appendAttachmentBlocks("", blocks))).toBe("📎 notes.md, data.csv");
    expect(attachmentPreviewText("plain")).toBe("plain");
  });

  it("leaves text without blocks exactly as it was", () => {
    expect(splitAttachmentBlocks("  <b>bold</b>  ")).toEqual({ text: "  <b>bold</b>  ", files: [] });
    expect(appendAttachmentBlocks("  same  ", [])).toBe("  same  ");
  });
});
