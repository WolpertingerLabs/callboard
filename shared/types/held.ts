import type { QueueItemImage } from "./queue.js";

/**
 * A message the user sent while the chat was running, held by the daemon
 * until that run ends ("Enqueue Send").
 *
 * Stored per chat in `DATA_DIR/held/<chatId>.json` and delivered by
 * `held-message-dispatcher.ts` when the chat's session stops: one item per
 * idle transition, in order, each as its own turn through `startChatTurn`.
 *
 * Crosses REST only — `GET /chats/:id/activity` (`heldMessages`) and the
 * `/chats/:id/held` routes — never the SSE wire in `stream.ts`, so it needs no
 * capability gate. It is deliberately not a `QueueItem`: an older bundle lists
 * every queue item in Staging as a draft, and drafts are never auto-sent.
 */
export interface HeldMessage {
  id: string;
  chatId: string;
  /** The prompt as the user composed it. May be empty when `images` is set. */
  text: string;
  /** Attachments, by upload id. References, not ownership — as for drafts. */
  images?: QueueItemImage[];
  createdAt: string;
  /**
   * Append-only, like every enum a client may switch on: a client must render
   * an unknown state as "not sending yet" rather than dropping the item.
   *
   * - `queued` — waiting for the current turn to end.
   * - `delivering` — being started right now; it cannot be taken or edited.
   * - `paused` — waiting on the user (they stopped the run, or the daemon
   *   restarted); `POST /held/resume` re-queues it.
   * - `failed` — the turn could not start; `reason` says why.
   */
  state: "queued" | "paused" | "failed" | "delivering";
  /** Why a `paused` or `failed` item is not going out. */
  reason?: string;
  /** Per-message settings, as on `POST /chats/:id/message`. */
  activePlugins?: string[];
  model?: string;
  effort?: string;
  maxTurns?: number;
}
