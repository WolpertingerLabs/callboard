/**
 * Chat activity registry — what each chat is currently blocked on.
 *
 * Deliberately shaped like the `pendingRequests` map in `claude.ts`, and for
 * the same reason: an in-flight operation needs a resolver that an HTTP route
 * can reach. A pending permission holds `resolve` so `/respond` can answer it;
 * an interruptible `wait` holds `release` so `/activity/:id/release` can cut it
 * short. Same problem, same shape, same lifetime — in-memory only, because an
 * activity cannot outlive the process that is awaiting it.
 *
 * ## Lifecycle — why this module has no listeners
 *
 * It would be natural to subscribe to `sessionRegistry` and clear a chat's
 * activities on `session_stopped`. That is a trap: `migrate()` emits
 * `session_stopped` for the *old* id as part of promoting a temp tracking id
 * to a real chat id, so a naive listener wipes the activities of a session
 * that is very much still running.
 *
 * Instead the owner of the session lifecycle drives this explicitly.
 * `claude.ts` already calls `pendingRequests.delete(...)` at every point a
 * session ends and migrates the map when a tracking id is promoted; the calls
 * into this module sit beside those, at the same lines, for the same reasons.
 * If you are adding a new session teardown path, clear activities there too.
 */
import { randomUUID } from "crypto";
import type { ActivityKind, ActivityCondition, ChatActivity, ConditionWatch } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-activity");

/**
 * How many `wait` cycles one condition gets before the tool refuses to sleep
 * again. A polling loop that has not converged in this many attempts is not
 * going to; the agent is told to stop and summon the user instead. Distinct
 * from `maxNudges`, which bounds re-prompts at stream end — the two failure
 * modes are unrelated and must not share a budget.
 */
export const MAX_CONDITION_ATTEMPTS = 20;

/** What a caller supplies to open an activity; the rest is minted here. */
export interface ActivitySpec {
  kind: ActivityKind;
  label: string;
  detail?: string;
  expiresAt?: number;
  interruptible: boolean;
  childChatId?: string;
  condition?: ActivityCondition;
}

/**
 * The stored record. `release` is the half that must never cross the wire —
 * {@link listActivities} strips it, exactly as `getPendingRequest` strips
 * `resolve`.
 */
interface ActivityRecord extends ChatActivity {
  release?: (reason: string) => void;
}

/** activityId → record. */
const activities = new Map<string, ActivityRecord>();
/** chatId → open condition watch. One condition per chat at a time. */
const watches = new Map<string, ConditionWatch>();

/** Strip the resolver, leaving the wire-safe shape. */
function publicView(record: ActivityRecord): ChatActivity {
  const { release: _release, ...rest } = record;
  return rest;
}

/**
 * Open an activity. `release` is only stored when the activity is
 * interruptible — an activity nobody may end early has no use for it, and
 * holding one would make {@link releaseActivity}'s refusal a lie.
 */
export function startActivity(chatId: string, spec: ActivitySpec, release?: (reason: string) => void): ChatActivity {
  const record: ActivityRecord = {
    id: randomUUID(),
    chatId,
    kind: spec.kind,
    label: spec.label,
    ...(spec.detail !== undefined && { detail: spec.detail }),
    startedAt: Date.now(),
    ...(spec.expiresAt !== undefined && { expiresAt: spec.expiresAt }),
    interruptible: spec.interruptible,
    ...(spec.childChatId !== undefined && { childChatId: spec.childChatId }),
    ...(spec.condition !== undefined && { condition: spec.condition }),
    ...(spec.interruptible && release && { release }),
  };
  activities.set(record.id, record);
  log.debug(`Activity started: ${record.kind} on ${chatId} (${record.id})`);
  return publicView(record);
}

/** Close an activity. Safe to call twice — the second call is a no-op. */
export function endActivity(activityId: string): void {
  if (activities.delete(activityId)) log.debug(`Activity ended: ${activityId}`);
}

