/**
 * Stream-closed auto-recovery — detection helpers for the Claude Code SDK's
 * unrecoverable "Stream closed" failure mode.
 *
 * Failure mode: the SDK talks to the Claude Code CLI subprocess over a control
 * stream. When that stream dies mid-run (observed with tool calls and Task
 * subagents), every subsequent tool call in the session fails with a
 * "Stream closed" error tool_result — the run never recovers on its own, and
 * the only fix is what users do manually: stop the conversation and resume the
 * session with a "please continue" message.
 *
 * The query loop in claude.ts uses these helpers to detect that state in real
 * time and perform the stop-and-resume automatically: it closes the broken
 * query and re-queries with `options.resume` + a recovery prompt, the same
 * mechanics as the explicit-completion nudge loop.
 *
 * Detection is deliberately Claude-Code-only and conservative:
 *   - tool_result path: requires the SDK's is_error flag plus a short error
 *     payload matching the stream-closed phrasing, and only counts after
 *     {@link STREAM_CLOSED_TOOL_FAILURE_THRESHOLD} consecutive failures — a
 *     healthy tool result in between resets the count.
 *   - thrown / result-error path: matches transport-death messages only, not
 *     generic process exits (a CLI that dies at startup from bad config should
 *     surface as an error, not silently retry).
 */

/** Max automatic stop-and-resume recoveries per sendMessage run. */
export const MAX_STREAM_RECOVERIES = 3;

/**
 * Consecutive stream-closed tool failures required before recovery triggers.
 * One failure could be a transient single-tool hiccup; two in a row (the
 * model's immediate retry also failing) is the broken-transport signature.
 */
export const STREAM_CLOSED_TOOL_FAILURE_THRESHOLD = 2;

/**
 * Error tool_result payloads are terse ("Stream closed", "Error: Stream
 * closed", "Tool permission stream closed before response received").
 * Anything longer is real tool output that merely mentions the phrase
 * (e.g. a Bash grep over these very logs) — never a transport failure.
 */
const MAX_FAILURE_CONTENT_LENGTH = 500;

/** Phrase test for content already known to be an error payload. */
const STREAM_CLOSED_RE = /\bstream closed\b/i;

/**
 * Exact-shape test used when the is_error flag is absent: the whole payload
 * must BE the failure message, not merely contain it.
 */
const BARE_STREAM_CLOSED_RE = /^(?:(?:mcp )?error[^a-z]{0,10})?(?:tool permission )?stream closed(?: before response received)?\.?$/i;

/**
 * Messages thrown by the SDK (or reported on an error result event) when the
 * CLI transport dies mid-run. Kept narrow: plain "process exited" is excluded
 * on purpose — it also fires for non-transient startup failures.
 */
const SESSION_ERROR_RES: readonly RegExp[] = [/\bstream closed\b/i, /ProcessTransport is not ready/i];

/**
 * True when a tool_result event is the "Stream closed" transport-failure
 * signature (as opposed to real tool output that mentions the phrase).
 */
export function isStreamClosedToolFailure(content: string, isError?: boolean): boolean {
  // An explicit success flag is trusted — even exact failure-shaped text is
  // then just tool output (e.g. an echo of the phrase).
  if (isError === false) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FAILURE_CONTENT_LENGTH) return false;
  if (isError === true) return STREAM_CLOSED_RE.test(trimmed);
  return BARE_STREAM_CLOSED_RE.test(trimmed);
}

/**
 * True when an error thrown from query iteration (or the reason on a
 * status:"error" result event) indicates the CLI transport died mid-run.
 */
export function isStreamClosedSessionError(message: string | undefined): boolean {
  if (!message) return false;
  return SESSION_ERROR_RES.some((re) => re.test(message));
}

/**
 * The user-message injected into the resumed session — the automated
 * equivalent of the user manually stopping and typing "please continue".
 * Appears in the transcript like a nudge prompt does.
 */
export function buildStreamRecoveryPrompt(attempt: number, max: number): string {
  return (
    `[Automatic recovery ${attempt}/${max}] The previous turn was interrupted by a harness transport failure — ` +
    `tool calls started returning "Stream closed" errors. This was not caused by your work; the session has been ` +
    `restarted automatically. Please continue from where you left off, re-running any tool call that failed with ` +
    `a stream error.`
  );
}
