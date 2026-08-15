/**
 * Shared HTTP mapping for errors that several routes raise the same way.
 */
import type { Response } from "express";
import { RetiredProviderError } from "../services/claude.js";

/**
 * Answer a request that named a harness this build removed.
 *
 * **410 Gone, not 500.** The message was always actionable ("this chat ran on
 * the OpenRouter harness, which has been removed") and reached the user either
 * way, because the frontend renders `errorData.error` verbatim for any non-ok
 * response. What 500 got wrong is the *claim*: it says the server failed, so a
 * legacy chat someone opens out of habit reads as a Callboard crash, shows up
 * in error-rate monitoring, and invites a retry that cannot ever succeed. 410
 * says the opposite and says it permanently — the chat's state is fine, the
 * engine that could read it is gone, and no retry will bring it back.
 *
 * Not 409: `POST /api/chats/:id/message` already answers 409 for two
 * *recoverable* conflicts (`branch_drift`, `uncommitted_changes`), each with a
 * confirm-and-resend path in `Chat.tsx`. Reusing the status for a refusal with
 * no such path would put an unrecoverable case in the bucket the client reads
 * as "ask the user, then try again".
 *
 * Returns true when it handled the error, so callers can `if (...) return;`
 * and fall through to their own generic handling otherwise.
 */
export function sendRetiredProviderError(res: Response, err: unknown): boolean {
  if (!(err instanceof RetiredProviderError)) return false;
  res.status(410).json({ error: err.message, code: "retired_provider" });
  return true;
}
