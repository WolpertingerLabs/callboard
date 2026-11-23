/**
 * Chat notices: system messages addressed to a chat's agent, delivered as a
 * turn when the chat is next idle.
 *
 * The producer is computer control. Its human approvals no longer hold a tool
 * call open, so the agent learns the answer later, from one of these: "the
 * human approved; the action was performed", "the human refused", "control was
 * enabled". Delivery is the completion handler's (`session-completion-handler.ts`)
 * — the same engine that delivers spawned-session callbacks and, through its
 * idle hook, held messages:
 *
 *  - the chat is idle → the notice is sent as a fresh turn straight away;
 *  - the chat is mid-turn, or a turn is starting → it waits, and goes out when
 *    that turn ends, after any held messages the user queued;
 *  - the chat is archived or deleted → it is dropped, never sent: a send would
 *    un-archive the chat (`sendMessage` reopens an archived tree).
 *
 * That goes through the shared `sendMessage`, so it is the same on every
 * engine (Claude Code, Codex, pi).
 *
 * **Ride-along notices** (`wake: false`) never start a turn. They are for
 * things the human did — withdrawing a request by Stop, Revoke, a permission
 * change — where waking the agent would spend a turn nobody asked for, but the
 * agent was promised it would be told. They are claimed by the chat's next
 * turn, whatever starts it (the user, a held message, a wake notice), and
 * prepended to that turn's user prompt as a clearly marked block: see
 * {@link claimRideAlongNotices}. Never the system channel: Codex persists
 * `developer_instructions` into thread history, so a notice there would become
 * a permanent developer message later turns re-read as current — and system
 * authority is the last place a notice should be able to reach.
 *
 * **Host-fixed text only.** A notice is read by the agent as coming from
 * Callboard, so no notice may carry agent- or page-supplied content: no typed
 * text, no URLs, no key names, no driver error text. Producers name a request
 * by its id and a whitelisted action type, and give fixed reason strings.
 *
 * Why not a held message: those are the user's own text, shown in their queue,
 * editable, removable and paused by Stop. A notice is the daemon telling the
 * agent something; the user did not write it and should not have to manage it.
 *
 * In memory on purpose. Everything a notice describes — an open approval, a
 * computer-control session — is in-memory too and does not survive a restart,
 * so a notice persisted across one would describe a session that is gone.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-notices");

export interface ChatNotice {
  id: string;
  text: string;
  createdAt: number;
  /** False: rides along with the next turn and never starts one. */
  wake: boolean;
  /** Delivery attempts that failed to start a turn. */
  attempts: number;
}

/** Notices per chat beyond this are dropped oldest-first; each is one human answer, so this is never reached in use. */
const MAX_NOTICES_PER_CHAT = 20;

/**
 * A wake notice whose delivery turn failed to start this many times is
 * dropped. Retries happen on each session stop, so without a cap a chat that
 * can never be resumed (its engine session is gone, its provenance no longer
 * verifies) would be retried on every stop in the daemon, forever.
 */
export const MAX_NOTICE_DELIVERY_ATTEMPTS = 5;

const notices = new Map<string, ChatNotice[]>();

type Wakeup = (chatId: string) => Promise<unknown>;
let wakeup: Wakeup | null = null;

/**
 * Installed by the completion handler at init. Indirect so this module stays a
 * leaf: computer control imports it, and the completion handler reaches
 * `sendMessage`, which reaches computer control.
 */
export function setChatNoticeWakeup(fn: Wakeup | null): void {
  wakeup = fn;
}

/**
 * Queue a notice for the chat's agent. A wake notice (the default) is
 * delivered now if the chat is idle; a ride-along one waits for the next turn.
 */
