/**
 * /api/voice — composer voice input.
 *
 * `POST /transcribe` takes one 16-bit PCM WAV recording (the browser converts
 * whatever it recorded before uploading, so this only ever sees one validated
 * format) and answers its transcript. `GET /models` lists the models the
 * Settings → API picker offers. Both sit behind the global `requireAuth`.
 *
 * The transcript is returned, never acted on: nothing here sends, enqueues or
 * otherwise turns dictated words into a message.
 */
import { Router } from "express";
import multer from "multer";
import { DEFAULT_VOICE_MODEL, MAX_VOICE_UPLOAD_BYTES, VOICE_ERROR_CODES, type TranscribeResponse, type VoiceModelsResponse } from "shared";
import { MULTIPART_FIELD_LIMITS, withUploadErrors } from "../utils/multipart-limits.js";
import { getVoiceModelsAsync } from "../services/openrouter-voice-models.js";
import { VoiceNotConfiguredError, VoiceUpstreamError, transcribeAudio } from "../services/voice-transcription.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("voice");

export const voiceRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VOICE_UPLOAD_BYTES, files: 1, ...MULTIPART_FIELD_LIMITS },
});

const parseAudio = withUploadErrors(upload.single("audio"), {
  tooLarge: `Recording too large; the limit is ${MAX_VOICE_UPLOAD_BYTES / 1024 / 1024}MB (about 5 minutes)`,
  tooMany: { field: "audio", message: "Only one recording per request" },
});

/**
 * Whether `buf` is a RIFF/WAVE file whose `fmt ` chunk declares 16-bit integer
 * PCM. Walks the chunk list rather than assuming `fmt ` sits at byte 12, since
 * a writer may put a `LIST` chunk first.
 */
export function isPcm16Wav(buf: Buffer): boolean {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return false;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      if (size < 16 || offset + 8 + 16 > buf.length) return false;
      const audioFormat = buf.readUInt16LE(offset + 8);
      const bitsPerSample = buf.readUInt16LE(offset + 22);
      // 1 = integer PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE, whose subformat a
      // 16-bit mono writer only ever sets to PCM.
      return (audioFormat === 1 || audioFormat === 0xfffe) && bitsPerSample === 16;
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset += 8 + size + (size % 2);
  }
  return false;
}

voiceRouter.get("/models", async (_req, res) => {
  // #swagger.tags = ['Voice']
  // #swagger.summary = 'List voice input models'
  // #swagger.description = 'Models usable for composer voice input: OpenRouter dedicated speech-to-text models (kind "transcription") first, then audio-input chat models (kind "chat"), each sorted by id. OpenRouter routers are excluded. Works without an OpenRouter key; the catalog is public.'
  /* #swagger.responses[200] = { description: "{ models: { id, name, kind }[], defaultModel }" } */
  const body: VoiceModelsResponse = { models: await getVoiceModelsAsync(), defaultModel: DEFAULT_VOICE_MODEL };
  res.json(body);
});

voiceRouter.post("/transcribe", parseAudio, async (req, res) => {
  // #swagger.tags = ['Voice']
  // #swagger.summary = 'Transcribe a recording'
  // #swagger.description = 'Transcribes one 16-bit PCM WAV recording (max 12MB, about 5 minutes) with the OpenRouter voice model configured in Settings → API, billed to the account-wide OpenRouter key. Returns the transcript only; it is never sent as a message. Uses multipart/form-data with file field "audio" and an optional ISO-639-1 "language" field (speech-to-text models only).'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            audio: { type: "string", format: "binary" },
            language: { type: "string", example: "en" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "{ text, model, durationMs, costUsd? } — text is empty when no speech was detected" } */
  /* #swagger.responses[400] = { description: "NO_AUDIO, UNSUPPORTED_AUDIO, INVALID_LANGUAGE, or a refused multipart body" } */
  /* #swagger.responses[409] = { description: "OPENROUTER_NOT_CONFIGURED — no OpenRouter API key" } */
  /* #swagger.responses[413] = { description: "LIMIT_FILE_SIZE — recording over 12MB" } */
  /* #swagger.responses[502] = { description: "TRANSCRIPTION_FAILED — OpenRouter refused or failed the request" } */
  /* #swagger.responses[504] = { description: "TRANSCRIPTION_TIMEOUT" } */
  const file = req.file;
  if (!file || file.size === 0) {
    res.status(400).json({ error: "No audio provided", code: VOICE_ERROR_CODES.noAudio });
    return;
  }
  if (!isPcm16Wav(file.buffer)) {
    res.status(400).json({ error: "Audio must be 16-bit PCM WAV", code: VOICE_ERROR_CODES.unsupportedAudio });
    return;
  }
  const rawLanguage: unknown = (req.body as Record<string, unknown> | undefined)?.language;
  let language: string | undefined;
  if (rawLanguage !== undefined && rawLanguage !== "") {
    if (typeof rawLanguage !== "string" || !/^[a-z]{2}$/.test(rawLanguage)) {
      res.status(400).json({ error: "language must be a two-letter ISO-639-1 code", code: VOICE_ERROR_CODES.invalidLanguage });
      return;
    }
    language = rawLanguage;
  }

  // `res` rather than `req`: a request's "close" fires as soon as its body has
  // been read, which multer has already done. The response closing before it
  // finished is what "the client went away" looks like.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const result: TranscribeResponse = await transcribeAudio({ wav: file.buffer, language, signal: controller.signal });
    res.json(result);
  } catch (err) {
    if (controller.signal.aborted) return; // Nobody left to answer.
    if (err instanceof VoiceNotConfiguredError) {
      res.status(409).json({ error: err.message, code: VOICE_ERROR_CODES.notConfigured });
      return;
    }
    if ((err as { name?: string })?.name === "TimeoutError") {
      res.status(504).json({ error: "Transcription timed out", code: VOICE_ERROR_CODES.timeout });
      return;
    }
    const message = err instanceof VoiceUpstreamError ? err.message : err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    log.warn(`Transcription failed: ${message}`);
    res.status(502).json({ error: `Transcription failed: ${message}`, code: VOICE_ERROR_CODES.failed });
  }
});
