import { describe, expect, it } from "vitest";
import { formatByteRange, parseRangeHeader, upstreamRangeFor, validateUpstreamContentRange } from "./http-range.js";

describe("parseRangeHeader", () => {
  it.each([
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=100-", { start: 100 }],
    ["bytes=-100", { suffix: 100 }],
    [" bytes= 5-5 ", { start: 5, end: 5 }],
  ])("%j → single %o", (header, range) => {
    expect(parseRangeHeader(header)).toEqual({ kind: "single", range });
  });

  it.each(["items=0-1", "bytes=x", "bytes=", "bytes=-", "bytes=5-2", "bytes=1-2-3", "Bytes=0-1", "bytes=0-1,x", `bytes=0-${"9".repeat(20)}`, "bytes=0x10-"])(
    "%j → invalid",
    (header) => {
      expect(parseRangeHeader(header)).toEqual({ kind: "invalid" });
    },
  );

  it("several valid specs → multi", () => {
    expect(parseRangeHeader("bytes=0-1, 5-6")).toEqual({ kind: "multi" });
  });
});

describe("upstreamRangeFor + formatByteRange", () => {
  const upstream = (range: Parameters<typeof upstreamRangeFor>[0], max: number) => {
    const r = upstreamRangeFor(range, max);
    return r && formatByteRange(r);
  };

  it("clamps a from-start range to the cap", () => {
    expect(upstream({ start: 0, end: 99 }, 1000)).toBe("bytes=0-99");
    expect(upstream({ start: 0, end: 5000 }, 1000)).toBe("bytes=0-999");
    expect(upstream({ start: 10 }, 1000)).toBe("bytes=10-1009");
  });

  it("forwards a suffix range only when it fits the cap", () => {
    expect(upstream({ suffix: 1000 }, 1000)).toBe("bytes=-1000");
    expect(upstream({ suffix: 1001 }, 1000)).toBeUndefined();
  });
});

describe("validateUpstreamContentRange", () => {
  const req = { start: 10, end: 19 };
  it.each([
    ["bytes 10-19/2000", "10", req],
    ["bytes 10-19/*", undefined, req],
    ["bytes 12-15/2000", "4", req],
    ["bytes 1950-1999/2000", "50", { suffix: 50 }],
    ["bytes 0-9/10", "10", { suffix: 50 }],
  ] as const)("%s (Content-Length %s) is accepted", (header, length, requested) => {
    expect(validateUpstreamContentRange(header, length, requested)).toBe(header);
  });

  it.each([
    ["bytes 0-9", "10", req], // malformed
    ["bytes 19-10/2000", undefined, req], // first > last
    ["bytes 10-19/15", undefined, req], // last >= total
    ["bytes 10-19/2000", "11", req], // length mismatch
    ["bytes 10-19/2000", "ten", req],
    ["bytes 5-19/2000", "15", req], // before the requested start
    ["bytes 10-29/2000", "20", req], // past the requested end
    ["bytes 1900-1999/2000", "100", { suffix: 50 }], // longer than the suffix
    [`bytes 10-19/${"9".repeat(20)}`, undefined, req], // unsafe integer
  ] as const)("%s (Content-Length %s) is rejected", (header, length, requested) => {
    expect(validateUpstreamContentRange(header, length, requested)).toBeUndefined();
  });
});
