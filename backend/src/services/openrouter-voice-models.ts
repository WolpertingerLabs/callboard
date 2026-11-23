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
 * The transcription listing borrows the main catalog's cache rules — the TTL,
 * the short retry window after a failure, carrying the last good list forward,
 * and dropping it when the configured endpoint changes — but is lazy only: no
 * boot warm-up and no interval. Nothing synchronous reads it, and the only
 * readers (Settings → API and a transcription request) can wait.
 */
import { DEFAULT_VOICE_MODEL, type AgentSettings, type VoiceModelInfo, type VoiceModelKind } from "shared";
import { getAgentSettings } from "./agent-settings.js";
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";
import { OPENROUTER_MODELS_RETRY_MS, OPENROUTER_MODELS_TTL_MS, getOpenRouterModelsAsync } from "./openrouter-models.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("openrouter-voice-models");

/** How long a successful transcription listing is served before re-fetching. */
export const VOICE_MODELS_TTL_MS = OPENROUTER_MODELS_TTL_MS;

/** How long a failed listing is served before a read tries again. */
export const VOICE_MODELS_RETRY_MS = OPENROUTER_MODELS_RETRY_MS;

/** Ceiling on one listing fetch — the same as the main catalog's, for the same reason. */
const FETCH_TIMEOUT_MS = 30_000;

const TRANSCRIPTION_MODELS_PATH = "/models?output_modalities=transcription";

interface TranscriptionModelsCache {
  models: VoiceModelInfo[];
  fetchedAt: number;
  ok: boolean;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
}

let cache: TranscriptionModelsCache | null = null;
let cacheEndpoint: string | undefined;
let fetchPromise: Promise<TranscriptionModelsCache> | null = null;
/** Bumped on invalidation so a fetch for the previous host cannot overwrite the new one. */
let generation = 0;

/** Never rejects: a failure resolves to the last known-good list. */
async function fetchTranscriptionModels(previous: VoiceModelInfo[]): Promise<TranscriptionModelsCache> {
  try {
    const url = resolveOpenRouterApiUrl(TRANSCRIPTION_MODELS_PATH);
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data?: unknown };
    const raw = Array.isArray(body.data) ? (body.data as unknown[]) : [];
    const models = raw
      .filter((m): m is RawModel => m !== null && typeof m === "object")
      .filter((m): m is RawModel & { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m): VoiceModelInfo => ({ id: m.id, name: typeof m.name === "string" && m.name ? m.name : m.id, kind: "transcription" }));
    log.info(`OpenRouter transcription models fetched: ${models.length}`);
    return { models, fetchedAt: Date.now(), ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to fetch OpenRouter transcription models: ${message}${previous.length > 0 ? ` (keeping ${previous.length} cached)` : ""}`);
    return { models: previous, fetchedAt: Date.now(), ok: false };
  }
}

function isFresh(entry: TranscriptionModelsCache): boolean {
  return Date.now() - entry.fetchedAt < (entry.ok ? VOICE_MODELS_TTL_MS : VOICE_MODELS_RETRY_MS);
}

/** Drop the cache when the resolved endpoint changes: it describes another host. */
function checkCacheEndpoint(): void {
  let endpoint: string;
  try {
    endpoint = resolveOpenRouterApiUrl(TRANSCRIPTION_MODELS_PATH);
  } catch {
    endpoint = "invalid-endpoint";
  }
  if (cacheEndpoint !== undefined && endpoint !== cacheEndpoint) {
    generation++;
    cache = null;
    fetchPromise = null;
  }
  cacheEndpoint = endpoint;
}

function ensureTranscriptionModels(): Promise<TranscriptionModelsCache> {
  checkCacheEndpoint();
  if (cache && isFresh(cache)) return Promise.resolve(cache);
  if (!fetchPromise) {
    const gen = generation;
    fetchPromise = fetchTranscriptionModels(cache?.models ?? [])
      .then((result) => {
        if (gen === generation) cache = result;
        return result;
      })
      .finally(() => {
        if (gen === generation) fetchPromise = null;
      });
  }
  return fetchPromise;
}

/**
 * Every model voice input can use: transcription models first, then
 * audio-input chat models, each group sorted by id. A model listed by both
 * sources is kept once, as `transcription` — the dedicated endpoint is the one
 * built for the job. Never rejects.
 */
export async function getVoiceModelsAsync(): Promise<VoiceModelInfo[]> {
  const [transcription, catalog] = await Promise.all([ensureTranscriptionModels(), getOpenRouterModelsAsync().catch(() => [])]);
  const seen = new Set(transcription.models.map((m) => m.id));
  const chat = catalog
    .filter((m) => m.inputModalities?.includes("audio") && !m.id.startsWith("openrouter/") && !seen.has(m.id))
    .map((m): VoiceModelInfo => ({ id: m.id, name: m.name || m.id, kind: "chat" }));
  const byId = (a: VoiceModelInfo, b: VoiceModelInfo) => a.id.localeCompare(b.id);
  return [...[...transcription.models].sort(byId), ...chat.sort(byId)];
}

/** The configured voice model slug, else {@link DEFAULT_VOICE_MODEL}. */
export function resolveVoiceModel(settings?: AgentSettings): string {
  const configured = (settings ?? getAgentSettings()).openRouterVoiceModel;
  return (typeof configured === "string" ? configured.trim() : "") || DEFAULT_VOICE_MODEL;
}

/**
 * How to call `model`: its kind from the voice-model list. A slug the list does
 * not know (a custom one, or the list could not be fetched) goes to
 * speech-to-text only if it is the default — the one slug known to be a
 * transcriber — and to chat completions otherwise.
 */
export async function resolveVoiceModelKind(model: string): Promise<VoiceModelKind> {
  const found = (await getVoiceModelsAsync()).find((m) => m.id === model);
  if (found) return found.kind;
  return model === DEFAULT_VOICE_MODEL ? "transcription" : "chat";
}

/** Test-only: drop the cached listing and any in-flight fetch. */
export function resetVoiceModelsCacheForTesting(): void {
  generation++;
  cache = null;
  fetchPromise = null;
  cacheEndpoint = undefined;
}
