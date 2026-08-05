/**
 * Single source of truth for the OR Responses-API `input_image` block shape.
 *
 * The harness forwards `UserInput.content` verbatim into `callModel({ input })`,
 * and `@openrouter/sdk` >= 1.x validates every block against its content-block
 * union before the request leaves the process. That schema is the JS-side
 * (camelCase) form — `imageUrl`, with `detail` REQUIRED — and it remaps to the
 * wire's `image_url` itself. Two ways to get this wrong, both silent-ish:
 *
 *   - `{ type: "input_image", image_url }` — rejected outright, the whole
 *     request dies with `Input validation failed` (SDK 0.13.x accepted it,
 *     which is why this shape shipped).
 *   - `{ type: "input_image", image_url, detail }` — *passes* validation, then
 *     zod strips the unrecognized `image_url` key and the model receives an
 *     image block with no image.
 *
 * So writers go through {@link orImageBlock}. Readers go through
 * {@link blockImageUrl}, which accepts both spellings: logs written before
 * this move carry `image_url`, and the harness persists whatever we hand it.
 */

/** The camelCase `input_image` block the pinned SDK validates and emits. */
export interface OrImageBlock {
  type: "input_image";
  imageUrl: string;
  detail: "auto";
}

/** Build an `input_image` block from a data URI or a remote image URL. */
export function orImageBlock(imageUrl: string): OrImageBlock {
  return { type: "input_image", imageUrl, detail: "auto" };
}

/**
 * Read the URL off an `input_image` block, tolerating both the camelCase form
 * we write today and the snake_case form in logs written before it. Returns
 * `null` when neither key holds a string.
 */
export function blockImageUrl(block: { imageUrl?: unknown; image_url?: unknown }): string | null {
  if (typeof block.imageUrl === "string") return block.imageUrl;
  if (typeof block.image_url === "string") return block.image_url;
  return null;
}
