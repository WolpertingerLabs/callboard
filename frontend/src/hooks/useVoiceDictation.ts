import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_VOICE_RECORDING_MS, VOICE_SERVER_BUDGET_MS } from "shared/types/voice.js";
import { transcribeAudio } from "../api";
import { canConvertAudio, isSilentRecording, MIN_RECORDING_MS, pickRecorderMimeType, toWav16kMono } from "../utils/audioWav";

/** Shown wherever the browser itself rules the mic out — almost always plain HTTP on a LAN/tailnet address. */
export const VOICE_INSECURE_MESSAGE = "Voice input needs HTTPS or localhost. Open Callboard over https (e.g. `tailscale serve`) or on this machine.";

export const VOICE_NO_SPEECH_MESSAGE = "No speech detected";

/**
 * The client-side ceiling on one upload: the server's worst case
 * ({@link VOICE_SERVER_BUDGET_MS}) plus room for the upload itself — up to
 * ~10 MB on a slow link — so the server's own 504 normally arrives first and
 * the user sees its message rather than a bare client timeout.
 */
export const TRANSCRIBE_TIMEOUT_MS = VOICE_SERVER_BUDGET_MS + 15_000;
/** How often the elapsed-time readout updates while recording. */
const TICK_MS = 250;
const ERROR_CLEAR_MS = 6000;
const INFO_CLEAR_MS = 3000;

export type VoiceDictationState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "recording"; elapsedMs: number }
  | { status: "transcribing" }
  /** `tone: "info"` is "No speech detected" — not a failure, just nothing to insert. */
  | { status: "error"; message: string; tone: "error" | "info" };

export interface UseVoiceDictationOptions {
  /**
   * Whether dictation may run right now — the server can transcribe (a key is
   * configured) and the composer is not disabled. Going false mid-recording
   * cancels it.
   */
  available: boolean;
  /** Why it is unavailable, when the caller knows (the missing key). */
  reason?: string;
  /**
   * Which composer this dictation is for — the draft key. A change cancels
   * whatever is in flight, so a transcript can never land in another chat.
   */
  resetKey?: string;
  /** Receives a non-empty, trimmed transcript. Never called after a cancel. */
  onTranscript: (text: string) => void;
}

export interface VoiceDictation {
  state: VoiceDictationState;
  /** Why the mic cannot be used, for its tooltip; null when it can (or when the composer is simply disabled). */
  unavailableReason: string | null;
  /** Whether a press would start recording. */
  canStart: boolean;
  /** Requesting, recording or transcribing — what Escape cancels. */
  active: boolean;
  /** Start when idle, stop-and-transcribe when recording; ignored otherwise. */
  toggle: () => void;
  /** Throw away whatever is in flight. Never delivers a transcript. */
  cancel: () => void;
}

/** Whether this browser can capture and convert audio at all. False on plain-HTTP origins, where `mediaDevices` is absent. */
export function browserSupportsDictation(): boolean {
  if (typeof window === "undefined" || !window.isSecureContext) return false;
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") return false;
  if (typeof (globalThis as { MediaRecorder?: unknown }).MediaRecorder === "undefined") return false;
  return canConvertAudio();
}

function microphoneErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was denied — allow it in your browser's site settings.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone found.";
    case "NotReadableError":
      return "The microphone is in use by another app.";
    default:
      return "Couldn't start recording.";
  }
}

/**
 * Composer dictation: record from the mic, convert to WAV, transcribe, and hand
 * the text to `onTranscript`. What happens to the text is the caller's — this
 * hook never sends anything.
 *
 * Every async step is tagged with a generation number. `cancel` (Escape, a
 * `resetKey` change, unmount, becoming unavailable) bumps it, stops the mic
 * tracks and aborts the upload, and any continuation from an older generation
 * drops its result on the floor. That is what keeps a slow transcript for
 * chat A from arriving after the user has moved to chat B.
 */
