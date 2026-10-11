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

/**
 * One block per file, in order. Text files are inlined while they fit both
 * the per-file cap and what is left of the per-message budget; the rest are
 * referenced by path.
 */
export function buildAttachmentBlocks(files: FileAttachment[]): string[] {
  let budget = INLINE_ATTACHMENT_BUDGET_BYTES;
  return files.map((file) => {
    const meta = { id: file.id, name: file.name, path: file.storagePath, size: file.buffer.length, mimeType: file.mimeType };
    const text = decodeTextAttachment(file.buffer);
    let reason: AttachmentReferenceReason | null = null;
    if (text === null || !canInlineAttachmentText(text)) reason = "binary";
    else if (file.buffer.length > INLINE_ATTACHMENT_MAX_BYTES) reason = "too-large";
    else if (file.buffer.length > budget) reason = "budget";
    if (reason !== null || text === null) return formatAttachmentBlock(meta, { reason: reason ?? "binary" });
    budget -= file.buffer.length;
    return formatAttachmentBlock(meta, { content: text });
  });
}
