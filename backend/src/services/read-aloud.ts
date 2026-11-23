/**
 * Read aloud — one message's text in, one mp3 out, on the account-wide
 * OpenRouter key.
 *
 * The text (already stripped of markdown by the client) is normalized, cut to
 * {@link MAX_READ_ALOUD_CHARS} at a sentence boundary, and split into
 * sentence-packed chunks of at most {@link READ_ALOUD_CHUNK_CHARS}. Each chunk
 * is one `POST {base}/audio/speech` — always `response_format: "mp3"`
 * (OpenRouter's default is PCM, whose sample rate it documents nowhere), never
 * `speed` (playback speed is the client's) — run at most
 * {@link READ_ALOUD_CONCURRENCY} at a time, and the results are joined
 * frame-by-frame ({@link ../utils/mp3.ts}) into one stream with an exact
 * duration.
 *
 * Never double-bill:
 *  - Every synthesized chunk is cached in memory, keyed by content (endpoint,
 *    model, voice, format, text) — neither `cwd` nor `workspaceId`: the same
 *    text in the same voice is the same audio wherever it appears. A replay
 *    in the same daemon lifetime is free.
 *  - A chunk already being synthesized is shared, not requested again, so a
 *    double-click or two tabs make one upstream call.
 *  - Upstream calls are NOT tied to the caller's signal. A caller that goes
 *    away stops new chunks being scheduled, but the ones already started run
 *    to completion into the cache — they are billed either way, and a retry of
 *    the same message then reuses them.
 *  - A 200 whose body is empty, not audio, PCM, or an error is never retried:
 *    the provider may already have billed it.
 *
 * Retry rules are otherwise the utility completion client's ({@link
 * ./openrouter-completion.ts}): 429/5xx/network failures retry twice with
 * backoff; a 4xx, a timeout or a caller cancellation does not. Every attempt
 * is capped at {@link READ_ALOUD_ATTEMPT_TIMEOUT_MS} and by the whole
 * request's {@link READ_ALOUD_SERVER_BUDGET_MS} deadline.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_READ_ALOUD_MODEL,
  MAX_READ_ALOUD_CHARS,
  READ_ALOUD_NOT_CONFIGURED_MESSAGE,
  READ_ALOUD_SERVER_BUDGET_MS,
  type ReadAloudCacheStatus,
} from "shared";
import { getAgentSettings } from "./agent-settings.js";
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";
import { OpenRouterAbortError, RETRY_DELAYS_MS, delay, isRetryable } from "./openrouter-completion.js";
import { lookupReadAloudModel, resolveReadAloudModel, resolveReadAloudVoice } from "./openrouter-speech-models.js";
import { joinMp3 } from "../utils/mp3.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("read-aloud");

/**
 * Longest chunk sent in one upstream call. OpenRouter's spec has no input cap,
 * but some models list a 4,096-token context; 1,500 characters is comfortably
 * inside every provider's limit and short enough that chunks run in parallel.
 */
export const READ_ALOUD_CHUNK_CHARS = 1_500;

/** Chunks synthesized at once. Order is preserved regardless. */
export const READ_ALOUD_CONCURRENCY = 3;

/** How long one upstream attempt may take, before the overall deadline caps it further. */
export const READ_ALOUD_ATTEMPT_TIMEOUT_MS = 45_000;

/** Byte budget of the in-memory chunk cache. Least recently used chunks go first. */
export const READ_ALOUD_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Attempts per chunk: the first plus one per backoff delay. */
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Upstream error text is cut to this before it reaches the client. */
const MAX_ERROR_DETAIL = 300;

/** No account-wide OpenRouter key is configured. The route answers 409. */
export class ReadAloudNotConfiguredError extends Error {
  constructor() {
    super(READ_ALOUD_NOT_CONFIGURED_MESSAGE);
    this.name = "ReadAloudNotConfiguredError";
  }
}

/** The configured model is known to answer PCM only. The route answers 400. */
export class ReadAloudUnsupportedModelError extends Error {
  constructor(readonly model: string) {
    super(`${model} only produces PCM audio, which read aloud does not support yet — choose another model in Settings → API → OpenRouter.`);
    this.name = "ReadAloudUnsupportedModelError";
  }
}

/**
 * OpenRouter refused or failed a chunk. `message` is OpenRouter's own
 * explanation (capped), suitable to show; `status` is the HTTP status when
 * there was one, which is what decides whether it is retried. `retryable:
 * false` overrides that — for a response that may already have been billed.
 */
