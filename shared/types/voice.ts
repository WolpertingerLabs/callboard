/**
 * Composer voice input: the `/api/voice` REST surface.
 *
 * The browser records, converts to 16 kHz mono 16-bit PCM WAV, and uploads it
 * to `POST /api/voice/transcribe`; the daemon forwards it to OpenRouter on the
 * account-wide key (`AgentSettings.openRouterApiKey`) and answers with the
 * transcript. The transcript is only ever inserted into the composer — never
 * sent on the user's behalf.
 */

/**
 * The model used when `AgentSettings.openRouterVoiceModel` is blank.
 *
 * A dedicated speech-to-text model rather than an audio-capable chat model:
 * its output is the verbatim words spoken and nothing else, so dictated text
 * has no prompt-injection surface and there is no prompt to engineer. It is the
 * cheapest mainstream transcriber on OpenRouter (about $0.0002/min), fast, and
 * multilingual.
 */
export const DEFAULT_VOICE_MODEL = "openai/whisper-large-v3-turbo";

/** Longest recording the composer will make before stopping on its own. */
export const MAX_VOICE_RECORDING_MS = 5 * 60 * 1000;

/**
 * Upload ceiling for one recording. Five minutes of 16 kHz mono 16-bit WAV is
 * 32 KB/s × 300 s ≈ 9.6 MB; the rest is headroom.
 */
export const MAX_VOICE_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * The longest `POST /api/voice/transcribe` can take on the server: the 5 s
 * model-kind lookup cap, three 45 s upstream attempts, and 2 s of backoff
 * between them. A client timeout should sit comfortably above this. Pinned
 * against the backend's own constants in voice-transcription.test.ts.
 */
export const VOICE_SERVER_BUDGET_MS = 142_000;

/**
 * How a voice model is called:
 *  - `transcription` — a dedicated speech-to-text model, via OpenRouter's
 *    `POST /audio/transcriptions`.
 *  - `chat` — an audio-input chat model, via `POST /chat/completions` with a
 *    strict verbatim-transcription system prompt.
 */
export type VoiceModelKind = "transcription" | "chat";

/** One entry of `GET /api/voice/models`. */
export interface VoiceModelInfo {
  /** OpenRouter slug, e.g. "openai/whisper-large-v3-turbo". */
  id: string;
  /** Human-readable name. */
  name: string;
  kind: VoiceModelKind;
}

/** Response of `GET /api/voice/models`. */
export interface VoiceModelsResponse {
  /** Transcription models first, then chat models; each group sorted by id. */
  models: VoiceModelInfo[];
  /** {@link DEFAULT_VOICE_MODEL}, so the client need not hardcode it. */
  defaultModel: string;
}

/** Response of `POST /api/voice/transcribe`. */
export interface TranscribeResponse {
  /** The transcript, trimmed. `""` when no speech was detected. */
  text: string;
  /** The model slug that produced it. */
  model: string;
  /** Wall-clock time spent upstream, in milliseconds. */
  durationMs: number;
  /** Charged cost in USD, when OpenRouter reports it. */
  costUsd?: number;
}

/** `code` values on `/api/voice` error bodies (`{ error, code }`). */
export const VOICE_ERROR_CODES = {
  noAudio: "NO_AUDIO",
  unsupportedAudio: "UNSUPPORTED_AUDIO",
  invalidLanguage: "INVALID_LANGUAGE",
  notConfigured: "OPENROUTER_NOT_CONFIGURED",
  tooLarge: "LIMIT_FILE_SIZE",
  failed: "TRANSCRIPTION_FAILED",
  timeout: "TRANSCRIPTION_TIMEOUT",
} as const;

export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[keyof typeof VOICE_ERROR_CODES];

/** The message shown wherever voice input is unavailable for want of a key. */
export const VOICE_NOT_CONFIGURED_MESSAGE = "Voice input needs an OpenRouter API key — add one in Settings → API → OpenRouter.";
