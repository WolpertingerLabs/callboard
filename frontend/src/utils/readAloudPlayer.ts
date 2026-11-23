import { MAX_READ_ALOUD_REQUEST_CHARS, READ_ALOUD_SERVER_BUDGET_MS, READ_ALOUD_SPEEDS } from "shared/types/readAloud.js";
import { ReadAloudRequestError, synthesizeSpeech } from "../api";
import { getReadAloudRate, saveReadAloudRate } from "./localStorage";
import { markdownToSpeechText } from "./speechText";

/**
 * Read aloud's single, page-wide playback.
 *
 * One message plays at a time, and only that message: there is no queue and
 * no auto-advance. Starting another bubble stops the current one — its fetch
 * aborted, its audio paused, its blob URL revoked — before the new one begins.
 *
 * A plain module store (`subscribe`/`getSnapshot` for `useSyncExternalStore`)
 * rather than React state, so a bubble does not subscribe: only the playing
 * bubble's player re-renders on `timeupdate` (see hooks/useReadAloud.ts).
 *
 * One `HTMLAudioElement` for the page's lifetime, never attached to the DOM.
 * iOS lets `play()` through only inside a user gesture, and the audio arrives
 * after an `await`; so the click synchronously plays a silent clip on this
 * element — which unlocks it — and the real audio is swapped onto the same
 * element when it lands. Should a browser still refuse, the player sits paused
 * with "Tap play to listen", and that tap is a gesture.
 *
 * Nothing here needs a secure context: fetch, Blob, object URLs and
 * HTMLMediaElement all work over plain http.
 */

export type ReadAloudStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface ReadAloudState {
  /** The bubble (`useId()`) this playback belongs to; null when idle. */
  ownerId: string | null;
  status: ReadAloudStatus;
  /** Seconds. */
  currentTime: number;
  /** Seconds; 0 while unknown. */
  duration: number;
  /** Playback speed, one of `READ_ALOUD_SPEEDS`. Kept across stops. */
  rate: number;
  /** With `status: "error"`. */
  error?: string;
  /** Whether Retry can help (false for a message with nothing to read). */
  retryable?: boolean;
  /** Whether the server read only the start of a very long message. */
  truncated: boolean;
  /** A one-line nudge, e.g. when the browser refused to autoplay. */
  hint?: string;
}

/** Above the server's own deadline, so the server's 504 is what the user normally sees. */
export const READ_ALOUD_CLIENT_TIMEOUT_MS = READ_ALOUD_SERVER_BUDGET_MS + 15_000;
export const READ_ALOUD_EMPTY_MESSAGE = "Nothing to read aloud — this message is only code.";
export const READ_ALOUD_TAP_TO_PLAY = "Tap play to listen.";
const TIMEOUT_MESSAGE = "Read aloud timed out.";
const MEDIA_ERROR_MESSAGE = "Couldn't play the audio.";

type PitchAudio = HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };

let state: ReadAloudState = idleState(getReadAloudRate());
const listeners = new Set<() => void>();
let audio: PitchAudio | null = null;
/** The current blob URL — set only once the real audio is on the element. */
let blobUrl: string | null = null;
/** The server's exact duration for the current audio, seconds. */
let serverDuration = 0;
let abort: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every start/stop, so a late answer for an old request is dropped. */
let generation = 0;
let last: { ownerId: string; markdown: string } | null = null;

function idleState(rate: number): ReadAloudState {
  return { ownerId: null, status: "idle", currentTime: 0, duration: 0, rate, truncated: false };
}

function set(patch: Partial<ReadAloudState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): ReadAloudState {
  return state;
}

function applyRate(el: PitchAudio): void {
  el.preservesPitch = true;
  el.webkitPreservesPitch = true;
  el.mozPreservesPitch = true;
  el.defaultPlaybackRate = state.rate;
  el.playbackRate = state.rate;
}

function knownDuration(el: HTMLMediaElement): number {
  if (serverDuration > 0) return serverDuration;
  return Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
}

function getAudio(): PitchAudio {
  if (audio) return audio;
  const el = new Audio() as PitchAudio;
  el.preload = "auto";
  // Every handler ignores the silent unlock clip: only the real audio, once
  // its blob URL is set, drives the player.
  const onDuration = () => {
    if (blobUrl) set({ duration: knownDuration(el) });
  };
  el.addEventListener("loadedmetadata", onDuration);
  el.addEventListener("durationchange", onDuration);
  el.addEventListener("timeupdate", () => {
    if (blobUrl && state.status !== "error") set({ currentTime: el.currentTime });
  });
  el.addEventListener("playing", () => {
    if (blobUrl) set({ status: "playing", hint: undefined });
  });
  el.addEventListener("pause", () => {
    if (blobUrl && state.status === "playing") set({ status: "paused", currentTime: el.currentTime });
  });
  el.addEventListener("ended", () => {
    if (!blobUrl) return;
    el.pause();
    el.currentTime = 0;
    set({ status: "paused", currentTime: 0 });
  });
  el.addEventListener("error", () => {
    if (!blobUrl) return;
    const owner = state.ownerId;
    teardown();
    set({ ...idleState(state.rate), ownerId: owner, status: "error", error: MEDIA_ERROR_MESSAGE, retryable: true });
  });
  applyRate(el);
  audio = el;
  return el;
}

/** Abort, pause, unload and revoke — everything but the state. */
function teardown(): void {
  generation++;
  abort?.abort();
  abort = null;
  if (timer) clearTimeout(timer);
  timer = null;
  const url = blobUrl;
  blobUrl = null;
  serverDuration = 0;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (url) URL.revokeObjectURL(url);
}

