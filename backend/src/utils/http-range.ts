/**
 * A strict, size-independent parse of a `Range` request header (RFC 9110
 * §14.1.2), for the two places that need more than `send` gives us:
 *
 *  - Local files: `send` answers 416 to a syntactically invalid range such as
 *    `bytes=x`, but RFC 9110 says an invalid Range is ignored (200). The route
 *    drops a header this parser calls `invalid` before handing off to `send`.
 *  - The URL proxy: the client's header string is never forwarded. A single
 *    range is clamped by {@link upstreamRangeFor} and re-serialised from
 *    integers by {@link formatByteRange}; anything else sends no Range
 *    upstream. The upstream's answer is checked by
 *    {@link validateUpstreamContentRange} before it is relayed.
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
 * The range to request upstream for a client's single range, or undefined to
 * send no Range at all. A range-from-start is clamped to at most `maxBytes`,
 * so an open-ended `bytes=0-` (what every media element sends first) asks for
 * one bounded window rather than the whole remainder; the 206 that comes back
 * is self-describing and the browser requests the next window as it plays. A
 * suffix range cannot be clamped without knowing the size, so one longer than
 * `maxBytes` is not forwarded: the client gets a (capped) plain response
 * instead of a 413.
 */
export function upstreamRangeFor(range: ByteRangeSpec, maxBytes: number): ByteRangeSpec | undefined {
  if ("suffix" in range) return range.suffix <= maxBytes ? range : undefined;
  const lastAllowed = range.start + maxBytes - 1;
  return { start: range.start, end: range.end === undefined ? lastAllowed : Math.min(range.end, lastAllowed) };
}

/** A `Range` header value, built from integers only. */
export function formatByteRange(range: ByteRangeSpec): string {
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  return `bytes=${range.start}-${range.end ?? ""}`;
}

/**
 * Parse an upstream 206's `Content-Range` and check it is consistent with
 * what we asked for: `first <= last`, `last < total` (when the total is
 * known), the length matches `Content-Length` (when present), and the bytes
 * lie within `requested`. Returns the value to relay, or undefined.
 */
export function validateUpstreamContentRange(header: string | undefined, contentLength: string | undefined, requested: ByteRangeSpec): string | undefined {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header ?? "");
  if (!m) return undefined;
  const first = toInt(m[1]);
  const last = toInt(m[2]);
  const total = m[3] === "*" ? undefined : toInt(m[3]);
  if (first === undefined || last === undefined || first > last) return undefined;
  if (m[3] !== "*" && (total === undefined || last >= total)) return undefined;
  const length = last - first + 1;
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== length)) return undefined;
  if ("suffix" in requested) {
    if (length > requested.suffix) return undefined;
    if (total !== undefined && first < total - requested.suffix) return undefined;
  } else {
    if (first < requested.start) return undefined;
    if (requested.end !== undefined && last > requested.end) return undefined;
  }
  return `bytes ${first}-${last}/${m[3]}`;
}
