/**
 * Session Completion Callbacks ("phone home") — durable store.
 *
 * When a session spawns a child session with `onComplete` enabled, we persist a
 * pending callback here. A global completion handler (session-completion-handler.ts)
 * subscribes to the session registry and, when the child session reaches any
 * terminal state, re-invokes the parent chat with a lightweight notification.
 *
 * The store is global (not per-agent) because the spawning tool
 * (`start_chat_session`) is a platform tool available to non-agent sessions too.
 * It is persisted to disk so pending callbacks survive a backend restart — the
 * parent's turn has typically long ended by the time the child finishes.
 *
 * File: ~/.callboard/session-callbacks.json
 *   {
 *     "callbacks": PendingCallback[],
 *     "chatDepths": { [chatId]: number }   // callback-chain depth a chat was re-invoked at
 *   }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("session-callbacks");

const STORE_PATH = join(DATA_DIR, "session-callbacks.json");

/** Loop-safety defaults (overridable via AgentSettings). */
export const DEFAULT_MAX_CALLBACK_CHAIN_DEPTH = 10;
export const DEFAULT_MAX_PENDING_CALLBACKS = 25;

export interface PendingCallback {
  /** Stable id for this callback registration. */
  id: string;
  /** The spawned child session whose completion we are waiting on. */
  childChatId: string;
  /** The chat to re-invoke (notify) when the child completes. */
  parentChatId: string;
  /**
   * If the parent was an agent session, its alias — used to spawn a fresh agent
   * chat if the original parent chat has since been deleted.
   */
  parentAgentAlias?: string;
  /** Callback-chain depth of this registration (parent depth + 1). */
  depth: number;
  /** Unix ms timestamp of registration. */
  createdAt: number;
  /**
   * "waiting"  — child session is still running.
   * "ready"    — child has completed; awaiting delivery (parent may be busy).
   */
  status: "waiting" | "ready";
}

interface CallbackStore {
  callbacks: PendingCallback[];
  chatDepths: Record<string, number>;
}

function emptyStore(): CallbackStore {
  return { callbacks: [], chatDepths: {} };
}

function readStore(): CallbackStore {
  if (!existsSync(STORE_PATH)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<CallbackStore>;
    return {
      callbacks: Array.isArray(parsed.callbacks) ? parsed.callbacks : [],
      chatDepths: parsed.chatDepths && typeof parsed.chatDepths === "object" ? parsed.chatDepths : {},
    };
  } catch (err: any) {
    log.error(`Failed to read session-callbacks store: ${err.message}`);
    return emptyStore();
  }
}

function writeStore(store: CallbackStore): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ── Callback CRUD ───────────────────────────────────────────────────

export interface AddCallbackInput {
  childChatId: string;
  parentChatId: string;
  parentAgentAlias?: string;
  depth: number;
}

export function addCallback(input: AddCallbackInput): PendingCallback {
  const store = readStore();
  const cb: PendingCallback = {
    id: randomUUID(),
    childChatId: input.childChatId,
    parentChatId: input.parentChatId,
    ...(input.parentAgentAlias ? { parentAgentAlias: input.parentAgentAlias } : {}),
    depth: input.depth,
    createdAt: Date.now(),
    status: "waiting",
  };
  store.callbacks.push(cb);
  writeStore(store);
  return cb;
}

/** Count of registrations not yet delivered (waiting + ready). */
export function countPending(): number {
  return readStore().callbacks.length;
}

/** Mark every callback waiting on `childChatId` as ready for delivery. Returns affected callbacks. */
export function markChildComplete(childChatId: string): PendingCallback[] {
  const store = readStore();
  const affected: PendingCallback[] = [];
  for (const cb of store.callbacks) {
    if (cb.childChatId === childChatId && cb.status === "waiting") {
      cb.status = "ready";
      affected.push(cb);
    }
  }
  if (affected.length) writeStore(store);
  return affected;
}

/** All "ready" callbacks targeting the given parent chat. */
export function getReadyForParent(parentChatId: string): PendingCallback[] {
  return readStore().callbacks.filter((cb) => cb.parentChatId === parentChatId && cb.status === "ready");
}

/** Remove callbacks by id. */
export function removeCallbacks(ids: string[]): void {
  if (!ids.length) return;
  const store = readStore();
  const idSet = new Set(ids);
  const before = store.callbacks.length;
  store.callbacks = store.callbacks.filter((cb) => !idSet.has(cb.id));
  if (store.callbacks.length !== before) writeStore(store);
}

/** Distinct parent chat ids that currently have at least one "ready" callback. */
export function parentsWithReadyCallbacks(): string[] {
  const seen = new Set<string>();
  for (const cb of readStore().callbacks) {
    if (cb.status === "ready") seen.add(cb.parentChatId);
  }
  return [...seen];
}

// ── Chat-depth tracking (for chain-depth enforcement) ───────────────

/** Depth at which a chat was (re-)invoked via a callback. Defaults to 0 (root). */
export function getChatDepth(chatId: string): number {
  return readStore().chatDepths[chatId] ?? 0;
}

export function setChatDepth(chatId: string, depth: number): void {
  const store = readStore();
  if (store.chatDepths[chatId] === depth) return;
  store.chatDepths[chatId] = depth;
  writeStore(store);
}

export function clearChatDepth(chatId: string): void {
  const store = readStore();
  if (!(chatId in store.chatDepths)) return;
  delete store.chatDepths[chatId];
  writeStore(store);
}