/**
 * Read `markdown` aloud for `ownerId`, stopping whatever was playing. Call it
 * from the click handler itself: the iOS unlock must run inside the gesture.
 */
export function start(ownerId: string, markdown: string): void {
  teardown();
  last = { ownerId, markdown };
  const prepared = markdownToSpeechText(markdown);
  if (!prepared) {
    set({ ...idleState(state.rate), ownerId, status: "error", error: READ_ALOUD_EMPTY_MESSAGE, retryable: false });
    return;
  }

  const el = getAudio();
  el.src = silentWav();
  void el.play().catch(() => {});

  const gen = generation;
  const ctrl = new AbortController();
  abort = ctrl;
  // A timer rather than `AbortSignal.timeout`/`.any`, which older Safari lacks.
  timer = setTimeout(() => ctrl.abort(new DOMException(TIMEOUT_MESSAGE, "TimeoutError")), READ_ALOUD_CLIENT_TIMEOUT_MS);
  set({ ...idleState(state.rate), ownerId, status: "loading" });

  // The server refuses (413) a body over MAX_READ_ALOUD_REQUEST_CHARS and reads
  // far less than that anyway, so send its first part: a very long message
  // then plays its start, with the truncation note, instead of failing.
  const text = clampRequestText(prepared);
  const clamped = text.length < prepared.length;

  synthesizeSpeech(text, ctrl.signal).then(
    (speech) => {
      if (gen !== generation) return;
      finishRequest();
      blobUrl = URL.createObjectURL(speech.blob);
      serverDuration = speech.durationMs ? speech.durationMs / 1000 : 0;
      el.src = blobUrl;
      // Setting src runs the load algorithm, which resets playbackRate.
      applyRate(el);
      set({ truncated: speech.truncated || clamped, duration: knownDuration(el) });
      play(gen);
    },
    (err: unknown) => {
      if (gen !== generation) return;
      const timedOut = ctrl.signal.aborted && (ctrl.signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
      finishRequest();
      teardown();
      set({
        status: "error",
        error: timedOut ? TIMEOUT_MESSAGE : err instanceof Error && err.message ? err.message : "Read aloud failed.",
        // A 400 (no text, unsupported model) or 413 is refused again on retry.
        retryable: !(err instanceof ReadAloudRequestError && (err.status === 400 || err.status === 413)),
      });
    },
  );
}

/** `text` cut to the server's request limit, never between a surrogate pair. */
function clampRequestText(text: string): string {
  if (text.length <= MAX_READ_ALOUD_REQUEST_CHARS) return text;
  let end = MAX_READ_ALOUD_REQUEST_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

function finishRequest(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  abort = null;
}

function play(gen: number): void {
  const el = getAudio();
  el.play().then(
    () => {
      if (gen === generation && blobUrl) set({ status: "playing", hint: undefined });
    },
    (err: unknown) => {
      if (gen !== generation || !blobUrl) return;
      if ((err as { name?: string } | undefined)?.name === "NotAllowedError") set({ status: "paused", hint: READ_ALOUD_TAP_TO_PLAY });
      else if ((err as { name?: string } | undefined)?.name !== "AbortError") set({ status: "paused" });
    },
  );
}

/** Play/pause. */
export function toggle(): void {
  if (!audio || !blobUrl) return;
  if (state.status === "playing") {
    audio.pause();
    set({ status: "paused", currentTime: audio.currentTime });
  } else if (state.status === "paused") {
    play(generation);
  }
}

/** Stop and forget the current playback. The speed is kept. */
export function stop(): void {
  teardown();
  set(idleState(state.rate));
}

/** Stop, if `ownerId` is what's playing — for a bubble that is going away. */
export function release(ownerId: string): void {
  if (state.ownerId === ownerId) stop();
}

/** Start the last request again (the error's Retry). */
export function retry(): void {
  if (last) start(last.ownerId, last.markdown);
}

export function seekTo(seconds: number): void {
  if (!audio || !blobUrl) return;
  const end = knownDuration(audio) || Infinity;
  const t = Math.min(Math.max(0, seconds), end);
  audio.currentTime = t;
  set({ currentTime: t });
}

/** Skip by `delta` seconds; past the end lands on the end, which ends playback. */
export function seekBy(delta: number): void {
  if (!audio || !blobUrl) return;
  seekTo(audio.currentTime + delta);
}

/** 0.75 → 1 → 1.25 → 1.5 → 1.75 → 2 → 0.75…, remembered for next time. */
export function cycleRate(): void {
  const index = (READ_ALOUD_SPEEDS as readonly number[]).indexOf(state.rate);
  const rate = READ_ALOUD_SPEEDS[(index + 1) % READ_ALOUD_SPEEDS.length];
  set({ rate });
  if (audio) applyRate(audio);
  saveReadAloudRate(rate);
}

let silentWavUri: string | null = null;

/** A 2-sample, 8 kHz, 8-bit mono WAV of silence: a near-empty clip that unlocks the element. */
function silentWav(): string {
  if (silentWavUri) return silentWavUri;
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 38, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, 2, true);
  bytes[44] = 128; // 8-bit silence
  bytes[45] = 128;
  silentWavUri = `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
  return silentWavUri;
}

export function getReadAloudAudioForTesting(): HTMLAudioElement | null {
  return audio;
}

/** Stops everything, drops the element, and re-reads the stored speed. */
export function resetReadAloudPlayerForTesting(): void {
  teardown();
  audio = null;
  last = null;
  state = idleState(getReadAloudRate());
}
