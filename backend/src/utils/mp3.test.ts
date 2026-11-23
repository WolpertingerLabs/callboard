/**
 * Frame-level mp3 handling for read aloud: container tags stripped, each
 * chunk's Xing/Info/VBRI header frame dropped, exact duration from the frames,
 * and chunks joined into one stream. Every byte here is synthetic MPEG-1
 * Layer III, built in the test.
 */
import { describe, expect, it } from "vitest";
import { joinMp3, parseMp3Frame, stripMp3Container } from "./mp3.js";

/**
 * One MPEG-1 Layer III frame at 128 kbps / 48 kHz: exactly 384 bytes
 * (144 × 128000 / 48000), 1152 samples, 24 ms. `fill` marks the payload so
 * a test can tell frames apart after a join.
 */
function frame(opts: { fill?: number; mono?: boolean; tag?: "Xing" | "Info" | "VBRI"; sampleRateIndex?: number } = {}): Buffer {
  const { fill = 0x11, mono = false, tag, sampleRateIndex = 1 } = opts;
  // 48000 → 384 bytes; 32000 (index 2) → 576 bytes.
  const length = sampleRateIndex === 2 ? 576 : 384;
  const buf = Buffer.alloc(length, fill);
  buf[0] = 0xff;
  buf[1] = 0xfb; // MPEG-1, Layer III, no CRC
  buf[2] = (0b1001 << 4) | (sampleRateIndex << 2); // 128 kbps, no padding
  buf[3] = mono ? 0xc0 : 0x00;
  if (tag === "VBRI") buf.write("VBRI", 36, "ascii");
  else if (tag) buf.write(tag, mono ? 4 + 17 : 4 + 32, "ascii");
  return buf;
}

/** An ID3v2.4 tag with `bodyBytes` of payload and, optionally, a footer. */
function id3v2(bodyBytes: number, footer = false): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, 0, 0, 0, 0]);
  // Syncsafe: 7 bits per byte.
  header[6] = (bodyBytes >> 21) & 0x7f;
  header[7] = (bodyBytes >> 14) & 0x7f;
  header[8] = (bodyBytes >> 7) & 0x7f;
  header[9] = bodyBytes & 0x7f;
  const parts = [header, Buffer.alloc(bodyBytes, 0x55)];
  if (footer) parts.push(Buffer.from([0x33, 0x44, 0x49, 4, 0, 0x10, header[6], header[7], header[8], header[9]]));
  return Buffer.concat(parts);
}

function id3v1(): Buffer {
  const buf = Buffer.alloc(128, 0x20);
  buf.write("TAG", 0, "ascii");
  return buf;
}

describe("parseMp3Frame", () => {
  it("reads length, samples and sample rate from an MPEG-1 Layer III header", () => {
    expect(parseMp3Frame(frame(), 0)).toEqual({ length: 384, samples: 1152, sampleRate: 48000 });
  });

  it("refuses a non-sync byte, a free-format or bad bitrate, and a reserved sample rate", () => {
    expect(parseMp3Frame(Buffer.from([0x00, 0xfb, 0x90, 0x00]), 0)).toBeNull();
    expect(parseMp3Frame(Buffer.from([0xff, 0xfb, 0x04, 0x00]), 0)).toBeNull();
    expect(parseMp3Frame(Buffer.from([0xff, 0xfb, 0xf4, 0x00]), 0)).toBeNull();
    expect(parseMp3Frame(Buffer.from([0xff, 0xfb, 0x9c, 0x00]), 0)).toBeNull();
    expect(parseMp3Frame(Buffer.from([0xff, 0xfb]), 0)).toBeNull();
  });
});

describe("stripMp3Container", () => {
  it("answers the frames and their exact duration", () => {
    const audio = Buffer.concat([frame(), frame(), frame()]);
    const result = stripMp3Container(audio);
    expect(result?.durationMs).toBe(72); // 3 × 1152 / 48000
    expect(result?.frames.equals(audio)).toBe(true);
  });

  it("strips a leading ID3v2 tag, with and without a footer, and a trailing ID3v1 tag", () => {
    const audio = Buffer.concat([frame(), frame()]);
    for (const tagged of [Buffer.concat([id3v2(300), audio, id3v1()]), Buffer.concat([id3v2(300, true), audio])]) {
      const result = stripMp3Container(tagged);
      expect(result?.frames.equals(audio)).toBe(true);
      expect(result?.durationMs).toBe(48);
    }
  });

  it.each(["Xing", "Info", "VBRI"] as const)("drops a %s header frame and does not count it", (tag) => {
    const audio = Buffer.concat([frame(), frame()]);
    const result = stripMp3Container(Buffer.concat([frame({ tag, fill: 0 }), audio]));
    expect(result?.frames.equals(audio)).toBe(true);
    expect(result?.durationMs).toBe(48);
  });

  it("finds a mono Xing header at the mono side-info offset", () => {
    const audio = Buffer.concat([frame({ mono: true }), frame({ mono: true })]);
    const result = stripMp3Container(Buffer.concat([frame({ mono: true, tag: "Xing", fill: 0 }), audio]));
    expect(result?.frames.equals(audio)).toBe(true);
  });

  it("drops a truncated final frame", () => {
    const audio = Buffer.concat([frame(), frame()]);
    const result = stripMp3Container(Buffer.concat([audio, frame().subarray(0, 100)]));
    expect(result?.frames.equals(audio)).toBe(true);
    expect(result?.durationMs).toBe(48);
  });

  it("answers null for garbage, an empty buffer, or junk between frames", () => {
    expect(stripMp3Container(Buffer.from("definitely not audio, just some text bytes"))).toBeNull();
    expect(stripMp3Container(Buffer.alloc(0))).toBeNull();
    expect(stripMp3Container(Buffer.concat([frame(), Buffer.alloc(50, 0x01), frame()]))).toBeNull();
    expect(stripMp3Container(id3v2(20))).toBeNull();
  });
});

describe("joinMp3", () => {
  it("joins chunks into one stream with no tags and one duration", () => {
    const a = Buffer.concat([frame({ fill: 0xa1 }), frame({ fill: 0xa2 })]);
    const b = Buffer.concat([frame({ fill: 0xb1 })]);
    const result = joinMp3([
      Buffer.concat([id3v2(64), frame({ tag: "Xing", fill: 0 }), a, id3v1()]),
      Buffer.concat([id3v2(64, true), frame({ tag: "Info", fill: 0 }), b]),
    ]);
    expect(result.audio.equals(Buffer.concat([a, b]))).toBe(true);
    expect(result.durationMs).toBe(72);
  });

  it("sums durations across sample rates", () => {
    // 1152 / 48000 = 24 ms; 1152 / 32000 = 36 ms.
    expect(joinMp3([frame(), frame({ sampleRateIndex: 2 })]).durationMs).toBe(60);
  });

  it("falls back to raw concatenation, with no duration, when any chunk will not parse", () => {
    const good = frame();
    const bad = Buffer.from("not an mp3 at all");
    const result = joinMp3([good, bad]);
    expect(result.audio.equals(Buffer.concat([good, bad]))).toBe(true);
    expect(result.durationMs).toBeUndefined();
  });
});
