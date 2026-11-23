/**
 * The models composer voice input can use, from two OpenRouter sources:
 *
 *  - **Dedicated speech-to-text models** (`kind: "transcription"`), served by
 *    `POST /audio/transcriptions`. These are NOT in the default `/models`
 *    response at all — only `/models?output_modalities=transcription` lists
 *    them — so they are fetched and cached here.
 *  - **Audio-input chat models** (`kind: "chat"`), taken from the main catalog
 *    ({@link ./openrouter-models.ts}) by `inputModalities` including `audio`.
 *    OpenRouter's own routers (`openrouter/*`) are left out: they carry no audio
 *    pricing and route to whichever model they like.
 *
 * The transcription listing is an {@link ./openrouter-listing-cache.ts}
 * listing: the main catalog's cache rules — the TTL, the short retry window
 * after a failure, carrying the last good list forward, and dropping it when
 * the configured endpoint changes — but lazy only: no boot warm-up and no
 * interval. Nothing synchronous reads it, and the only readers (Settings → API
 * and a transcription request) can wait.
 */
import { DEFAULT_VOICE_MODEL, type AgentSettings, type VoiceModelInfo, type VoiceModelKind } from "shared";
import { getAgentSettings } from "./agent-settings.js";
import { OPENROUTER_MODELS_RETRY_MS, OPENROUTER_MODELS_TTL_MS, getOpenRouterModelsAsync } from "./openrouter-models.js";
import { OpenRouterAbortError } from "./openrouter-completion.js";
import { createOpenRouterListingCache } from "./openrouter-listing-cache.js";

/** How long a successful transcription listing is served before re-fetching. */
export const VOICE_MODELS_TTL_MS = OPENROUTER_MODELS_TTL_MS;

/** How long a failed listing is served before a read tries again. */
export const VOICE_MODELS_RETRY_MS = OPENROUTER_MODELS_RETRY_MS;

const transcriptionListing = createOpenRouterListingCache<VoiceModelInfo>({
  path: "/models?output_modalities=transcription",
  label: "transcription models",
  parse: (raw) =>
    raw
      .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m): VoiceModelInfo => ({ id: m.id, name: typeof m.name === "string" && m.name ? m.name : m.id, kind: "transcription" })),
});

/**
 * Every model voice input can use: transcription models first, then
 * audio-input chat models, each group sorted by id. A model listed by both
 * sources is kept once, as `transcription` — the dedicated endpoint is the one
 * built for the job. Never rejects.
 */
export async function getVoiceModelsAsync(): Promise<VoiceModelInfo[]> {
  const [transcription, catalog] = await Promise.all([transcriptionListing.get(), getOpenRouterModelsAsync().catch(() => [])]);
  const seen = new Set(transcription.items.map((m) => m.id));
  const chat = catalog
    .filter((m) => m.inputModalities?.includes("audio") && !m.id.startsWith("openrouter/") && !seen.has(m.id))
    .map((m): VoiceModelInfo => ({ id: m.id, name: m.name || m.id, kind: "chat" }));
  const byId = (a: VoiceModelInfo, b: VoiceModelInfo) => a.id.localeCompare(b.id);
  return [...[...transcription.items].sort(byId), ...chat.sort(byId)];
}

/** The configured voice model slug, else {@link DEFAULT_VOICE_MODEL}. */
export function resolveVoiceModel(settings?: AgentSettings): string {
  const configured = (settings ?? getAgentSettings()).openRouterVoiceModel;
  return (typeof configured === "string" ? configured.trim() : "") || DEFAULT_VOICE_MODEL;
}

/**
 * The longest a transcription will wait on the voice-model list to learn a
 * model's kind. A cold listing fetch may take up to its own 30 s timeout; a
 * recording should not, so past this the kind is answered as unknown.
 */
export const VOICE_KIND_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * How to call `model`: its kind from the voice-model list, or `null` when the
 * list cannot place it — a custom slug, or a listing that has not loaded within
 * {@link VOICE_KIND_LOOKUP_TIMEOUT_MS}. The caller decides what unknown means
 * (see voice-transcription.ts).
 *
 * {@link DEFAULT_VOICE_MODEL} is answered without a lookup: it is the one slug
 * known to be a transcriber, and the common case should never wait on a fetch.
 *
 * Rejects with an `AbortError` as soon as `signal` aborts. The listing fetch
 * itself carries on and warms the cache for the next caller.
 */
export async function resolveVoiceModelKind(model: string, signal?: AbortSignal): Promise<VoiceModelKind | null> {
  if (model === DEFAULT_VOICE_MODEL) return "transcription";
  if (signal?.aborted) throw new OpenRouterAbortError("Voice model lookup cancelled by the caller", "caller");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const capped = new Promise<null>((resolve, reject) => {
    timer = setTimeout(() => resolve(null), VOICE_KIND_LOOKUP_TIMEOUT_MS);
    onAbort = () => reject(new OpenRouterAbortError("Voice model lookup cancelled by the caller", "caller"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const models = await Promise.race([getVoiceModelsAsync(), capped]);
    return models?.find((m) => m.id === model)?.kind ?? null;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Test-only: drop the cached listing and any in-flight fetch. */
export function resetVoiceModelsCacheForTesting(): void {
  transcriptionListing.reset();
}
