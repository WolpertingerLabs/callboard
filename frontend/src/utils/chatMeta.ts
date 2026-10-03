import type { Chat } from "../api";
import type { NativeCodexAgent } from "shared/types/chat.js";

/**
 * The keys the sidebar reads off `chat.metadata`, typed as the daemon writes
 * them. Nothing here is validated — the shape is trusted exactly as the inline
 * `JSON.parse` calls this replaced trusted it — so readers keep their own
 * `=== true` / `|| undefined` coercions.
 *
 * Distinct from `ChatMeta` in hooks/useChatMeta, which narrows a different set
 * of fields for the Chat page; narrowing these would change what a row shows
 * for metadata the narrowing rejects.
 */
export interface SidebarChatMeta {
  title?: string;
  preview?: string;
  bookmarked?: boolean;
  pinned?: boolean;
  agentAlias?: string;
  triggered?: boolean;
  nativeAgent?: NativeCodexAgent;
  lastReadAt?: string;
  chatStatus?: string;
  chatStatusEmoji?: string;
  summon?: { message: string; urgency: string; createdAt: string };
  provider?: string;
  acpProviderId?: string;
  jobRunId?: string;
  jobStepId?: string;
  jobRunNeedsYou?: boolean;
  rootChatId?: string;
  parentChatId?: string;
  forkedFrom?: string;
}

const EMPTY: Readonly<SidebarChatMeta> = Object.freeze({});

/** Parsed once per (chat object, metadata string). See {@link chatMeta}. */
const cache = new WeakMap<Chat, { metadata: string; meta: Readonly<SidebarChatMeta> }>();

function parse(metadata: string | undefined): Readonly<SidebarChatMeta> {
  if (!metadata) return EMPTY;
  try {
    const raw: unknown = JSON.parse(metadata);
    return raw && typeof raw === "object" ? (raw as SidebarChatMeta) : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * A chat's parsed metadata, cached on the chat object. Never throws; metadata
 * that is absent, unparseable or not an object reads as `{}`.
 *
 * The sidebar reads every row's metadata on every render, and lineage
 * resolution reads each ancestor's once per descendant, so without the cache
 * that is n × depth parses per render. Chats are replaced rather than mutated
 * on update, so object identity would be enough on its own — the cache checks
 * the metadata string too, so a mutated `chat.metadata` re-parses instead of
 * serving a stale object.
 *
 * The result is shared: treat it as read-only. To change metadata, use
 * {@link withChatMeta}, which works on a private copy.
 */
export function chatMeta(chat: Chat): Readonly<SidebarChatMeta> {
  const hit = cache.get(chat);
  if (hit && hit.metadata === chat.metadata) return hit.meta;
  const meta = parse(chat.metadata);
  cache.set(chat, { metadata: chat.metadata, meta });
  return meta;
}

/**
 * A copy of `chat` with its metadata edited by `edit`, or `chat` itself when
 * the metadata does not parse — a row is never rewritten from a guess.
 */
export function withChatMeta(chat: Chat, edit: (meta: Record<string, unknown>) => void): Chat {
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    edit(meta);
    return { ...chat, metadata: JSON.stringify(meta) };
  } catch {
    return chat;
  }
}
