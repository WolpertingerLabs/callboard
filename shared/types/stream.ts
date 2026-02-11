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
    | "compacting";
  content: string;
  toolName?: string;

  input?: Record<string, unknown>;
  questions?: unknown[];
  suggestions?: unknown[];
  chatId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat?: any;
  /** Reason the session ended (e.g. "max_turns", "aborted") — attached to "done" events */
  reason?: string;
}
