/**
 * Held messages — "Enqueue Send".
 *
 * A held message is one the user sent while the chat was running, to go out as
 * a normal message once that run ends. This is the store; delivery is
 * `held-message-dispatcher.ts`.
 *
 * Storage: `DATA_DIR/held/<chatId>.json`, an ordered array (delivery order),
 * written atomically. Keyed by chat id because the chat owns the item — it is
 * neither directory- nor workspace-scoped (see CLAUDE.md → workspace keying).
 *
 * Every operation is synchronous, read-modify-write with no await in between.
 * That is the concurrency story: Node runs one of these at a time, so
 * `claimNext` (dispatcher) and `take` (the user's Edit / Send now) can never
 * both win the same item — whichever runs first changes its state, and the
 * other sees it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import type { HeldMessage } from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";
import { createLogger } from "../utils/logger.js";
import { sessionRegistry } from "./session-registry.js";

export type { HeldMessage };

const log = createLogger("held-messages");

const heldDir = join(DATA_DIR, "held");

/**
 * Chat ids become file names, and Express hands routes a percent-decoded
 * param (`..%2Fvictim` arrives as `../victim`). Chat and session ids are
 * UUIDs or similar word-character tokens; anything else is refused.
 */
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HELD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidHeldChatId(chatId: string): boolean {
  return CHAT_ID.test(chatId);
}

export function isValidHeldId(id: string): boolean {
  return HELD_ID.test(id);
}

/** What a caller supplies; the store assigns identity, time and state. */
export type HeldMessageInput = Pick<HeldMessage, "text" | "images" | "activePlugins" | "model" | "effort" | "maxTurns">;

export type TakeResult = { ok: true; item: HeldMessage } | { ok: false; reason: "not_found" | "delivering" };

/** Reasons shown to the user for a paused item. */
export const PAUSE_REASON_STOPPED = "You stopped the run.";
/** Stopped in the moment it was being started: the run had registered, so its prompt may be in the transcript. */
export const PAUSE_REASON_STOPPED_MID_SEND = "Stopped as it was being sent — it may already appear in the chat.";
export const PAUSE_REASON_RESTARTED = "The daemon restarted.";
export const PAUSE_REASON_BLOCKED = "An earlier held message couldn't be sent.";

function fileFor(chatId: string): string {
  if (!isValidHeldChatId(chatId)) throw new Error(`Invalid chat id for held messages: ${JSON.stringify(chatId)}`);
  return join(heldDir, `${chatId}.json`);
}

/**
 * The chat's list. `forWrite` is for read-modify-write callers: a file that
 * exists but cannot be read then throws instead of reading as empty, since
 * writing the "empty" list back would overwrite messages that were fine.
 */
