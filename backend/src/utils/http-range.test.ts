import { describe, expect, it } from "vitest";
import { parseRangeHeader, serializeUpstreamRange } from "./http-range.js";

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

describe("serializeUpstreamRange", () => {
  it("builds the header from integers, clamping a from-start range to the cap", () => {
    expect(serializeUpstreamRange({ start: 0, end: 99 }, 1000)).toBe("bytes=0-99");
    expect(serializeUpstreamRange({ start: 0, end: 5000 }, 1000)).toBe("bytes=0-999");
    expect(serializeUpstreamRange({ start: 10 }, 1000)).toBe("bytes=10-1009");
    expect(serializeUpstreamRange({ suffix: 5000 }, 1000)).toBe("bytes=-5000");
  });
});
