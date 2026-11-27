/**
 * Turns ended by a permission denial — what the user sees instead of the
 * Claude Code CLI's internal diagnostic.
 *
 * A `canUseTool` deny with `interrupt: true` (callboard's default-policy deny,
 * and a human's "Deny") makes the CLI record the rejected tool_result plus a
 * "[Request interrupted by user]" text turn and stop. Because that last message
 * is neither an assistant text block nor a tool_result-only user message, the
 * CLI reports the turn as `error_during_execution` whose only `errors[]` entry
 * is a diagnostic it builds for its own telemetry:
 *
 *   [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use
 *
 * The CLI strips `[ede_diagnostic]` entries before showing errors in its own
 * UI; callboard used to forward it verbatim as the chat's red error bubble (and
 * to a parent chat's completion), which told nobody what had happened. The run
 * still ends as an error — the denial did stop the work — but in words.
 */

const DIAGNOSTIC_PREFIX = "[ede_diagnostic]";

/**
 * True when every `; `-joined part of a result `reason` is the CLI's
 * turn-end diagnostic, i.e. there is no real provider error to show.
 */
export function isTurnEndDiagnosticOnly(reason: string | undefined): boolean {
  if (!reason) return false;
  const parts = reason
    .split("; ")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => p.startsWith(DIAGNOSTIC_PREFIX));
}

/**
 * The Agent SDK's prefix when it rethrows an error result's text because the
 * CLI exited right after it (sdk.mjs `readMessages`).
 */
const SDK_RETHROW_PREFIX = "Claude Code returned an error result: ";

/** True for the SDK's rethrow of a diagnostic-only error result. */
export function isRethrownTurnEndDiagnostic(message: string | undefined): boolean {
  return !!message && message.startsWith(SDK_RETHROW_PREFIX) && isTurnEndDiagnosticOnly(message.slice(SDK_RETHROW_PREFIX.length));
}

export interface InterruptingDeny {
  toolName: string;
  message: string;
  /** A person pressed Deny, as opposed to the chat's default policy. */
  byUser?: boolean;
}

/** The error text for a turn a permission denial ended. */
export function describeDeniedTurnEnd(deny: InterruptingDeny): string {
  // A person chose this, so don't send them to the permission settings.
  if (deny.byUser) return `Stopped: you denied ${deny.toolName}, which ends the turn. Send a follow-up to tell the agent how to continue.`;
  return `Stopped: ${deny.toolName} was denied (${deny.message}), and a denial ends the turn. Send a follow-up to continue without it, or change this chat's permissions.`;
}