function read(chatId: string, forWrite = false): HeldMessage[] {
  if (!isValidHeldChatId(chatId)) return [];
  const file = fileFor(chatId);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err: unknown) {
    // EMFILE, EACCES, a transient I/O error: the file may be perfectly good,
    // so it stays where it is — a listing reads as empty this once, and a
    // write is refused rather than allowed to replace it.
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Could not read held-message file for ${chatId}: ${message}`);
    if (forWrite) throw new Error(`Held messages for ${chatId} could not be read: ${message}`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as HeldMessage[];
    setAside(chatId, file, "not a list");
  } catch (err: unknown) {
    // Only bad *content* is set aside; JSON.parse throws nothing else.
    if (!(err instanceof SyntaxError)) throw err;
    setAside(chatId, file, err.message);
  }
  return [];
}

/**
 * Move an unreadable file out of the way before the chat reads as empty —
 * otherwise the next `add` would overwrite it and the messages in it would be
 * gone for good. The new name does not end in `.json`, so the boot scan skips
 * it; it is kept for someone to recover by hand.
 */
function setAside(chatId: string, file: string, why: string): void {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, aside);
    log.error(`Unreadable held-message file for ${chatId} (${why}); moved to ${aside}`);
  } catch (err: unknown) {
    log.error(`Unreadable held-message file for ${chatId} (${why}), and it could not be moved aside: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Persist the chat's list, then tell clients it changed.
 *
 * The signal is the existing `chat_metadata_updated` registry event, which
 * reaches browsers only as a bump of `metadataVersion` on
 * `GET /api/sessions/poll` — the `data` payload never leaves the daemon, and
 * every in-daemon `"change"` listener filters on the event type. So it needs
 * no capability gate and no old client can trip on it; a new client refetches
 * `/activity` on the bump. Without it, a delivery that fails after the run
 * ended (when nothing polls `/activity` any more) would be invisible.
 *
 * Cost: `metadataVersion` is global, so each bump makes *every* open tab
 * refetch its sidebar and cards, not just this chat's. A held message causes
 * a handful of writes over its life, which is fine; do not route anything
 * high-frequency through this function without a narrower signal.
 */
function write(chatId: string, items: HeldMessage[]): void {
  const file = fileFor(chatId);
  if (items.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      return; // already gone: nothing changed
    }
  } else {
    if (!existsSync(heldDir)) mkdirSync(heldDir, { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(items, null, 2), { mode: 0o600 });
  }
  sessionRegistry.notifyMetadata(chatId, { heldMessages: true });
}

export class HeldMessageService {
  /** Every held message for the chat, in delivery order. */
  list(chatId: string): HeldMessage[] {
    return read(chatId);
  }

  /** Whether anything is waiting to go out on the next idle transition. */
  hasQueued(chatId: string): boolean {
    return read(chatId).some((m) => m.state === "queued");
  }

  /** Append a queued item. Throws on an invalid chat id. */
  add(chatId: string, input: HeldMessageInput): HeldMessage {
    const items = read(chatId, true);
    const item: HeldMessage = {
      id: randomUUID(),
      chatId,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      createdAt: new Date().toISOString(),
      state: "queued",
      ...(input.activePlugins !== undefined && { activePlugins: input.activePlugins }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.effort !== undefined && { effort: input.effort }),
      ...(input.maxTurns !== undefined && { maxTurns: input.maxTurns }),
    };
    items.push(item);
    write(chatId, items);
    return item;
  }

  /**
   * Remove and return one item — the user taking it back to edit or send now.
   * Refused while it is `delivering`: the turn is already being started, and
   * handing it back too would send it twice.
   */
  take(chatId: string, id: string): TakeResult {
    const items = read(chatId, true);
    const index = items.findIndex((m) => m.id === id);
    if (index === -1) return { ok: false, reason: "not_found" };
    const item = items[index]!;
    if (item.state === "delivering") return { ok: false, reason: "delivering" };
    items.splice(index, 1);
    write(chatId, items);
    return { ok: true, item };
  }

  /** Patch one item in place. Returns the updated item, or undefined if gone. */
  update(chatId: string, id: string, patch: Partial<Pick<HeldMessage, "state" | "reason">>): HeldMessage | undefined {
    const items = read(chatId, true);
    const item = items.find((m) => m.id === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    if (item.state === "queued" || item.state === "delivering") delete item.reason;
    write(chatId, items);
    return item;
  }

  /** Every `queued` item → `paused` with `reason`. Returns how many changed. */
  pause(chatId: string, reason: string): number {
    const items = read(chatId, true);
    let changed = 0;
    for (const item of items) {
      if (item.state !== "queued") continue;
      item.state = "paused";
      item.reason = reason;
      changed++;
    }
    if (changed > 0) write(chatId, items);
    return changed;
  }

  /** Every `paused` or `failed` item → `queued`. Returns how many changed. */
  resume(chatId: string): number {
    const items = read(chatId, true);
    let changed = 0;
    for (const item of items) {
      if (item.state !== "paused" && item.state !== "failed") continue;
      item.state = "queued";
      delete item.reason;
      changed++;
    }
    if (changed > 0) write(chatId, items);
    return changed;
  }

  /**
   * Claim the next item to deliver: the first `queued` one, which becomes
   * `delivering`. Nothing is claimed while another item is already
   * `delivering` — one turn at a time.
   *
   * Paused and failed items are skipped rather than blocking the queue: they
   * are waiting on the user, and a message held *after* the user paused the
   * others is one they want sent. Order among queued items is preserved, and
   * `markFailed` pauses whatever is queued behind a failure so a failure
   * cannot be overtaken either.
   */
  claimNext(chatId: string): HeldMessage | undefined {
    const items = read(chatId, true);
    if (items.some((m) => m.state === "delivering")) return undefined;
    const next = items.find((m) => m.state === "queued");
    if (!next) return undefined;
    next.state = "delivering";
    write(chatId, items);
    return next;
  }

  /**
   * A delivery that could not start: the item goes back to the user as
   * `failed`, and everything still queued behind it is paused — the next one
   * would otherwise sit "queued" on an idle chat with nothing to wake it.
   */
  markFailed(chatId: string, id: string, reason: string): void {
    const items = read(chatId, true);
    const item = items.find((m) => m.id === id);
    if (!item) return;
    item.state = "failed";
    item.reason = reason;
    for (const other of items) {
      if (other.state !== "queued") continue;
      other.state = "paused";
      other.reason = PAUSE_REASON_BLOCKED;
    }
    write(chatId, items);
  }

  /** Remove an item whose turn has started. */
  removeDelivered(chatId: string, id: string): void {
    const items = read(chatId, true);
    const next = items.filter((m) => m.id !== id);
    if (next.length !== items.length) write(chatId, next);
  }

  /** Remove one item (the user's Remove). Refused while it is `delivering`. */
  remove(chatId: string, id: string): TakeResult {
    return this.take(chatId, id);
  }

  /** Drop the chat's whole list (chat deleted). */
  deleteAll(chatId: string): void {
    if (!isValidHeldChatId(chatId)) return;
    write(chatId, []);
  }

  /**
   * At startup: the runs these were waiting on died with the old process, so
   * sending them unprompted now would surprise the user. Everything `queued`
   * or `delivering` becomes `paused` ("the daemon restarted"). Returns the
   * number of items paused.
   */
  pauseAllOnBoot(): number {
    if (!existsSync(heldDir)) return 0;
    let paused = 0;
    for (const file of readdirSync(heldDir)) {
      if (!file.endsWith(".json")) continue;
      const chatId = file.slice(0, -".json".length);
      if (!isValidHeldChatId(chatId)) continue;
      let items: HeldMessage[];
      try {
        items = read(chatId, true);
      } catch {
        continue; // logged by read(); left for the next boot
      }
      let changed = false;
      for (const item of items) {
        if (item.state !== "queued" && item.state !== "delivering") continue;
        item.state = "paused";
        item.reason = PAUSE_REASON_RESTARTED;
        changed = true;
        paused++;
      }
      if (changed) write(chatId, items);
    }
    return paused;
  }
}

export const heldMessageService = new HeldMessageService();
