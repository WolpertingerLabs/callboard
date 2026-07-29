/**
 * Session Completion Callbacks ("phone home") — durable store.
 *
 * When a session spawns a child session with `onComplete` enabled, we persist a
 * pending callback here. A global completion handler (session-completion-handler.ts)
 * subscribes to the session registry and, when the child session reaches any
 * terminal state, re-invokes the parent chat with a lightweight notification.
 *
 * The store is global (not per-agent) because the registering tools
 * (`start_chat_session`, `continue_chat`) are platform tools available to
 * non-agent sessions too.
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
import { getAgentSettings } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("session-callbacks");

const STORE_PATH = join(DATA_DIR, "session-callbacks.json");

/** Loop-safety defaults (overridable via AgentSettings). */
export const DEFAULT_MAX_CALLBACK_CHAIN_DEPTH = 10;
export const DEFAULT_MAX_PENDING_CALLBACKS = 25;

/**
 * How the parent came to be waiting on the child — only affects the wording of
 * the notification. Absent on records written before the field existed; treat
 * `undefined` as "spawned".
 */
export type CallbackKind = "spawned" | "continued";

export interface PendingCallback {
  /** Stable id for this callback registration. */
  id: string;
  /** The child session whose completion we are waiting on. */
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
  /** Whether the parent spawned the child or sent it a follow-up. */
  kind?: CallbackKind;
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
  kind?: CallbackKind;
}

export function addCallback(input: AddCallbackInput): PendingCallback {
  const store = readStore();
  const cb: PendingCallback = {
    id: randomUUID(),
    childChatId: input.childChatId,
    parentChatId: input.parentChatId,
    ...(input.parentAgentAlias ? { parentAgentAlias: input.parentAgentAlias } : {}),
    depth: input.depth,
    ...(input.kind ? { kind: input.kind } : {}),
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

// ── Guarded registration ────────────────────────────────────────────

export interface RegisterCallbackInput {
  childChatId: string;
  /** The chat to notify. Undefined when the caller has no chat context. */
  parentChatId?: string;
  parentAgentAlias?: string;
  kind: CallbackKind;
}

export interface CallbackRegistration {
  registered: boolean;
  /** Store id of the registration — pass to `removeCallbacks` to roll it back. */
  id?: string;
  /** Human-readable outcome, surfaced to the calling model in the tool result. */
  note?: string;
}

/**
 * Register a phone-home callback, applying the loop-safety limits. Shared by
 * every tool that offers `onComplete` so the two paths cannot drift on how
 * depth and pending counts are enforced.
 *
 * Never throws and never blocks the caller's real work: when a limit is hit the
 * callback is skipped and the reason is returned for the tool to report.
 */
export function registerCompletionCallback(input: RegisterCallbackInput): CallbackRegistration {
  const { childChatId, parentChatId, parentAgentAlias, kind } = input;

  if (!parentChatId) {
    return { registered: false, note: "No parent chat context available — cannot register completion callback." };
  }

  const settings = getAgentSettings();
  const maxDepth = settings.maxCallbackChainDepth ?? DEFAULT_MAX_CALLBACK_CHAIN_DEPTH;
  const maxPending = settings.maxPendingCallbacks ?? DEFAULT_MAX_PENDING_CALLBACKS;
  const depth = getChatDepth(parentChatId) + 1;
  // "The session was started" / "The message was sent" — the work itself always
  // goes ahead; only the notification is dropped.
  const sent = kind === "spawned" ? "The session was started" : "The message was sent";

  if (depth > maxDepth) {
    log.warn(`callback depth ${depth} exceeds limit ${maxDepth} for parent ${parentChatId} — skipping callback`);
    return {
      registered: false,
      note: `Callback chain depth limit reached (${maxDepth}). ${sent}, but it will not phone home to avoid runaway loops.`,
    };
  }

  if (countPending() >= maxPending) {
    log.warn(`pending callbacks at limit ${maxPending} — skipping callback for parent ${parentChatId}`);
    return {
      registered: false,
      note: `Pending callback limit reached (${maxPending}). ${sent}, but it will not phone home until existing callbacks drain.`,
    };
  }

  const cb = addCallback({ childChatId, parentChatId, ...(parentAgentAlias ? { parentAgentAlias } : {}), depth, kind });
  log.info(`Registered on-complete callback (${kind}): child ${childChatId} → parent ${parentChatId} (depth ${depth})`);
  return {
    registered: true,
    id: cb.id,
    note: `This chat will be notified automatically when session ${childChatId} completes.`,
  };
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
