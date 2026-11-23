/**
 * Message read-aloud: the `/api/voice/speech` REST surface.
 *
 * The browser turns a message's markdown into speakable plain text and posts
 * it to `POST /api/voice/speech`; the daemon normalizes, caps and chunks it,
 * synthesizes each chunk with OpenRouter's `POST /audio/speech` on the
 * account-wide key (`AgentSettings.openRouterApiKey`), joins the mp3 chunks
 * into one stream and answers the bytes. Plain REST — nothing here is on the
 * stream wire.
 */

/**
 * The model used when `AgentSettings.openRouterTtsModel` is blank.
 *
 * Kokoro 82M: the cheapest mp3-capable speech model on OpenRouter (about
 * $0.99 per million characters — a 1,000-character reply costs ~$0.001), served
 * by two providers (Together, DeepInfra) so routing has a fallback, fast, and
 * well-regarded open-weight narration quality with 54 voices. Verified against
 * the live `GET /audio/speech/models` listing (mp3 supported, `af_heart`
 * listed) on 2026-11-23.
 */
export const DEFAULT_READ_ALOUD_MODEL = "hexgrad/kokoro-82m";

/**
 * The voice sent with {@link DEFAULT_READ_ALOUD_MODEL} when
 * `AgentSettings.openRouterTtsVoice` is blank: Kokoro's flagship voice, the
 * top-graded one on its voice card. Only ever paired with the default model —
 * another model's blank voice resolves to that model's first listed voice.
 */
export const DEFAULT_READ_ALOUD_VOICE = "af_heart";

/**
 * Longest prepared text that is synthesized — about 13 minutes of speech.
 * Longer text is truncated at a sentence boundary and the response carries
 * {@link READ_ALOUD_HEADERS.truncated}.
 */
export const MAX_READ_ALOUD_CHARS = 12_000;

/** Ceiling on the raw `text` of one request. Over this is a 413 `TEXT_TOO_LONG`. */
export const MAX_READ_ALOUD_REQUEST_CHARS = 100_000;

/**
 * The longest `POST /api/voice/speech` can take on the server: an overall
 * deadline every chunk's attempts share. A client timeout should sit above
 * this. Pinned against the backend in read-aloud.test.ts.
 */
export const READ_ALOUD_SERVER_BUDGET_MS = 150_000;

/** Client-side playback speeds the player cycles through. Never sent upstream. */
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Response headers of a successful `POST /api/voice/speech`. */
export const READ_ALOUD_HEADERS = {
  /** The model slug that synthesized the audio. */
  model: "X-Read-Aloud-Model",
  /** The voice sent upstream; empty when none was sent. */
  voice: "X-Read-Aloud-Voice",
  /** Exact duration in milliseconds, when the mp3 frames could be parsed. */
  durationMs: "X-Read-Aloud-Duration-Ms",
  /** `1` when the text was cut to {@link MAX_READ_ALOUD_CHARS}. */
  truncated: "X-Read-Aloud-Truncated",
  /** How many chunks the text was synthesized in. */
  chunks: "X-Read-Aloud-Chunks",
  /** `hit` (every chunk cached), `partial`, or `miss` (none cached). */
  cache: "X-Read-Aloud-Cache",
} as const;

/** The message shown wherever read aloud is unavailable for want of a key. */
export const READ_ALOUD_NOT_CONFIGURED_MESSAGE = "Read aloud needs an OpenRouter API key — add one in Settings → API → OpenRouter.";

/** How much of a response came from the server's chunk cache. */
export type ReadAloudCacheStatus = "hit" | "partial" | "miss";

/** Body of `POST /api/voice/speech`. */
export interface ReadAloudRequest {
  /** Speakable plain text (the client strips markdown first). */
  text: string;
}

/** One entry of `GET /api/voice/speech/models`. */
export interface ReadAloudModelInfo {
  /** OpenRouter slug, e.g. "hexgrad/kokoro-82m". */
  id: string;
  /** Human-readable name. */
  name: string;
  /** The model's voices; `null` when OpenRouter lists voice as "unknown" (free text). */
  voices: string[] | null;
  /** What the server sends when `openRouterTtsVoice` is blank; `null` = omit `voice`. */
  defaultVoice: string | null;
  /** Output formats OpenRouter lists, e.g. `["mp3", "pcm"]`. */
  formats: string[];
  /** Whether the model can answer mp3. `false` ⇒ unsupported by read aloud for now. */
  mp3: boolean;
  /** USD per million input characters, for character-billed models only. */
  pricePerMillionChars?: number;
}

/** Response of `GET /api/voice/speech/models`. */
export interface ReadAloudModelsResponse {
  /** mp3-capable and PCM-only models alike, sorted by id. Empty when the listing failed. */
  models: ReadAloudModelInfo[];
  /** {@link DEFAULT_READ_ALOUD_MODEL}, so the client need not hardcode it. */
  defaultModel: string;
  /** {@link DEFAULT_READ_ALOUD_VOICE}. */
  defaultVoice: string;
}