export function useVoiceDictation({ available, reason, resetKey, onTranscript }: UseVoiceDictationOptions): VoiceDictation {
  const [supported] = useState(browserSupportsDictation);
  const [state, setState] = useState<VoiceDictationState>({ status: "idle" });
  const stateRef = useRef(state);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    stateRef.current = state;
    onTranscriptRef.current = onTranscript;
  });

  const genRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<{ tick?: ReturnType<typeof setInterval>; stop?: ReturnType<typeof setTimeout>; clear?: ReturnType<typeof setTimeout> }>({});

  const update = useCallback((next: VoiceDictationState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const clearRecordingTimers = useCallback(() => {
    clearInterval(timersRef.current.tick);
    clearTimeout(timersRef.current.stop);
    timersRef.current.tick = undefined;
    timersRef.current.stop = undefined;
  }, []);

  const showMessage = useCallback(
    (gen: number, message: string, tone: "error" | "info") => {
      update({ status: "error", message, tone });
      clearTimeout(timersRef.current.clear);
      timersRef.current.clear = setTimeout(
        () => {
          if (genRef.current === gen && stateRef.current.status === "error") update({ status: "idle" });
        },
        tone === "info" ? INFO_CLEAR_MS : ERROR_CLEAR_MS,
      );
    },
    [update],
  );

  const cancel = useCallback(() => {
    genRef.current++;
    clearRecordingTimers();
    clearTimeout(timersRef.current.clear);
    abortRef.current?.abort();
    abortRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Already stopping; the tracks below are what matter.
        }
      }
    }
    stopTracks();
    if (stateRef.current.status !== "idle") update({ status: "idle" });
  }, [clearRecordingTimers, stopTracks, update]);

  const finish = useCallback(
    async (gen: number, chunks: Blob[], mimeType: string, startedAt: number) => {
      stopTracks();
      recorderRef.current = null;
      if (genRef.current !== gen) return;
      // A tap, not speech: some browsers produce no data at all for one, and
      // the few hundred bytes others produce often fail to decode — which is
      // not "Couldn't process the recording", it is nothing said.
      if (chunks.length === 0 || Date.now() - startedAt < MIN_RECORDING_MS) {
        showMessage(gen, VOICE_NO_SPEECH_MESSAGE, "info");
        return;
      }
      update({ status: "transcribing" });
      let converted;
      try {
        converted = await toWav16kMono(new Blob(chunks, mimeType ? { type: mimeType } : undefined));
      } catch {
        if (genRef.current === gen) showMessage(gen, "Couldn't process the recording.", "error");
        return;
      }
      if (genRef.current !== gen) return;
      if (isSilentRecording(converted)) {
        showMessage(gen, VOICE_NO_SPEECH_MESSAGE, "info");
        return;
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // A timer rather than `AbortSignal.any`/`.timeout`, which older Safari lacks.
      const timeout = setTimeout(() => ctrl.abort(new DOMException("Transcription timed out", "TimeoutError")), TRANSCRIBE_TIMEOUT_MS);
      let text: string;
      try {
        const res = await transcribeAudio(converted.wav, ctrl.signal);
        text = typeof res?.text === "string" ? res.text.trim() : "";
      } catch (err) {
        if (genRef.current !== gen) return;
        const timedOut = ctrl.signal.aborted && (ctrl.signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
        showMessage(gen, timedOut ? "Transcription timed out." : err instanceof Error && err.message ? err.message : "Transcription failed.", "error");
        return;
      } finally {
        clearTimeout(timeout);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
      if (genRef.current !== gen) return;
      if (!text) {
        showMessage(gen, VOICE_NO_SPEECH_MESSAGE, "info");
        return;
      }
      update({ status: "idle" });
      onTranscriptRef.current(text);
    },
    [stopTracks, update, showMessage],
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || stateRef.current.status !== "recording") return;
    clearRecordingTimers();
    update({ status: "transcribing" });
    try {
      recorder.stop();
    } catch {
      cancel();
    }
  }, [clearRecordingTimers, update, cancel]);

  const canStart = supported && available;

  const start = useCallback(async () => {
    const gen = ++genRef.current;
    clearTimeout(timersRef.current.clear);
    update({ status: "requesting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      if (genRef.current === gen) showMessage(gen, microphoneErrorMessage(err), "error");
      return;
    }
    if (genRef.current !== gen) {
      // Cancelled while the permission prompt was up: release the mic at once.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    const mimeType = pickRecorderMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      stopTracks();
      showMessage(gen, "Couldn't start recording.", "error");
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    let startedAt = Date.now();
    recorder.onstop = () => void finish(gen, chunks, recorder.mimeType || mimeType, startedAt);
    recorderRef.current = recorder;
    try {
      // No timeslice: the whole recording arrives as one blob on stop. With
      // one, Safari writes fragmented MP4, which decodeAudioData has rejected.
      recorder.start();
    } catch {
      cancel();
      showMessage(genRef.current, "Couldn't start recording.", "error");
      return;
    }
    startedAt = Date.now();
    update({ status: "recording", elapsedMs: 0 });
    timersRef.current.tick = setInterval(() => {
      if (genRef.current === gen && stateRef.current.status === "recording") update({ status: "recording", elapsedMs: Date.now() - startedAt });
    }, TICK_MS);
    timersRef.current.stop = setTimeout(stop, MAX_VOICE_RECORDING_MS);
  }, [update, showMessage, stopTracks, finish, cancel, stop]);

  const toggle = useCallback(() => {
    const status = stateRef.current.status;
    if (status === "recording") stop();
    else if ((status === "idle" || status === "error") && canStart) void start();
  }, [stop, start, canStart]);

  // A new composer key — or the composer going unavailable — ends whatever is in flight.
  const settledKeyRef = useRef(resetKey);
  useEffect(() => {
    if (settledKeyRef.current === resetKey) return;
    settledKeyRef.current = resetKey;
    cancel();
  }, [resetKey, cancel]);
  useEffect(() => {
    if (!canStart) cancel();
  }, [canStart, cancel]);
  useEffect(() => cancel, [cancel]);

  const status = state.status;
  return {
    state,
    unavailableReason: !supported ? VOICE_INSECURE_MESSAGE : !available ? (reason ?? null) : null,
    canStart,
    active: status === "requesting" || status === "recording" || status === "transcribing",
    toggle,
    cancel,
  };
}
