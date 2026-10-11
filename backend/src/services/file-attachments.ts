/**
 * Turns non-image uploads into prompt text: inlined when small and textual,
 * referenced by path otherwise. The block grammar and the thresholds live in
 * shared/types/attachment.ts, which the UI reads them back with.
 */
import {
  INLINE_ATTACHMENT_BUDGET_BYTES,
  INLINE_ATTACHMENT_MAX_BYTES,
  canInlineAttachmentText,
  formatAttachmentBlock,
  type AttachmentReferenceReason,
} from "shared/types/index.js";

export interface FileAttachment {
  id: string;
  name: string;
  buffer: Buffer;
  mimeType: string;
  storagePath: string;
}

/**
 * The file as text, or null when it is not text. Type is judged by content,
 * not by the browser's MIME type, which is `application/octet-stream` for
 * most source files: no NUL bytes and valid UTF-8.
 */
export function decodeTextAttachment(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer);
  } catch {
    return null;
  }
}

/** Bytes sniffed for a NUL when a file is too large to decode. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * One block per file, in order. Text files are inlined while they fit both
 * the per-file cap and what is left of the per-message budget; the rest are
 * referenced by path.
 *
 * Size is checked before decoding, so a 25 MB upload is never decoded just to
 * be refused. Such a file is only sniffed: a NUL in its head makes it
 * "binary", anything else "too-large".
 */
export function buildAttachmentBlocks(files: FileAttachment[]): string[] {
  let budget = INLINE_ATTACHMENT_BUDGET_BYTES;
  return files.map((file) => {
    const meta = { id: file.id, name: file.name, path: file.storagePath, size: file.buffer.length, mimeType: file.mimeType };
    const reference = (reason: AttachmentReferenceReason) => formatAttachmentBlock(meta, { reason });
    if (file.buffer.length > INLINE_ATTACHMENT_MAX_BYTES) {
      return reference(file.buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0) ? "binary" : "too-large");
    }
    const text = decodeTextAttachment(file.buffer);
    if (text === null) return reference("binary");
    if (!canInlineAttachmentText(text)) return reference("unsafe-text");
    if (file.buffer.length > budget) return reference("budget");
    budget -= file.buffer.length;
    return formatAttachmentBlock(meta, { content: text });
  });
}
