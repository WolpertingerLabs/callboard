/**
 * Drain a callboard prompt into the text + images pi's `prompt()` takes.
 *
 * ## Why this file exists when the plan's Phase 1 list does not mention it
 *
 * `AgentQueryRequest.prompt` is `string | AsyncIterable<unknown>`, and the
 * streaming form is not an edge case — `services/claude.ts` uses it for
 * multimodal input **and whenever MCP servers are present**, which for callboard
 * is very nearly always. The Cline landing discovered this by shipping without
 * it and watching the first real chat fail with `"streaming-input mode is not
 * supported"` (`plans/cline-spike-findings.md` §9). The plan's pi file list
 * inherited the same omission; this is the same fix, applied before rather than
 * after.
 *
 * ## Where the pieces go
 *
 * `PromptOptions` takes `images?: ImageContent[]` beside the text, so the two
 * halves stay separate rather than being spliced into one blob. pi's
 * `ImageContent` is `{ type: "image", data, mimeType }` — structured, not a data
 * URI, which is what the Cline bridge had to produce. So the conversion from
 * Anthropic's nested `source.data` / `source.media_type` is a straight remap with
 * no string building.
 *
 * Unsupported blocks are counted and warned about rather than dropped silently.
 *
 * @see ../cline/promptAdapter.ts (the same flattening, into data URIs)
 */
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("pi-prompt");

/** pi's inline image block, structurally. */
export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ResolvedPiPrompt {
  /** Flattened text. May be empty when the prompt was images only. */
  prompt: string;
  /** Inline images in pi's own content shape. */
  images: PiImageContent[];
}

export async function resolvePiPrompt(prompt: string | AsyncIterable<unknown>): Promise<ResolvedPiPrompt> {
  if (typeof prompt === "string") return { prompt, images: [] };

  const texts: string[] = [];
  const images: PiImageContent[] = [];
  let dropped = 0;

  for await (const message of prompt) {
    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") {
      if (content) texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") {
        dropped++;
        continue;
      }
      const type = (block as { type?: unknown }).type;
      if (type === "text") {
        const text = String((block as { text?: unknown }).text ?? "");
        if (text) texts.push(text);
        continue;
      }
      if (type === "image") {
        const image = toPiImage(block);
        if (image) images.push(image);
        else dropped++;
        continue;
      }
      dropped++;
    }
  }

  if (dropped > 0) log.warn(`resolvePiPrompt dropped ${dropped} unsupported block(s)`);
  return { prompt: texts.join("\n\n"), images };
}

/**
 * Anthropic's nested image block → pi's {@link PiImageContent}.
 *
 * Only `base64` sources are convertible. A `url` source is left to the caller's
 * `dropped` count rather than passed through: callboard stores images itself and
 * never produces url sources, so one appearing here means something upstream
 * changed and should be visible in the log rather than silently half-working.
 */
function toPiImage(block: object): PiImageContent | null {
  const source = (block as { source?: unknown }).source;
  if (!source || typeof source !== "object") return null;
  const { type, media_type: mediaType, data } = source as { type?: unknown; media_type?: unknown; data?: unknown };
  if (type !== "base64" || typeof data !== "string" || !data) return null;
  return { type: "image", data, mimeType: typeof mediaType === "string" && mediaType ? mediaType : "image/png" };
}
