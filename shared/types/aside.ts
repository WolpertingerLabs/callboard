/**
 * Asides: a side question about quoted passages of a chat, asked in a child
 * chat forked at the latest quoted message (`POST /api/chats/:id/fork` with
 * `kind: "aside"`). See plans/highlight-asides.md.
 *
 * `chatRole: "aside"` is a free-form role string on the wire, not a gated
 * enum value: an old bundle shows an aside as an ordinary child chat.
 */

/** The child-chat role an aside is created with. */
export const ASIDE_ROLE = "aside";

/** One quoted passage: the message it came from (by timestamp), who wrote it, and the selected text. */
export interface AsideQuote {
  /** ISO timestamp of the quoted message. Never later than the aside's fork point. */
  timestamp: string;
  role: "user" | "assistant";
  text: string;
}

/** Most quotes one aside (or one quoted prompt) may carry. */
export const ASIDE_MAX_QUOTES = 20;
/** Longest single quote, in characters. */
export const ASIDE_MAX_QUOTE_CHARS = 10_000;
/** Longest question, in characters. */
export const ASIDE_MAX_PROMPT_CHARS = 20_000;
/** Longest question excerpt in an aside's title. */
export const ASIDE_TITLE_MAX_CHARS = 60;

/** An aside's fork point: the latest quoted message's timestamp (`undefined` for no quotes). */
export function asideForkPoint(quotes: readonly AsideQuote[]): string | undefined {
  let latest: AsideQuote | undefined;
  for (const quote of quotes) {
    if (!latest || new Date(quote.timestamp).getTime() > new Date(latest.timestamp).getTime()) latest = quote;
  }
  return latest?.timestamp;
}

/** Local `HH:MM` — the default origin-line time. */
function localTime(iso: string): string | null {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * An origin-line time formatter for {@link renderQuotedPrompt}: `HH:MM` in the
 * IANA `timeZone` (the asking browser's), or the local zone of whoever runs
 * this when it is absent or not a zone `Intl` knows.
 */
export function quoteTimeFormatter(timeZone?: unknown): (iso: string) => string | null {
  if (typeof timeZone !== "string" || !timeZone) return localTime;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    return localTime;
  }
  return (iso) => {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    const parts = format.formatToParts(date);
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    return hour && minute ? `${hour}:${minute}` : null;
  };
}

/**
 * The quotes as Markdown blockquotes, each under an origin line
 * (`> **Assistant, 14:02:**`), then the question. Blockquotes are separated by
 * a blank line so adjacent quotes do not merge into one.
 *
 * `formatTime` renders a quote's timestamp; return `null` to leave the time
 * out. Defaults to local `HH:MM`.
 */
export function renderQuotedPrompt(quotes: readonly AsideQuote[], question: string, formatTime: (iso: string) => string | null = localTime): string {
  const blocks = quotes.map((quote) => {
    const who = quote.role === "user" ? "User" : "Assistant";
    const time = formatTime(quote.timestamp);
    const origin = `> **${who}${time ? `, ${time}` : ""}:**`;
    const body = quote.text
      .replace(/\r\n?/g, "\n")
      .trim()
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"));
    return [origin, ...body].join("\n");
  });
  const ask = question.trim();
  return [...blocks, ...(ask ? [ask] : [])].join("\n\n");
}

/** `Aside: <question>`, whitespace-collapsed and truncated; just `Aside` with no text. */
export function asideTitle(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (!flat) return "Aside";
  const cut = flat.length > ASIDE_TITLE_MAX_CHARS ? `${flat.slice(0, ASIDE_TITLE_MAX_CHARS - 1).trimEnd()}…` : flat;
  return `Aside: ${cut}`;
}

/**
 * Parse an untrusted quote list. Refuses (with a reason) rather than
 * repairing: a dropped or trimmed quote would silently ask a different
 * question. `forkPoint`, when given, is the latest timestamp a quote may carry.
 */
export function parseAsideQuotes(value: unknown, forkPoint?: string): { ok: true; quotes: AsideQuote[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "quotes must be an array" };
  if (value.length === 0) return { ok: false, error: "an aside needs at least one quote" };
  if (value.length > ASIDE_MAX_QUOTES) return { ok: false, error: `at most ${ASIDE_MAX_QUOTES} quotes` };
  const limitMs = forkPoint === undefined ? undefined : new Date(forkPoint).getTime();
  const quotes: AsideQuote[] = [];
  for (const [i, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `quotes[${i}] must be an object` };
    const { timestamp, role, text } = raw as Record<string, unknown>;
    if (typeof timestamp !== "string" || isNaN(new Date(timestamp).getTime())) return { ok: false, error: `quotes[${i}].timestamp must be an ISO timestamp` };
    if (role !== "user" && role !== "assistant") return { ok: false, error: `quotes[${i}].role must be "user" or "assistant"` };
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: `quotes[${i}].text must be a non-empty string` };
    if (text.length > ASIDE_MAX_QUOTE_CHARS) return { ok: false, error: `quotes[${i}].text is longer than ${ASIDE_MAX_QUOTE_CHARS} characters` };
    if (limitMs !== undefined && new Date(timestamp).getTime() > limitMs) return { ok: false, error: `quotes[${i}] is after the fork point` };
    quotes.push({ timestamp, role, text });
  }
  return { ok: true, quotes };
}