export class ReadAloudUpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "ReadAloudUpstreamError";
  }
}

function shouldRetry(err: unknown): boolean {
  if (err instanceof ReadAloudUpstreamError && err.retryable === false) return false;
  return isRetryable(err);
}

// ── Text preparation ────────────────────────────────────────────────

/**
 * Collapse runs of spaces and tabs, drop control characters, keep at most one
 * blank line between paragraphs, trim. Idempotent.
 */
export function normalizeSpeechInput(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

function sentencesOf(text: string): string[] {
  return Array.from(sentenceSegmenter.segment(text), (s) => s.segment);
}

/**
 * `end`, moved back one UTF-16 unit if cutting there would split a surrogate
 * pair (an emoji, or a CJK Extension B character) in half.
 */
function safeCut(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const before = text.charCodeAt(end - 1);
  return before >= 0xd800 && before <= 0xdbff ? end - 1 : end;
}

/** At most `max` units of `text`: up to its last whitespace when there is one, else a surrogate-safe hard cut. */
function cutAtWhitespace(text: string, max: number): string {
  const head = text.slice(0, safeCut(text, max));
  const space = head.search(/\s\S*$/);
  return space > 0 ? head.slice(0, space) : head;
}

/**
 * `text` cut to at most `max` characters at the last sentence boundary that
 * fits. When that boundary keeps less than half the budget — a short first
 * sentence followed by a huge one, say — the overflowing sentence is cut at
 * its last whitespace instead, so "Note. <12k of text>" reads more than "Note."
 */
export function truncateSpeechText(text: string, max = MAX_READ_ALOUD_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let out = "";
  let overflow = "";
  for (const s of sentencesOf(text)) {
    if (out.length + s.length > max) {
      overflow = s;
      break;
    }
    out += s;
  }
  if (out.trim().length < max / 2 && overflow) out += cutAtWhitespace(overflow, max - out.length);
  return { text: out.trim(), truncated: true };
}

/** Split one over-long piece at `pattern` boundaries (kept on the left), else hard-cut. */
function splitPiece(piece: string, max: number): string[] {
  if (piece.length <= max) return [piece];
  for (const pattern of [/(?<=[,;:—])\s+/, /\s+/]) {
    const parts = piece.split(pattern).filter(Boolean);
    if (parts.length > 1) return pack(parts, max, (p) => splitPiece(p, max));
  }
  // One unbroken run: cut by length, never inside a surrogate pair.
  const out: string[] = [];
  for (let i = 0; i < piece.length; ) {
    const end = Math.max(i + 1, safeCut(piece, i + max));
    out.push(piece.slice(i, end));
    i = end;
  }
  return out;
}

/** Greedily pack `parts` (joined by single spaces) into strings of at most `max`. */
function pack(parts: string[], max: number, split: (p: string) => string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const raw of parts) {
    for (const part of raw.length > max ? split(raw) : [raw]) {
      const next = current ? `${current} ${part}` : part;
      if (next.length <= max) {
        current = next;
      } else {
        if (current) out.push(current);
        current = part;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Sentence-packed chunks of at most `max` characters, in order. A sentence
 * longer than `max` is split at clause punctuation, then at whitespace, then
 * (a single unbroken run) by length.
 */
export function chunkSpeechText(text: string, max = READ_ALOUD_CHUNK_CHARS): string[] {
  const sentences = sentencesOf(text)
    .map((s) => s.trim())
    .filter(Boolean);
  return pack(sentences, max, (s) => splitPiece(s, max));
}

// ── Chunk cache ─────────────────────────────────────────────────────

let cacheMaxBytes = READ_ALOUD_CACHE_MAX_BYTES;
let cacheBytes = 0;
/** Insertion order is recency order: a hit is re-inserted at the end. */
const chunkCache = new Map<string, Buffer>();
const inFlight = new Map<string, Promise<Buffer>>();

function cacheGet(key: string): Buffer | undefined {
  const hit = chunkCache.get(key);
  if (hit) {
    chunkCache.delete(key);
    chunkCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, audio: Buffer): void {
  if (audio.length > cacheMaxBytes) return;
  const old = chunkCache.get(key);
  if (old) {
    cacheBytes -= old.length;
    chunkCache.delete(key);
  }
  chunkCache.set(key, audio);
  cacheBytes += audio.length;
  for (const [k, v] of chunkCache) {
    if (cacheBytes <= cacheMaxBytes) break;
    chunkCache.delete(k);
    cacheBytes -= v.length;
  }
}

function chunkKey(url: string, model: string, voice: string | null, chunk: string): string {
  return createHash("sha256")
    .update(JSON.stringify([url, model, voice ?? "", "mp3", chunk]))
    .digest("hex");
}

/** Test-only: empty the chunk cache and in-flight map, optionally with a smaller cap. */
export function resetReadAloudCacheForTesting(maxBytes = READ_ALOUD_CACHE_MAX_BYTES): void {
  chunkCache.clear();
  inFlight.clear();
  cacheBytes = 0;
  cacheMaxBytes = maxBytes;
}

// ── Synthesis ───────────────────────────────────────────────────────

export interface SynthesizeSpeechRequest {
  /** Speakable plain text. */
  text: string;
  /** Caller cancellation. Stops new chunks; started ones finish into the cache. */
  signal?: AbortSignal;
}

export interface SynthesizeSpeechResult {
  /** One mp3 stream. */
  audio: Buffer;
  model: string;
  /** The voice sent upstream; `null` when none was. */
  voice: string | null;
  /** Exact duration, when every chunk's frames parsed. */
  durationMs?: number;
  /** Whether the text was cut to {@link MAX_READ_ALOUD_CHARS}. */
  truncated: boolean;
  chunks: number;
  cache: ReadAloudCacheStatus;
}

interface ChunkJob {
  url: string;
  apiKey: string;
  model: string;
  voice: string | null;
  input: string;
  deadline: number;
}

const callerAbort = () => new OpenRouterAbortError("Read aloud cancelled by the caller", "caller");
const deadlineTimeout = () => new OpenRouterAbortError(`Read aloud exceeded its ${READ_ALOUD_SERVER_BUDGET_MS}ms budget`, "timeout");

/** Synthesize `text`. See the module comment. */
export async function synthesizeSpeech(req: SynthesizeSpeechRequest): Promise<SynthesizeSpeechResult> {
  const deadline = Date.now() + READ_ALOUD_SERVER_BUDGET_MS;
  const settings = getAgentSettings();
  const apiKey = settings.openRouterApiKey?.trim();
  if (!apiKey) throw new ReadAloudNotConfiguredError();
  if (req.signal?.aborted) throw callerAbort();

  const normalized = normalizeSpeechInput(req.text);
  if (!normalized) throw new Error("No text to read aloud");

  const model = resolveReadAloudModel(settings);
  // The default is known to be mp3-capable with a fixed voice; anything else
  // is looked up (capped) so a PCM-only model is refused before it is billed.
  const info = model === DEFAULT_READ_ALOUD_MODEL ? undefined : await lookupReadAloudModel(model, req.signal);
  if (info && !info.mp3) throw new ReadAloudUnsupportedModelError(model);
  const voice = await resolveReadAloudVoice(model, settings, req.signal, info);

  const { text, truncated } = truncateSpeechText(normalized);
  const chunks = chunkSpeechText(text);
  const url = resolveOpenRouterApiUrl("/audio/speech", settings);
  const keys = chunks.map((c) => chunkKey(url, model, voice, c));
  const hits = keys.filter((k) => chunkCache.has(k)).length;
  const cache: ReadAloudCacheStatus = hits === chunks.length ? "hit" : hits === 0 ? "miss" : "partial";

  const audio = await runChunks(
    chunks.map((input, i) => () => chunkAudio(keys[i], { url, apiKey, model, voice, input, deadline })),
    deadline,
    req.signal,
  );
  const joined = joinMp3(audio);
  log.debug(`Read aloud with ${model}${voice ? ` (${voice})` : ""}: ${chunks.length} chunk(s), cache ${cache}${truncated ? ", truncated" : ""}`);
  return {
    audio: joined.audio,
    model,
    voice,
    ...(joined.durationMs !== undefined ? { durationMs: joined.durationMs } : {}),
    truncated,
    chunks: chunks.length,
    cache,
  };
}

/**
 * Run `tasks` at most {@link READ_ALOUD_CONCURRENCY} at a time, answering their
 * results in order. Rejects on the first failure, the caller's abort, or the
 * deadline — whichever is first — and from then on starts nothing new. Tasks
 * already started are left running (see the module comment).
 */
function runChunks(tasks: (() => Promise<Buffer>)[], deadline: number, signal?: AbortSignal): Promise<Buffer[]> {
  return new Promise<Buffer[]>((resolve, reject) => {
    const results: Buffer[] = new Array(tasks.length);
    let next = 0;
    let done = 0;
    let stopped = false;

    const timer = setTimeout(() => stop(deadlineTimeout()), Math.max(0, deadline - Date.now()));
    const onAbort = () => stop(callerAbort());
    signal?.addEventListener("abort", onAbort, { once: true });

    function stop(err?: unknown) {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err === undefined) resolve(results);
      else reject(err);
    }

    function launch() {
      if (stopped || next >= tasks.length) return;
      const i = next++;
      tasks[i]().then(
        (audio) => {
          results[i] = audio;
          if (++done === tasks.length) stop();
          else launch();
        },
        (err: unknown) => stop(err),
      );
    }

    for (let n = 0; n < Math.min(READ_ALOUD_CONCURRENCY, tasks.length); n++) launch();
  });
}

/** One chunk's audio: from the cache, from a call already in flight, or synthesized now. */
function chunkAudio(key: string, job: ChunkJob): Promise<Buffer> {
  const cached = cacheGet(key);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const started = synthesizeChunk(job)
    .then((audio) => {
      cachePut(key, audio);
      return audio;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

async function synthesizeChunk(job: ChunkJob): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptChunk(job);
    } catch (err) {
      if (!shouldRetry(err) || attempt >= MAX_ATTEMPTS) throw err;
      const wait = RETRY_DELAYS_MS[attempt - 1];
      if (Date.now() + wait >= job.deadline) throw deadlineTimeout();
      log.warn(`Speech attempt ${attempt} of ${MAX_ATTEMPTS} failed (${(err as Error)?.message}) — retrying in ${wait}ms`);
      await delay(wait);
    }
  }
}

/** One HTTP attempt, capped by its own timeout and the request's deadline. */
async function attemptChunk(job: ChunkJob): Promise<Buffer> {
  const remaining = job.deadline - Date.now();
  if (remaining <= 0) throw deadlineTimeout();
  const limit = Math.min(READ_ALOUD_ATTEMPT_TIMEOUT_MS, remaining);
  // A timer rather than AbortSignal.timeout, so the limit can be the deadline's.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    return await send(job, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new OpenRouterAbortError(`Speech synthesis timed out after ${limit}ms`, "timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeMp3(buf: Buffer): boolean {
  return buf.length >= 3 && (buf.toString("ascii", 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
}

async function send(job: ChunkJob, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(job.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${job.apiKey}`, "Content-Type": "application/json", "X-Title": "callboard" },
    body: JSON.stringify({ model: job.model, input: job.input, response_format: "mp3", ...(job.voice ? { voice: job.voice } : {}) }),
    signal,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new ReadAloudUpstreamError(upstreamMessage(raw, `OpenRouter HTTP ${res.status} ${res.statusText}`), res.status);
  }

  // From here on, nothing is retried: a 200 means the provider may already
  // have synthesized — and billed — this chunk.
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const body = Buffer.from(
    await res.arrayBuffer().catch(() => {
      throw new ReadAloudUpstreamError("OpenRouter returned an unreadable response", undefined, false);
    }),
  );
  if (type === "application/json") {
    throw new ReadAloudUpstreamError(upstreamMessage(body.toString("utf8"), "OpenRouter returned JSON instead of audio"), undefined, false);
  }
  if (body.length === 0) throw new ReadAloudUpstreamError("OpenRouter returned an empty audio response", undefined, false);
  if (type === "audio/pcm" || type === "audio/l16") {
    throw new ReadAloudUpstreamError(`${job.model} returned PCM audio although mp3 was requested`, undefined, false);
  }
  const mpeg = type === "audio/mpeg" || type === "audio/mp3";
  const untyped = type === "" || type === "application/octet-stream" || type === "binary/octet-stream";
  if (!mpeg && !(untyped && looksLikeMp3(body))) {
    throw new ReadAloudUpstreamError(`OpenRouter returned a non-audio response (${type || "no content type"})`, undefined, false);
  }
  return body;
}

/** OpenRouter's `{ error: { message } }` when the body has one, else the raw text, else `fallback`; capped. */
function upstreamMessage(raw: string, fallback: string): string {
  let message = raw.trim();
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === "string" && parsed.error.message.trim()) message = parsed.error.message.trim();
  } catch {
    // Not JSON — use the text as-is.
  }
  return (message || fallback).slice(0, MAX_ERROR_DETAIL);
}
