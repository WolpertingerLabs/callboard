/**
 * Just enough MPEG audio to join read-aloud chunks into one playable stream.
 *
 * Each synthesized chunk is a complete mp3 file: possibly an ID3v2 tag in
 * front, possibly an ID3v1 tag behind, and often a Xing/Info (or VBRI) header
 * in its first frame. Byte-concatenating those mostly plays, but a browser
 * reads the *first* chunk's Xing frame count as the whole file's duration, so
 * the total time and seeking come out wrong. So, per chunk: strip the tags,
 * walk the audio frames, drop the header frame, and sum each frame's
 * `samples / sampleRate` for an exact duration.
 *
 * Assumes every chunk shares one encoding — true for one model and voice. A
 * VBR stream with no Xing header has its duration *estimated* by some
 * browsers; the exact duration this computes is sent alongside for that.
 */

/** kbps by bitrate index; 0 (free format) and 15 (bad) are refused. */
const BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** Hz by sample-rate index, per MPEG version bits (0 = 2.5, 2 = 2, 3 = 1). */
const SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

export interface Mp3Frame {
  /** Bytes, header included. */
  length: number;
  /** PCM samples per channel this frame decodes to. */
  samples: number;
  sampleRate: number;
}

/** The MPEG audio frame whose header starts at `offset`, or `null` if none does. */
export function parseMp3Frame(buf: Buffer, offset: number): Mp3Frame | null {
  if (offset + 4 > buf.length) return null;
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  if (buf[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0b11; // 0 = 2.5, 1 = reserved, 2 = 2, 3 = 1
  const layer = (b1 >> 1) & 0b11; // 1 = III, 2 = II, 3 = I, 0 = reserved
  if (version === 1 || layer === 0) return null;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0b11;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const padding = (b2 >> 1) & 1;
  const v1 = version === 3;
  const table = layer === 3 ? (v1 ? BITRATES.v1l1 : BITRATES.v2l1) : layer === 2 ? (v1 ? BITRATES.v1l2 : BITRATES.v2l23) : v1 ? BITRATES.v1l3 : BITRATES.v2l23;
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];

  if (layer === 3) return { length: (Math.floor((12 * bitrate) / sampleRate) + padding) * 4, samples: 384, sampleRate };
  if (layer === 2) return { length: Math.floor((144 * bitrate) / sampleRate) + padding, samples: 1152, sampleRate };
  // Layer III: MPEG-2/2.5 frames carry half the samples.
  const samples = v1 ? 1152 : 576;
  return { length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding, samples, sampleRate };
}

/** Whether the frame at `offset` is a Xing/Info or VBRI header rather than audio. */
function isVbrHeaderFrame(buf: Buffer, offset: number, length: number): boolean {
  const b1 = buf[offset + 1];
  const v1 = ((b1 >> 3) & 0b11) === 3;
  const crc = (b1 & 1) === 0 ? 2 : 0;
  const mono = ((buf[offset + 3] >> 6) & 0b11) === 3;
  // Layer III side-info size, which the Xing tag follows.
  const sideInfo = v1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const at = (pos: number) => (pos + 4 <= offset + length ? buf.toString("ascii", pos, pos + 4) : "");
  const xing = at(offset + 4 + crc + sideInfo);
  return xing === "Xing" || xing === "Info" || at(offset + 36) === "VBRI";
}

/** Size of the ID3v2 tag at `offset`, footer included, or 0 if there is none. */
function id3v2Size(buf: Buffer, offset: number): number {
  if (offset + 10 > buf.length || buf.toString("ascii", offset, offset + 3) !== "ID3") return 0;
  const size = ((buf[offset + 6] & 0x7f) << 21) | ((buf[offset + 7] & 0x7f) << 14) | ((buf[offset + 8] & 0x7f) << 7) | (buf[offset + 9] & 0x7f);
  const footer = (buf[offset + 5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * One chunk's bare audio frames — ID3 tags and the VBR header frame removed —
 * and their exact duration. `null` when the bytes are not a clean run of MPEG
 * audio frames (no frames at all, or junk between them); the caller then falls
 * back to the bytes as they came.
 */
export function stripMp3Container(buf: Buffer): { frames: Buffer; durationMs: number } | null {
  const result = strip(buf);
  return result && { frames: result.frames, durationMs: Math.round(result.seconds * 1000) };
}

function strip(buf: Buffer): { frames: Buffer; seconds: number } | null {
  let start = 0;
  for (let size = id3v2Size(buf, start); size > 0; size = id3v2Size(buf, start)) start += size;
  let end = buf.length;
  if (end - start >= 128 && buf.toString("ascii", end - 128, end - 125) === "TAG") end -= 128;

  const parts: Buffer[] = [];
  let seconds = 0;
  let offset = start;
  let first = true;
  while (offset < end) {
    const frame = parseMp3Frame(buf, offset);
    if (!frame) {
      // A header cut off by the end of the buffer is a truncated last frame,
      // which a decoder discards anyway; anything else is not a frame stream.
      if (end - offset < 4 && parts.length > 0) break;
      return null;
    }
    if (offset + frame.length > end) break; // Truncated final frame.
    const skip = first && isVbrHeaderFrame(buf, offset, frame.length);
    first = false;
    if (!skip) {
      parts.push(buf.subarray(offset, offset + frame.length));
      seconds += frame.samples / frame.sampleRate;
    }
    offset += frame.length;
  }
  if (parts.length === 0) return null;
  return { frames: Buffer.concat(parts), seconds };
}

/**
 * Join synthesized chunks, in order, into one mp3 stream. `durationMs` only
 * when every chunk parsed; otherwise the chunks are concatenated as they came
 * (still playable — decoders resync on frame headers) and the client relies on
 * the media element's own duration.
 */
export function joinMp3(chunks: Buffer[]): { audio: Buffer; durationMs?: number } {
  const stripped = chunks.map(strip);
  if (stripped.some((s) => s === null)) return { audio: Buffer.concat(chunks) };
  const ok = stripped as { frames: Buffer; seconds: number }[];
  // Summed before rounding, so many chunks do not accumulate rounding error.
  return { audio: Buffer.concat(ok.map((s) => s.frames)), durationMs: Math.round(ok.reduce((sum, s) => sum + s.seconds, 0) * 1000) };
}
