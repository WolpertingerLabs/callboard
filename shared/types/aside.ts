/**
 * Asides: a side question about quoted passages of a chat, asked in a child
 * chat forked at the latest quoted message (`POST /api/chats/:id/fork` with
 * `kind: "aside"`) — or, with `forkAtLatest` and no quotes, about the
 * conversation so far, forked at its newest message. See
 * plans/highlight-asides.md.
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
  /** "system" since this was added: a daemon before it refuses such a quote (400), never mislabels it. */
  role: "user" | "assistant" | "system";
  text: string;
  /**
   * Which repeat of `text` in the message this is — 0 for the first (matched
   * ignoring whitespace) — so the passage is found again in the right place
   * when the same words appear more than once. Optional and additive: absent
   * means the first, which is also what a daemon before it stores (it drops
   * the key) and what quotes made before it carry.
   */
  occurrence?: number;
}

/** Highest `occurrence` accepted — far past any real repeat count, short of nonsense. */
export const ASIDE_MAX_OCCURRENCE = 100_000;

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

/**
 * The one quoted-prompt format, shared by the main-chat send (the composer's
 * quote tray, `frontend/src/utils/messageQuotes.ts`) and an aside's first turn
 * (`POST /chats/:id/fork`):
 *
 *     > **Assistant, 14:02:**
 *     > the passage
 *
 *     the question
 */

/** Anything renderable as a quote: an {@link AsideQuote}, or a tray chip (whose role may also be "system"). */
export interface QuoteLike {
  timestamp: string;
  role: string;
  text: string;
  /**
   * Names the quote's origin in place of the role label — for a passage that
   * is not from the chat it is sent in (an aside's reply inserted into the
   * main chat reads `Aside reply, 14:02`).
   */
  label?: string;
}

const ROLE_LABEL: Record<string, string> = { user: "User", assistant: "Assistant", system: "System" };

/** `User` / `Assistant` / `System`, or `Message` for anything else. */
export function quoteRoleLabel(role: string): string {
  return ROLE_LABEL[role] ?? "Message";
}

/** A zone `Intl` accepts, or undefined (the runtime's local zone). */
function validTimeZone(timeZone: unknown): string | undefined {
  if (typeof timeZone !== "string" || !timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** Calendar and clock fields of `date` in `timeZone` (undefined = local). */
function zonedParts(date: Date, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone && { timeZone }),
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour").padStart(2, "0"), minute: get("minute").padStart(2, "0") };
}

/**
 * When the quoted message was sent: `14:02` on the same day as `now`, with the
 * date (`Nov 18, 14:02`) otherwise, and the year too when it differs. In the
 * IANA `timeZone` when given and valid, else the runtime's local zone. Empty
 * for an unparseable timestamp.
 */
export function formatQuoteTime(timestamp: string, opts: { now?: Date; timeZone?: unknown } = {}): string {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return "";
  const zone = validTimeZone(opts.timeZone);
  const at = zonedParts(date, zone);
  const today = zonedParts(opts.now ?? new Date(), zone);
  const time = `${at.hour}:${at.minute}`;
  if (at.year === today.year && at.month === today.month && at.day === today.day) return time;
  return `${at.month} ${at.day}${at.year === today.year ? "" : ` ${at.year}`}, ${time}`;
}

/** {@link formatQuoteTime} as a formatter for {@link renderQuotedPrompt}, in `timeZone` (the asker's). */
export function quoteTimeFormatter(timeZone?: unknown, now?: Date): (iso: string) => string {
  return (iso) => formatQuoteTime(iso, { timeZone, ...(now && { now }) });
}

/** `Assistant, 14:02` — the origin line a quote is introduced by; just the role without a time. */
export function formatQuoteOrigin(
  quote: Pick<QuoteLike, "role" | "timestamp" | "label">,
  formatTime: (iso: string) => string | null = quoteTimeFormatter(),
): string {
  const time = formatTime(quote.timestamp);
  const role = quote.label || quoteRoleLabel(quote.role);
  return time ? `${role}, ${time}` : role;
}

/**
 * One quote as a Markdown blockquote under its origin line. Line endings are
 * unified and blank lines at either end dropped; indentation is kept (code).
 */
export function formatQuoteBlock(quote: QuoteLike, formatTime?: (iso: string) => string | null): string {
  const body = quote.text
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"));
  return [`> **${formatQuoteOrigin(quote, formatTime)}:**`, ...body].join("\n");
}

/**
 * The quotes as blockquotes, in order, separated by a blank line so adjacent
 * quotes do not merge, then `question` as given. With no quotes it is
 * `question` unchanged, byte for byte; an empty question adds nothing.
 *
 * `formatTime` renders a quote's timestamp (`null`/"" leaves it out);
 * defaults to {@link formatQuoteTime} in the local zone.
 */
export function renderQuotedPrompt(quotes: readonly QuoteLike[], question: string, formatTime?: (iso: string) => string | null): string {
  if (quotes.length === 0) return question;
  const blocks = quotes.map((quote) => formatQuoteBlock(quote, formatTime)).join("\n\n");
  return question ? `${blocks}\n\n${question}` : blocks;
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
    const { timestamp, role, text, occurrence } = raw as Record<string, unknown>;
    if (typeof timestamp !== "string" || isNaN(new Date(timestamp).getTime())) return { ok: false, error: `quotes[${i}].timestamp must be an ISO timestamp` };
    if (role !== "user" && role !== "assistant" && role !== "system") return { ok: false, error: `quotes[${i}].role must be "user", "assistant" or "system"` };
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: `quotes[${i}].text must be a non-empty string` };
    if (text.length > ASIDE_MAX_QUOTE_CHARS) return { ok: false, error: `quotes[${i}].text is longer than ${ASIDE_MAX_QUOTE_CHARS} characters` };
    if (limitMs !== undefined && new Date(timestamp).getTime() > limitMs) return { ok: false, error: `quotes[${i}] is after the fork point` };
    if (occurrence !== undefined && !(Number.isSafeInteger(occurrence) && (occurrence as number) >= 0 && (occurrence as number) <= ASIDE_MAX_OCCURRENCE)) {
      return { ok: false, error: `quotes[${i}].occurrence must be a whole number from 0 to ${ASIDE_MAX_OCCURRENCE}` };
    }
    // 0 is the default: stored only when it says something.
    quotes.push({ timestamp, role, text, ...(typeof occurrence === "number" && occurrence > 0 && { occurrence }) });
  }
  return { ok: true, quotes };
}