export function enqueueChatNotice(chatId: string, text: string, options: { wake?: boolean } = {}): ChatNotice {
  const wake = options.wake !== false;
  const notice: ChatNotice = { id: randomUUID(), text, createdAt: Date.now(), wake, attempts: 0 };
  const list = notices.get(chatId) ?? [];
  list.push(notice);
  if (list.length > MAX_NOTICES_PER_CHAT) {
    const dropped = list.splice(0, list.length - MAX_NOTICES_PER_CHAT);
    log.warn(`Dropped ${dropped.length} undelivered notice(s) for ${chatId}: over ${MAX_NOTICES_PER_CHAT} queued`);
  }
  notices.set(chatId, list);
  if (!wake) return notice;
  if (wakeup) {
    void wakeup(chatId).catch((err: unknown) => {
      log.error(`Delivering a notice to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    log.warn(`Notice queued for ${chatId} with no delivery engine installed; it waits for the chat's next idle transition`);
  }
  return notice;
}

/** The chat's undelivered wake notices, oldest first — the ones that may start a turn. */
export function peekChatNotices(chatId: string): ChatNotice[] {
  return (notices.get(chatId) ?? []).filter((notice) => notice.wake);
}

/** Brackets a ride-along block in the user prompt, so it cannot be mistaken for the human's words. */
export const RIDE_ALONG_HEADER = "[Callboard system notice — not typed by the human. Computer-control updates since your last turn:]";
export const RIDE_ALONG_FOOTER = "[End of Callboard notice. The human's message, if any, follows.]";

/** Notices a starting turn is carrying, not yet known to have been delivered. */
const claimed = new Map<string, ChatNotice[][]>();

export interface RideAlongClaim {
  /** The marked block to prepend to the turn's user prompt. */
  text: string;
  /** The turn started: these notices are delivered, forget them. */
  commit(): void;
  /** The turn did not start: put them back, ahead of anything newer. Idempotent. */
  release(): void;
}

/**
 * Claim the chat's ride-along notices for a turn that is about to start, or
 * null when there are none. Nothing is lost if the turn never starts: the
 * caller commits once the engine has the prompt (`session_started`), and
 * releases on any failure before that, which puts the notices back. A claim is
 * exclusive — a concurrent turn will not carry the same notices twice.
 * Wake notices are not claimed: they are the prompt of their own delivery turn.
 */
export function claimRideAlongNotices(chatId: string): RideAlongClaim | null {
  const list = notices.get(chatId);
  const riding = list?.filter((notice) => !notice.wake) ?? [];
  if (!riding.length) return null;
  const waking = list!.filter((notice) => notice.wake);
  if (waking.length) notices.set(chatId, waking);
  else notices.delete(chatId);
  const claims = claimed.get(chatId) ?? [];
  claims.push(riding);
  claimed.set(chatId, claims);
  let settled = false;
  const unclaim = () => {
    const left = (claimed.get(chatId) ?? []).filter((claim) => claim !== riding);
    if (left.length) claimed.set(chatId, left);
    else claimed.delete(chatId);
  };
  return {
    text: [RIDE_ALONG_HEADER, ...riding.map((notice) => `- ${notice.text}`), RIDE_ALONG_FOOTER].join("\n"),
    commit: () => {
      if (settled) return;
      settled = true;
      unclaim();
    },
    release: () => {
      if (settled) return;
      settled = true;
      unclaim();
      notices.set(chatId, [...riding, ...(notices.get(chatId) ?? [])]);
    },
  };
}

/**
 * The user prompt with a ride-along block in front: a string gets it as a
 * leading paragraph, an iterable gets it on its first user message (as text,
 * or as a leading text block of a multimodal message). The same text reaches
 * every engine, since every engine consumes these two shapes.
 */
export function prependToPrompt(prompt: string | AsyncIterable<unknown>, block: string): string | AsyncIterable<unknown> {
  if (typeof prompt === "string") return `${block}\n\n${prompt}`;
  return (async function* () {
    let done = false;
    for await (const item of prompt) {
      const message = (item as { type?: unknown; message?: { content?: unknown } } | null)?.message;
      if (!done && (item as { type?: unknown } | null)?.type === "user" && message) {
        done = true;
        const content = message.content;
        const next = typeof content === "string" ? `${block}\n\n${content}` : Array.isArray(content) ? [{ type: "text", text: block }, ...content] : content;
        yield { ...(item as object), message: { ...message, content: next } };
        continue;
      }
      yield item;
    }
  })();
}

/**
 * Count a failed delivery of these notices; drop any that reached
 * {@link MAX_NOTICE_DELIVERY_ATTEMPTS}. Returns how many were dropped.
 */
export function recordNoticeDeliveryFailure(chatId: string, ids: string[]): number {
  const list = notices.get(chatId);
  if (!list) return 0;
  const failed = new Set(ids);
  const kept: ChatNotice[] = [];
  let dropped = 0;
  for (const notice of list) {
    if (failed.has(notice.id) && ++notice.attempts >= MAX_NOTICE_DELIVERY_ATTEMPTS) dropped++;
    else kept.push(notice);
  }
  if (dropped) log.warn(`Dropped ${dropped} notice(s) for ${chatId} after ${MAX_NOTICE_DELIVERY_ATTEMPTS} failed delivery attempts`);
  if (kept.length) notices.set(chatId, kept);
  else notices.delete(chatId);
  return dropped;
}

/** Forget every notice for a chat (archived or deleted). Returns how many. */
export function dropChatNotices(chatId: string): number {
  const count = notices.get(chatId)?.length ?? 0;
  notices.delete(chatId);
  return count;
}

/** Forget delivered notices by id. */
export function removeChatNotices(chatId: string, ids: string[]): void {
  const list = notices.get(chatId);
  if (!list) return;
  const drop = new Set(ids);
  const left = list.filter((notice) => !drop.has(notice.id));
  if (left.length) notices.set(chatId, left);
  else notices.delete(chatId);
}

/** Chats with a wake notice undelivered — delivery candidates. */
export function chatsWithNotices(): string[] {
  return [...notices.entries()].filter(([, list]) => list.some((notice) => notice.wake)).map(([chatId]) => chatId);
}

/** Test seam. */
export function clearChatNoticesForTest(): void {
  notices.clear();
  claimed.clear();
}
