export interface StreamEvent {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "done"
    | "error"
    | "permission_request"
    | "user_question"
    | "plan_review"
    | "chat_created"
    | "compacting"
    | "cleared";
  content: string;
  toolName?: string;
  /**
   * Where the tool executed — "openrouter_server" for OpenRouter server
   * tools (datetime / web_search / web_fetch), "local"/absent for tools run
   * by the agent process. Attached to "tool_use" / "tool_result" events.
   */
  toolSource?: "local" | "openrouter_server";

  input?: Record<string, unknown>;
  questions?: unknown[];
  suggestions?: unknown[];
  chatId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat?: any;
  /** Reason the session ended (e.g. "max_turns", "aborted") — attached to "done" events */
  reason?: string;
  /**
   * Cumulative USD spent in the just-finished run, when the adapter reports
   * one. Attached to `done` events (and forwarded as `message_complete` over
   * SSE) so the chat UI can show a running spend total. Currently populated
   * for OpenRouter chats; Claude Code chats report per-message rather than
   * per-run costs and may surface 0 for subscription-authenticated sessions.
   */
  costUsd?: number;
  /**
   * Active per-session spend cap in USD when one applies. Mirrored from the
   * OpenRouter adapter so the UI can render "$0.42 of $5.00" and the
   * max_budget end-of-session message can quote the cap the user actually
   * configured. Undefined for Claude Code chats.
   */
  maxBudgetUsd?: number;
}
