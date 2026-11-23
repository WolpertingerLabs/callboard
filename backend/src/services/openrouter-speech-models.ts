/**
 * The models message read-aloud can use, from two public OpenRouter listings:
 *
 *  - `GET /audio/speech/models` — every text-to-speech model, with the voices
 *    it accepts (`voice: { type: "enum", values }`, or `{ type: "unknown" }`
 *    for providers whose voice ids are free text) and its output formats.
 *    It carries no pricing.
 *  - `GET /models?output_modalities=speech` — the same models with `pricing`.
 *    For character-billed models `pricing.prompt` is USD per input character
 *    and `completion` is "0"; token-billed ones (Gemini TTS: text tokens in,
 *    audio tokens out) get no per-character price. Optional: a failed pricing
 *    fetch still lists every model.
 *
 * Both are {@link ./openrouter-listing-cache.ts} listings — the main catalog's
 * cache rules, lazy only.
 *
 * Read aloud always asks for mp3 (OpenRouter's default is `pcm`, whose sample
 * rate is documented nowhere), so a model whose formats exclude mp3 is listed
 * with `mp3: false` and refused before anything is billed.
 */
import { DEFAULT_READ_ALOUD_MODEL, DEFAULT_READ_ALOUD_VOICE, type AgentSettings, type ReadAloudModelInfo } from "shared";
import { getAgentSettings } from "./agent-settings.js";
import { OPENROUTER_MODELS_RETRY_MS, OPENROUTER_MODELS_TTL_MS } from "./openrouter-models.js";
import { OpenRouterAbortError } from "./openrouter-completion.js";
import { createOpenRouterListingCache } from "./openrouter-listing-cache.js";

/** How long a successful listing is served before re-fetching. */
export const SPEECH_MODELS_TTL_MS = OPENROUTER_MODELS_TTL_MS;

/** How long a failed listing is served before a read tries again. */
export const SPEECH_MODELS_RETRY_MS = OPENROUTER_MODELS_RETRY_MS;

/**
 * The longest a synthesis request waits on the listing to learn a model's
 * voices and formats. Past this the model is answered as unknown: it is tried
 * as mp3-capable, with no `voice` unless one is configured.
 */
export const SPEECH_MODEL_LOOKUP_TIMEOUT_MS = 5_000;

type RawSpeechModel = Omit<ReadAloudModelInfo, "defaultVoice" | "pricePerMillionChars">;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function enumValues(param: unknown): string[] | null {
  const p = asObject(param);
  if (p?.type !== "enum" || !Array.isArray(p.values)) return null;
  return p.values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function parseSpeechModels(raw: Record<string, unknown>[]): RawSpeechModel[] {
  return raw
    .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === "string" && m.id.length > 0)
    .map((m): RawSpeechModel => {
      const outputs = Array.isArray(m.output_modalities) ? m.output_modalities : [];
      const speech = outputs.map(asObject).find((o) => o?.type === "speech") ?? asObject(outputs[0]);
      const params = asObject(speech?.supported_parameters);
      const formats = enumValues(params?.response_format) ?? [];
      return {
        id: m.id,
        name: typeof m.name === "string" && m.name ? m.name : m.id,
        voices: enumValues(params?.voice),
        formats,
        // No listed formats is "not said", not "pcm only": try mp3 and let the
        // response's content type decide.
        mp3: formats.length === 0 || formats.includes("mp3"),
      };
    });
}

function parsePricing(raw: Record<string, unknown>[]): { id: string; pricePerMillionChars: number }[] {
  const out: { id: string; pricePerMillionChars: number }[] = [];
  for (const m of raw) {
    const pricing = asObject(m.pricing);
    if (typeof m.id !== "string" || !pricing) continue;
    const prompt = Number(pricing.prompt);
    const completion = Number(pricing.completion ?? "0");
    // Character-billed only: a non-zero completion price is per audio token.
    if (!Number.isFinite(prompt) || prompt < 0 || completion !== 0) continue;
    out.push({ id: m.id, pricePerMillionChars: Number((prompt * 1e6).toPrecision(6)) });
  }
  return out;
}

