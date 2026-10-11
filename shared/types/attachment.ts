/**
 * Composer attachments that are not images.
 *
 * Every attachment is uploaded through the image store and saved to disk.
 * Images then go to the model as image content blocks. Other files go as text
 * appended to the prompt, one {@link ATTACHMENT_TAG} block per file:
 *
 * - **inline**: a small UTF-8 text file. The block carries its contents.
 * - **referenced**: anything binary, too large, or past the per-message
 *   inline budget. The block carries only the absolute path, and the agent
 *   reads the file itself if it needs to.
 *
 * The blocks are persisted in the harness's transcript as part of the user's
 * message. That is deliberate: a resumed or handed-off session sees the same
 * files. The UI splits them back out with {@link splitAttachmentBlocks}, so the
 * bubble shows the typed text plus file chips, and the optimistic bubble still
 * matches the transcript by text.
 *
 * The backend writes this grammar and the frontend reads it. Change both
 * through this file or not at all.
 */

/** Image types sent to the model as image content blocks. Everything else is a file attachment. */
export const IMAGE_ATTACHMENT_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

/** Upload ceiling for images, which are sent to the model as-is. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Upload ceiling for every other file, which is at most referenced by path. */
export const MAX_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A text file up to this size is inlined into the prompt (~8k tokens). */
export const INLINE_ATTACHMENT_MAX_BYTES = 32 * 1024;

/** Inlined bytes across one message's files. Files past it are referenced instead. */
export const INLINE_ATTACHMENT_BUDGET_BYTES = 128 * 1024;

export const ATTACHMENT_TAG = "callboard-attachment";

export function isImageAttachmentType(mimeType: string): boolean {
  return IMAGE_ATTACHMENT_TYPES.includes(mimeType);
}

export function maxAttachmentBytes(mimeType: string): number {
  return isImageAttachmentType(mimeType) ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_FILE_ATTACHMENT_BYTES;
}

/**
 * Why a file was referenced by path rather than inlined. `unsafe-text` is a
 * text file that contains the block's own closing tag, so inlining it would
 * end its block early.
 */
export type AttachmentReferenceReason = "binary" | "too-large" | "budget" | "unsafe-text";

/** One file block, as written into the prompt and read back out of the transcript. */
export interface AttachedFile {
  /** Upload id; the stored bytes are served from GET /api/images/:id. */
  id: string;
  /**
   * The stored copy's name: the user's file name reduced to shell-safe
   * characters (`safeFileName` in the backend's image-storage.ts), so
   * `契約.pdf` arrives as `file.pdf`.
   */
  name: string;
  /** Absolute path of the stored copy on the daemon's machine. */
  path: string;
  /** Size in bytes. */
  size: number;
  /**
   * MIME type derived from the stored name's extension, not the browser's
   * report; `application/octet-stream` for anything unrecognised.
   */
  mimeType: string;
  /** Whether the block carries the file's contents. */
  inline: boolean;
}

const REFERENCE_NOTES: Record<AttachmentReferenceReason, string> = {
  binary: "Not inlined: this is not a text file. It is saved at the path above; read it from there if you need it.",
  "too-large": "Not inlined: this file is too large to include in the message. It is saved at the path above; read it from there if you need it.",
  budget:
    "Not inlined: this message's other attachments already used the inline budget. It is saved at the path above; read it from there if you need it.",
  "unsafe-text": `Not inlined: this text file contains the </${ATTACHMENT_TAG}> marker that ends this block. It is saved at the path above; read it from there if you need it.`,
};

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Whether `content` can be inlined without ending its own block early. */
export function canInlineAttachmentText(content: string): boolean {
  return !content.includes(`</${ATTACHMENT_TAG}>`);
}

/**
 * One file's block. `content` is the text to inline; pass `reason` instead to
 * reference the file by path.
 */
export function formatAttachmentBlock(file: Omit<AttachedFile, "inline">, body: { content: string } | { reason: AttachmentReferenceReason }): string {
  const inline = "content" in body;
  const attrs = [`id="${escapeAttr(file.id)}"`, `name="${escapeAttr(file.name)}"`,`path="${escapeAttr(file.path)}"`, `size="${file.size}"`, `type="${escapeAttr(file.mimeType)}"`, `inline="${inline}"`];
  const text = inline ? body.content.replace(/\n$/, "") : REFERENCE_NOTES[body.reason];
  return `<${ATTACHMENT_TAG} ${attrs.join(" ")}>\n${text}\n</${ATTACHMENT_TAG}>`;
}

/** The prompt the model receives: the user's text, then each file's block. */
export function appendAttachmentBlocks(prompt: string, blocks: string[]): string {
  if (blocks.length === 0) return prompt;
  const text = prompt.trim();
  return [...(text ? [text] : []), ...blocks].join("\n\n");
}

const BLOCK_RE = new RegExp(`\\s*<${ATTACHMENT_TAG}((?:\\s+[a-z]+="[^"]*")*)>\\n[\\s\\S]*?\\n</${ATTACHMENT_TAG}>`, "g");
const ATTR_RE = /([a-z]+)="([^"]*)"/g;

function parseAttachedFile(rawAttrs: string): AttachedFile {
  const attrs: Record<string, string> = {};
  for (const [, key, value] of rawAttrs.matchAll(ATTR_RE)) attrs[key] = unescapeAttr(value);
  return {
    id: attrs.id ?? "",
    name: attrs.name ?? "",
    path: attrs.path ?? "",
    size: Number(attrs.size) || 0,
    mimeType: attrs.type ?? "application/octet-stream",
    inline: attrs.inline === "true",
  };
}

/**
 * The inverse of {@link appendAttachmentBlocks}: the text the user typed, and
 * the files appended to it. Text without blocks comes back unchanged.
 *
 * Only the unbroken run of blocks at the very end counts, because that is the
 * only place `appendAttachmentBlocks` puts them. A block-shaped string with
 * anything but whitespace after it is something the user typed, and stays text.
 */
export function splitAttachmentBlocks(content: string): { text: string; files: AttachedFile[] } {
  if (!content.includes(`<${ATTACHMENT_TAG} `)) return { text: content, files: [] };
  let files: AttachedFile[] = [];
  let runStart = -1;
  let runEnd = -1;
  for (const match of content.matchAll(BLOCK_RE)) {
    // Each match swallows the whitespace before it, so a block that does not
    // start where the last one ended has text between them: start a new run.
    if (match.index !== runEnd) {
      files = [];
      runStart = match.index;
    }
    files.push(parseAttachedFile(match[1]));
    runEnd = match.index + match[0].length;
  }
  if (runStart < 0 || content.slice(runEnd).trim()) return { text: content, files: [] };
  return { text: content.slice(0, runStart).trim(), files };
}

/**
 * A user message as a one-line preview (chat list, titles): the typed text,
 * or the attached files' names when the message is only attachments.
 */
export function attachmentPreviewText(content: string): string {
  const { text, files } = splitAttachmentBlocks(content);
  if (text || files.length === 0) return text;
  return `📎 ${files.map((file) => file.name).join(", ")}`;
}
