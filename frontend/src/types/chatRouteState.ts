import type { DefaultPermissions, EffortLevel, QueueItemImage, UiAgentProviderKind } from "shared/types/index.js";

/** A staged draft opened from the chat list, prefilled into the composer. */
export interface ChatRouteDraft {
  id: string;
  user_message: string;
  images?: QueueItemImage[];
}

/**
 * The router `state` the Chat page reads, written by everything that
 * navigates to `/chat/new` or `/chat/:id`. Every field is optional: a history
 * entry can be reached by back/forward or a reload with any subset of it, or
 * none.
 *
 * The new-chat fields (provider, effort, model, …) are only honored when the
 * chat is created; an existing chat reads the same facts from its metadata.
 */
export interface ChatRouteState {
  /** Permissions for a new chat. Falls back to the localStorage defaults. */
  defaultPermissions?: DefaultPermissions;
  /** Agent identity prompt, for a chat started from an agent. */
  systemPrompt?: string;
  agentAlias?: string;
  provider?: UiAgentProviderKind;
  /** The ACP vendor; required alongside `provider: "acp"`. */
  acpProviderId?: string;
  effort?: EffortLevel;
  /** The harness's own model id. */
  model?: string;
  requireExplicitCompletion?: boolean;
  /** Model safety review for a new chat (shared/types/permissions.ts). */
  modelReview?: boolean;
  /** Offer a new linked chat's permission prompts to its parent too. Only meaningful with `parentChatId`. */
  parentAnswers?: boolean;
  /**
   * The space a new chat is filed into, as picked on the New Chat panel.
   * Absent falls back to the tab's active space. Ignored by the server when
   * `parentChatId` links the chat into a tree (the tree's space wins).
   */
  spaceId?: string;
  /** Parentage-tree linkage, forwarded to the new-chat request. */
  parentChatId?: string;
  chatRole?: string;
  /**
   * Optimistic user messages carried across the /chat/new → /chat/:id
   * redirect. A history entry written before this was a list holds a bare
   * string.
   */
  inFlightMessage?: string[] | string;
  draft?: ChatRouteDraft;
}

/** `location.state` as a {@link ChatRouteState}; `{}` when there is none. */
export function readChatRouteState(state: unknown): ChatRouteState {
  return state && typeof state === "object" ? (state as ChatRouteState) : {};
}
