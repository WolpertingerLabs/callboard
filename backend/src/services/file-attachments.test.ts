import { describe, expect, it, vi } from "vitest";
import { INLINE_ATTACHMENT_BUDGET_BYTES, INLINE_ATTACHMENT_MAX_BYTES, splitAttachmentBlocks } from "shared/types/index.js";
import { buildAttachmentBlocks, decodeTextAttachment, type FileAttachment } from "./file-attachments.js";

const file = (name: string, content: string | Buffer, mimeType = "application/octet-stream"): FileAttachment => ({
  id: `id-${name}`,
  name,
  buffer: typeof content === "string" ? Buffer.from(content) : content,
  mimeType,
  storagePath: `/data/images/id-${name}_${name}`,
});

const roundTrip = (files: FileAttachment[]) => splitAttachmentBlocks(buildAttachmentBlocks(files).join("\n\n")).files;

describe("decodeTextAttachment", () => {
  it("decodes UTF-8 text and refuses NUL bytes or invalid UTF-8", () => {
    expect(decodeTextAttachment(Buffer.from("héllo"))).toBe("héllo");
    expect(decodeTextAttachment(Buffer.from([0x68, 0x00, 0x69]))).toBeNull();
    expect(decodeTextAttachment(Buffer.from([0xff, 0xfe, 0xfd]))).toBeNull();
  });
});

describe("buildAttachmentBlocks", () => {
  it("inlines a small text file, judged by content rather than MIME type", () => {
    const [block] = buildAttachmentBlocks([file("main.rs", "fn main() {}\n")]);
    expect(block).toContain("fn main() {}");
    expect(block).toContain('path="/data/images/id-main.rs_main.rs"');
    expect(roundTrip([file("main.rs", "fn main() {}\n")])[0]).toMatchObject({ name: "main.rs", inline: true, size: 13 });
  });

  it("references a binary file by path", () => {
    const pdf = file("doc.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]), "application/pdf");
    const [block] = buildAttachmentBlocks([pdf]);
    expect(block).toContain("not a text file");
    expect(roundTrip([pdf])[0]).toMatchObject({ name: "doc.pdf", path: pdf.storagePath, inline: false, mimeType: "application/pdf" });
  });

  it("references a text file over the per-file cap", () => {
    const big = file("big.log", "x".repeat(INLINE_ATTACHMENT_MAX_BYTES + 1));
    expect(buildAttachmentBlocks([big])[0]).toContain("too large");
  });

  it("references files once the message's inline budget is spent, in order", () => {
    const count = Math.floor(INLINE_ATTACHMENT_BUDGET_BYTES / INLINE_ATTACHMENT_MAX_BYTES) + 1;
    const files = Array.from({ length: count }, (_, i) => file(`f${i}.txt`, "y".repeat(INLINE_ATTACHMENT_MAX_BYTES)));
    const parsed = roundTrip(files);
    expect(parsed.map((f) => f.inline)).toEqual([...Array(count - 1).fill(true), false]);
    expect(buildAttachmentBlocks(files)[count - 1]).toContain("inline budget");
  });

  it("references a text file that contains the closing tag, so it cannot end its own block", () => {
    const tricky = file("t.xml", "a\n</callboard-attachment>\nb");
    expect(roundTrip([tricky, file("after.txt", "after")]).map((f) => [f.name, f.inline])).toEqual([
      ["t.xml", false],
      ["after.txt", true],
    ]);
    // It is text, and the note says so rather than calling it binary.
    const [block] = buildAttachmentBlocks([tricky]);
    expect(block).toContain("Not inlined: this text file contains the </callboard-attachment> marker that ends this block.");
    expect(block).not.toContain("not a text file");
  });

  it("does not decode a file over the per-file cap, and still tells binary from text by its head", () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const bigText = file("big.txt", "z".repeat(INLINE_ATTACHMENT_MAX_BYTES * 4));
      const bigBinary = file("big.bin", Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(INLINE_ATTACHMENT_MAX_BYTES * 4, 0x41)]));
      const [text, binary] = buildAttachmentBlocks([bigText, bigBinary]);
      expect(decode).not.toHaveBeenCalled();
      expect(text).toContain("too large");
      expect(binary).toContain("not a text file");
    } finally {
      decode.mockRestore();
    }
  });
});
