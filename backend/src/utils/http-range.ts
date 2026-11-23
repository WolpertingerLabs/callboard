/**
 * A strict, size-independent parse of a `Range` request header (RFC 9110
 * §14.1.2), for the two places that need more than `send` gives us:
 *
 *  - Local files: `send` answers 416 to a syntactically invalid range such as
 *    `bytes=x`, but RFC 9110 says an invalid Range is ignored (200). The route
 *    drops a header this parser calls `invalid` before handing off to `send`.
 *  - The URL proxy: the client's header string is never forwarded. A single
 *    range is re-serialised from integers by {@link serializeUpstreamRange};
 *    anything else sends no Range upstream.
 *
 * Only the `bytes` unit is recognised, matching `send` (`/^ *bytes=/`).
 */

export type ByteRangeSpec = { start: number; end?: number } | { suffix: number };

export type ParsedRange = { kind: "invalid" } | { kind: "multi" } | { kind: "single"; range: ByteRangeSpec };

const RANGE_SPEC = /^(\d+)-(\d*)$/;
const SUFFIX_SPEC = /^-(\d+)$/;

function toInt(digits: string): number | undefined {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : undefined;
}

function parseSpec(spec: string): ByteRangeSpec | undefined {
  const suffix = SUFFIX_SPEC.exec(spec);
  if (suffix) {
    const n = toInt(suffix[1]);
    return n === undefined ? undefined : { suffix: n };
  }
  const m = RANGE_SPEC.exec(spec);
  if (!m) return undefined;
  const start = toInt(m[1]);
  if (start === undefined) return undefined;
  if (m[2] === "") return { start };
  const end = toInt(m[2]);
  // first-pos > last-pos makes the whole range-spec invalid, not unsatisfiable.
  if (end === undefined || end < start) return undefined;
  return { start, end };
}

/** Parse a `Range` header value without knowing the representation's size. */
export function parseRangeHeader(header: string): ParsedRange {
  const m = /^ *bytes=(.*)$/.exec(header);
  if (!m) return { kind: "invalid" };
  const specs = m[1].split(",").map((s) => s.trim());
  const parsed: ByteRangeSpec[] = [];
  for (const spec of specs) {
    const p = parseSpec(spec);
    if (!p) return { kind: "invalid" };
    parsed.push(p);
  }
  if (parsed.length !== 1) return { kind: "multi" };
  return { kind: "single", range: parsed[0] };
}

/**
 * The `Range` value to send upstream for a client's single range, built from
 * integers only. A range-from-start is clamped to at most `maxBytes`, so an
 * open-ended `bytes=0-` (what every media element sends first) asks for one
 * bounded window rather than the whole remainder; the 206 that comes back is
 * self-describing and the browser requests the next window as it plays. A
 * suffix range cannot be clamped without the size and is left to the
 * response-size cap.
 */
export function serializeUpstreamRange(range: ByteRangeSpec, maxBytes: number): string {
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  const lastAllowed = range.start + maxBytes - 1;
  const end = range.end === undefined ? lastAllowed : Math.min(range.end, lastAllowed);
  return `bytes=${range.start}-${end}`;
}