const speechListing = createOpenRouterListingCache<RawSpeechModel>({
  path: "/audio/speech/models",
  label: "speech models",
  parse: parseSpeechModels,
});

const pricingListing = createOpenRouterListingCache({
  path: "/models?output_modalities=speech",
  label: "speech model pricing",
  parse: parsePricing,
});

/** What the server sends as `voice` when none is configured; `null` = omit it. */
function defaultVoiceFor(id: string, voices: string[] | null): string | null {
  if (!voices || voices.length === 0) return null;
  if (id === DEFAULT_READ_ALOUD_MODEL && voices.includes(DEFAULT_READ_ALOUD_VOICE)) return DEFAULT_READ_ALOUD_VOICE;
  return voices[0];
}

/**
 * Every speech model OpenRouter lists, sorted by id — PCM-only ones included
 * (`mp3: false`) so Settings can show them as unsupported. Never rejects.
 */
export async function getReadAloudModelsAsync(): Promise<ReadAloudModelInfo[]> {
  const [models, prices] = await Promise.all([speechListing.get(), pricingListing.get()]);
  const priceById = new Map(prices.items.map((p) => [p.id, p.pricePerMillionChars]));
  return models.items
    .map((m): ReadAloudModelInfo => {
      const price = priceById.get(m.id);
      return { ...m, defaultVoice: defaultVoiceFor(m.id, m.voices), ...(price !== undefined ? { pricePerMillionChars: price } : {}) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The configured read-aloud model slug, else {@link DEFAULT_READ_ALOUD_MODEL}. */
export function resolveReadAloudModel(settings?: AgentSettings): string {
  const configured = (settings ?? getAgentSettings()).openRouterTtsModel;
  return (typeof configured === "string" ? configured.trim() : "") || DEFAULT_READ_ALOUD_MODEL;
}

/**
 * `id`'s listing entry, or `null` when the listing cannot place it — a custom
 * slug, or a listing that has not loaded within
 * {@link SPEECH_MODEL_LOOKUP_TIMEOUT_MS}. Rejects with an `AbortError` as soon
 * as `signal` aborts; the listing fetch itself carries on and warms the cache.
 */
export async function lookupReadAloudModel(id: string, signal?: AbortSignal): Promise<ReadAloudModelInfo | null> {
  if (signal?.aborted) throw new OpenRouterAbortError("Speech model lookup cancelled by the caller", "caller");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const capped = new Promise<null>((resolve, reject) => {
    timer = setTimeout(() => resolve(null), SPEECH_MODEL_LOOKUP_TIMEOUT_MS);
    onAbort = () => reject(new OpenRouterAbortError("Speech model lookup cancelled by the caller", "caller"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const models = await Promise.race([getReadAloudModelsAsync(), capped]);
    return models?.find((m) => m.id === id) ?? null;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The `voice` to send with `model`, or `null` to omit it:
 *  1. `openRouterTtsVoice`, if non-blank;
 *  2. {@link DEFAULT_READ_ALOUD_VOICE} for {@link DEFAULT_READ_ALOUD_MODEL};
 *  3. the model's first listed voice;
 *  4. nothing — some providers pick their own, the rest answer a 400 that is
 *     surfaced as-is.
 *
 * `info`, when given (an entry or `null`), is the caller's own lookup and is
 * used instead of looking again — so a slow listing costs one cap, not two.
 */
export async function resolveReadAloudVoice(
  model: string,
  settings: AgentSettings,
  signal?: AbortSignal,
  info?: ReadAloudModelInfo | null,
): Promise<string | null> {
  const configured = typeof settings.openRouterTtsVoice === "string" ? settings.openRouterTtsVoice.trim() : "";
  if (configured) return configured;
  if (model === DEFAULT_READ_ALOUD_MODEL) return DEFAULT_READ_ALOUD_VOICE;
  const entry = info !== undefined ? info : await lookupReadAloudModel(model, signal);
  return entry?.defaultVoice ?? null;
}

/** Test-only: drop both cached listings and any in-flight fetch. */
export function resetSpeechModelsCacheForTesting(): void {
  speechListing.reset();
  pricingListing.reset();
}
