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

/** Why a file was referenced by path rather than inlined. */
export type AttachmentReferenceReason = "binary" | "too-large" | "budget";

/** One file block, as written into the prompt and read back out of the transcript. */
export interface AttachedFile {
  /** Upload id; the stored bytes are served from GET /api/images/:id. */
  id: string;
  /** The name the user's file had. */
  name: string;
  /** Absolute path of the stored copy on the daemon's machine. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** MIME type as the browser reported it; may be `application/octet-stream`. */
  mimeType: string;
  /** Whether the block carries the file's contents. */
  inline: boolean;
}

const REFERENCE_NOTES: Record<AttachmentReferenceReason, string> = {
  binary: "Not inlined: this is not a text file. It is saved at the path above; read it from there if you need it.",
  "too-large": "Not inlined: this file is too large to include in the message. It is saved at the path above; read it from there if you need it.",
  budget:
    "Not inlined: this message's other attachments already used the inline budget. It is saved at the path above; read it from there if you need it.",
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

/**
 * The inverse of {@link appendAttachmentBlocks}: the text the user typed, and
 * the files appended to it. Text without blocks comes back unchanged.
 */
export function splitAttachmentBlocks(content: string): { text: string; files: AttachedFile[] } {
  if (!content.includes(`<${ATTACHMENT_TAG} `)) return { text: content, files: [] };
  const files: AttachedFile[] = [];
  const text = content.replace(BLOCK_RE, (_match, rawAttrs: string) => {
    const attrs: Record<string, string> = {};
    for (const [, key, value] of rawAttrs.matchAll(ATTR_RE)) attrs[key] = unescapeAttr(value);
    files.push({
      id: attrs.id ?? "",
      name: attrs.name ?? "",
      path: attrs.path ?? "",
      size: Number(attrs.size) || 0,
      mimeType: attrs.type ?? "application/octet-stream",
      inline: attrs.inline === "true",
    });
    return "";
  });
  return { text: text.trim(), files };
}