/** Every open activity for a chat, oldest first. Never leaks `release`. */
export function listActivities(chatId: string): ChatActivity[] {
  const out: ChatActivity[] = [];
  for (const record of activities.values()) {
    if (record.chatId === chatId) out.push(publicView(record));
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** One activity by id, or undefined. Never leaks `release`. */
export function getActivity(activityId: string): ChatActivity | undefined {
  const record = activities.get(activityId);
  return record ? publicView(record) : undefined;
}

export type ReleaseOutcome = { ok: true; kind: ActivityKind } | { ok: false; reason: "not_found" | "not_interruptible" };

/**
 * End an interruptible activity early on the user's behalf.
 *
 * Refuses anything not marked interruptible. Today that is everything except
 * `wait`: the other kinds are the agent awaiting work it delegated, and
 * releasing one would return the caller an empty result while the delegate
 * kept running.
 *
 * The chatId is checked as well as the activity id so a release cannot be
 * aimed at another chat's timer by guessing an id.
 */
export function releaseActivity(chatId: string, activityId: string, reason: string): ReleaseOutcome {
  const record = activities.get(activityId);
  if (!record || record.chatId !== chatId) return { ok: false, reason: "not_found" };
  if (!record.interruptible || !record.release) return { ok: false, reason: "not_interruptible" };

  const { release, kind } = record;
  activities.delete(activityId);
  log.info(`Activity ${activityId} (${kind}) on ${chatId} released early: ${reason}`);
  release(reason);
  return { ok: true, kind };
}

/**
 * Run `fn` with an activity open, closing it however `fn` settles.
 *
 * The `finally` is the point: a tool that throws must not leave a phantom
 * countdown running in the UI forever.
 */
export async function withActivity<T>(chatId: string, spec: ActivitySpec, fn: (activity: ChatActivity) => Promise<T>): Promise<T> {
  const activity = startActivity(chatId, spec);
  try {
    return await fn(activity);
  } finally {
    endActivity(activity.id);
  }
}

/**
 * Re-key a chat's activities and watch when a temp tracking id is promoted to
 * a real chat id. Called beside the equivalent `pendingRequests` migration in
 * `claude.ts` — without it, an activity opened under `new-<ts>` becomes
 * unreachable by the route the UI calls.
 */
export function migrateActivities(oldId: string, newId: string): void {
  let moved = 0;
  for (const record of activities.values()) {
    if (record.chatId === oldId) {
      record.chatId = newId;
      moved++;
    }
  }
  const watch = watches.get(oldId);
  if (watch) {
    watches.delete(oldId);
    watches.set(newId, { ...watch, chatId: newId });
  }
  if (moved || watch) log.debug(`Migrated ${moved} activity(ies)${watch ? " and a condition watch" : ""}: ${oldId} → ${newId}`);
}

/** Drop everything for a chat. Called from every session teardown path. */
export function clearActivitiesForChat(chatId: string): void {
  for (const [id, record] of activities) {
    if (record.chatId === chatId) activities.delete(id);
  }
  watches.delete(chatId);
}

// ─── Condition watches ──────────────────────────────────────────────

/**
 * Open a watch, or count another attempt against the existing one.
 *
 * Matching is on the condition text: the same text is the same poll continuing
 * (attempt N+1), different text is a new thing to wait for and supersedes the
 * old watch. A chat polls for one condition at a time — an agent juggling two
 * external conditions can describe both in one string.
 *
 * Returns the watch with `attempts` already incremented, so a caller comparing
 * against {@link MAX_CONDITION_ATTEMPTS} is reading the attempt it is about to
 * spend, not the one before it.
 */
export function openOrContinueWatch(chatId: string, text: string, maxAttempts: number = MAX_CONDITION_ATTEMPTS): ConditionWatch {
  const now = Date.now();
  const existing = watches.get(chatId);

  if (existing && existing.text === text) {
    // An exhausted watch is returned as-is: no further attempts are granted,
    // and the count stays put so the refusal can report the real total.
    if (existing.exhausted) return existing;
    const updated: ConditionWatch = { ...existing, attempts: existing.attempts + 1, lastCheckedAt: now };
    watches.set(chatId, updated);
    return updated;
  }

  const fresh: ConditionWatch = {
    id: randomUUID(),
    chatId,
    text,
    attempts: 1,
    maxAttempts,
    firstStartedAt: now,
    lastCheckedAt: now,
  };
  watches.set(chatId, fresh);
  log.debug(`Condition watch opened on ${chatId}: "${text}"`);
  return fresh;
}

export function getWatch(chatId: string): ConditionWatch | undefined {
  return watches.get(chatId);
}

/**
 * Whether this chat owes an answer on a condition.
 *
 * An exhausted watch is deliberately NOT open: it is retained only to deny a
 * fresh budget to the same condition, and nudging about something the agent
 * has already been told to stop polling would be a loop of its own.
 */
export function hasOpenConditionWatch(chatId: string): boolean {
  const watch = watches.get(chatId);
  return watch !== undefined && !watch.exhausted;
}

/**
 * Spend the last attempt: mark the watch exhausted, keeping the record.
 *
 * Deleting it instead would let the agent re-open the identical condition and
 * receive a full budget again — the failure mode the cap exists to prevent.
 */
export function exhaustWatch(chatId: string): ConditionWatch | undefined {
  const watch = watches.get(chatId);
  if (!watch) return undefined;
  // Clamp: the attempt that tripped the cap was refused, not spent, so
  // reporting it would overstate how many times the condition was polled —
  // and would keep climbing on every subsequent refusal.
  const updated: ConditionWatch = { ...watch, attempts: Math.min(watch.attempts, watch.maxAttempts), exhausted: true };
  watches.set(chatId, updated);
  log.warn(`Condition watch on ${chatId} exhausted after ${updated.attempts} attempt(s): "${watch.text}"`);
  return updated;
}

/**
 * Close a watch. `satisfied: false` is an explicit abandonment (the agent gave
 * up, or the cap was hit) rather than a failure to close — either way the UI
 * stops showing it. Returns the watch that was closed, or undefined if there
 * was none.
 */
export function closeWatch(chatId: string, satisfied: boolean): ConditionWatch | undefined {
  const watch = watches.get(chatId);
  if (!watch) return undefined;
  watches.delete(chatId);
  log.info(`Condition watch on ${chatId} closed after ${watch.attempts} attempt(s): ${satisfied ? "satisfied" : "abandoned"}`);
  return watch;
}

/** Test seam — drops all state. */
export function __resetActivityState(): void {
  activities.clear();
  watches.clear();
}
