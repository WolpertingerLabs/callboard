/**
 * Drain a callboard prompt into the text + images Cline's session input takes.
 *
 * ## Why this exists
 *
 * `AgentQueryRequest.prompt` is `string | AsyncIterable<unknown>`, and the
 * streaming form is not an edge case — `services/claude.ts` uses it for
 * multimodal input **and whenever MCP servers are present**, which for callboard
 * is very nearly always. The adapter's first cut rejected a non-string prompt as
 * a caller error; the first real chat through the API proved otherwise:
 *
 *     message_error: Cline adapter requires a string prompt;
 *                    streaming-input mode is not supported by ClineCore.send()
 *
 * The routing was correct — the settings block ran, the provider resolved, the
 * model was pinned — and the turn still could not start. So the streaming form
 * is the normal path and has to be flattened, exactly as
 * `acp/AcpAgentQuery.resolveAcpPrompt` flattens it for ACP.
 *
 * ## Where the pieces go
 *
 * `StartSessionInput` and `SendSessionInput` both take `prompt: string` beside a
 * separate `userImages: string[]`, so the two halves stay separate rather than
 * being spliced into one blob: text is joined, and images ride alongside as data
 * URIs. Unsupported blocks are counted and warned about rather than dropped
 * silently.
 *
 * @see ../acp/AcpAgentQuery.ts (`resolveAcpPrompt` — the same flattening, for ACP)
 */
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("cline-prompt");

export interface ResolvedClinePrompt {
  /** Flattened text. May be empty when the prompt was images only. */
  prompt: string;
  /** Inline images as `data:<mime>;base64,<data>` URIs. */
  userImages: string[];
}

export async function resolveClinePrompt(prompt: string | AsyncIterable<unknown>): Promise<ResolvedClinePrompt> {
  if (typeof prompt === "string") return { prompt, userImages: [] };

  const texts: string[] = [];
  const userImages: string[] = [];
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
        const uri = toDataUri(block);
        if (uri) userImages.push(uri);
        else dropped++;
        continue;
      }
      dropped++;
    }
  }

  if (dropped > 0) log.warn(`resolveClinePrompt dropped ${dropped} unsupported block(s)`);
  return { prompt: texts.join("\n\n"), userImages };
}

/**
 * Anthropic's nested image block → a data URI.
 *
 * Only `base64` sources are convertible. A `url` source is left to the caller's
 * `dropped` count rather than passed through: callboard stores images itself and
 * never produces url sources, so one appearing here means something upstream
 * changed and should be visible in the log rather than silently half-working.
 */
function toDataUri(block: object): string | null {
  const source = (block as { source?: unknown }).source;
  if (!source || typeof source !== "object") return null;
  const { type, media_type: mediaType, data } = source as { type?: unknown; media_type?: unknown; data?: unknown };
  if (type !== "base64" || typeof data !== "string" || !data) return null;
  return `data:${typeof mediaType === "string" && mediaType ? mediaType : "image/png"};base64,${data}`;
}
