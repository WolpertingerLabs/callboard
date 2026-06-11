/**
 * Log-rendering helpers for the OR adapter: serialize harness logger `fields`
 * payloads and summarize `error` event causes without ever throwing on
 * unknown shapes. The openrouter-agent-harness logger carries the actual
 * failure context (error message, structured detail, serialized failed
 * event) in its third `fields` argument — dropping it leaves Winston with
 * bare labels like "OpenRouterAgentRun stream errored" and no error at all.
 */

/** Cap on a serialized `fields` object appended to a log line. */
const MAX_FIELDS_CHARS = 4000;
/** Cap on excerpts (cause messages, HTTP bodies) inside a cause summary. */
const MAX_EXCERPT_CHARS = 500;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

/** JSON-stringify that never throws (circular refs, BigInt, …), truncated. */
export function safeStringify(value: unknown, max: number = MAX_FIELDS_CHARS): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return truncate(serialized, max);
}

/**
 * Render a harness logger `fields` object as a ` {...}` log-line suffix.
 * Empty string when the fields are absent or empty.
 */
export function formatLogFields(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  return ` ${safeStringify(fields)}`;
}

/**
 * Summarize an `error` event's `cause` for logging: the cause's own message
 * (when it adds information beyond the surfaced `primaryMessage`) plus the
 * `statusCode`/`body` that openrouter-agent-harness's HTTP-level SDK errors
 * expose — checked on the cause itself and one `cause` hop deeper, matching
 * the harness's own unwrapping. Empty string when nothing useful is present.
 */
export function describeErrorCause(cause: unknown, primaryMessage?: string): string {
  if (cause === null || typeof cause !== "object") return "";
  const hops: object[] = [cause];
  const nested = (cause as { cause?: unknown }).cause;
  if (nested !== null && typeof nested === "object" && nested !== undefined) hops.push(nested);

  const parts: string[] = [];
  const msg = (cause as { message?: unknown }).message;
  if (typeof msg === "string" && msg.length > 0 && msg !== primaryMessage) {
    parts.push(`message=${truncate(msg, MAX_EXCERPT_CHARS)}`);
  }
  for (const hop of hops) {
    const status = (hop as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") {
      parts.push(`statusCode=${status}`);
      break;
    }
  }
  for (const hop of hops) {
    const body = (hop as { body?: unknown }).body;
    if (typeof body === "string" && body.length > 0) {
      parts.push(`body=${truncate(body, MAX_EXCERPT_CHARS)}`);
      break;
    }
  }
  return parts.length > 0 ? `, cause: ${parts.join(", ")}` : "";
}
