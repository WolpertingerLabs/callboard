/**
 * `wait_for_events` — a long-poll over every ingestor stream a caller owns.
 *
 * Replaces the `ingestor_status` + N×`poll_events` cycle a watcher otherwise
 * runs every few seconds: one request returns as soon as any of the caller's
 * streams has something past its cursor, or holds until one does (or the
 * timeout fires). A held wait costs one request against the per-session rate
 * limit, however long it holds.
 *
 * Stream key = `${connection}:${instanceId}`, with the manager's `_default`
 * sentinel for single-instance connections. Event ids are epoch-based per
 * ingestor instance, so each instance needs its own cursor — a cursor shared
 * across instances would skip events.
 *
 * Holding a request open is a resource, so it is capped: MAX_WAITS_PER_SESSION
 * concurrent holds per session, MAX_WAITS_PER_CALLER per caller (so one caller
 * opening many sessions cannot starve the rest), and MAX_WAITS_TOTAL hub-wide.
 * Over a cap the call fails immediately instead of queueing.
 *
 * Held requests would also keep `server.close()` waiting on shutdown, so the
 * daemon calls releaseAllWaits() first: every hold is answered `timedOut: true`,
 * and until resumeWaits() a new wait with nothing buffered fails with
 * "server shutting down" instead of holding.
 */

import type { IngestedEvent } from './ingestors/types.js';
import type { ToolContext } from './tool-dispatch.js';

// ── Limits ─────────────────────────────────────────────────────────────────

export const WAIT_DEFAULT_TIMEOUT_MS = 25_000;
export const WAIT_MAX_TIMEOUT_MS = 55_000;
export const MAX_WAITS_PER_SESSION = 2;
export const MAX_WAITS_PER_CALLER = 8;
export const MAX_WAITS_TOTAL = 64;

/**
 * Resolve the hold duration: default 25s, clamped to [0, 55000].
 *
 * When the local proxy advertised an outbound budget (how long its own socket
 * will actually wait), the hold is clamped to that too, so a wait always
 * answers before the client gives up on it. Absent or malformed budget means
 * no clamp, matching applyOutboundBudget.
 */
export function clampWaitTimeout(requested: unknown, budgetMs?: unknown): number {
  let timeout: number;
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    timeout = WAIT_DEFAULT_TIMEOUT_MS;
  } else {
    timeout = Math.min(Math.max(requested, 0), WAIT_MAX_TIMEOUT_MS);
  }
  if (typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs > 0) {
    timeout = Math.min(timeout, budgetMs);
  }
  return timeout;
}

// ── Hold accounting ────────────────────────────────────────────────────────

const holdsBySession = new Map<string, number>();
const holdsByCaller = new Map<string, number>();
let totalHolds = 0;

/** Answer-now callbacks for every held wait, used by releaseAllWaits(). */
const activeReleasers = new Set<() => void>();

/** While true, new waits with nothing to return are rejected (shutdown). */
let draining = false;

/** Number of waits currently holding, hub-wide. */
export function activeWaitCount(): number {
  return totalHolds;
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function acquireHold(sessionKey: string, callerAlias: string): void {
  if (
    (holdsBySession.get(sessionKey) ?? 0) >= MAX_WAITS_PER_SESSION ||
    (holdsByCaller.get(callerAlias) ?? 0) >= MAX_WAITS_PER_CALLER ||
    totalHolds >= MAX_WAITS_TOTAL
  ) {
    throw new Error('too many concurrent waits');
  }
  bump(holdsBySession, sessionKey, 1);
  bump(holdsByCaller, callerAlias, 1);
  totalHolds++;
}

function releaseHold(sessionKey: string, callerAlias: string): void {
  bump(holdsBySession, sessionKey, -1);
  bump(holdsByCaller, callerAlias, -1);
  totalHolds--;
}

/**
 * Answer every held wait now, as if its timeout had fired, and start
 * draining. Called on shutdown before `server.close()`: otherwise a held wait
 * keeps its request open past the forced-exit timer.
 *
 * While draining, a new wait still receives events already buffered past its
 * cursor (the buffers do not survive the restart), but one that would hold or
 * answer empty fails with "server shutting down". Answering it `timedOut: true`
 * instead would make a watcher that re-issues on success spin through its
 * whole rate limit against the dying process; a tool error sends it into
 * backoff, and its next attempt reaches the new process. The message must not
 * look like "Unknown tool", which clients read as "fall back to polling".
 *
 * Returns the number of waits released.
 */
export function releaseAllWaits(): number {
  draining = true;
  const releasers = [...activeReleasers];
  for (const release of releasers) release();
  return releasers.length;
}

/** Stop draining after releaseAllWaits(). createApp() calls this, so a host
 *  that shuts down and builds a new app in-process is not left draining. */
export function resumeWaits(): void {
  draining = false;
}

// ── Wire types ─────────────────────────────────────────────────────────────

export interface WaitForEventsStream {
  connection: string;
  instanceId: string;
  events: IngestedEvent[];
  /** Highest event id returned, or the input cursor when none were. */
  cursor: number;
}

export interface WaitForEventsResult {
  /** Every active stream for the caller, including ones with no new events. */
  streams: Record<string, WaitForEventsStream>;
  /** Cursor keys that named no active stream for this caller. */
  unknownStreams: string[];
  timedOut: boolean;
}

// ── Implementation ─────────────────────────────────────────────────────────

function parseCursors(raw: unknown): Record<string, number> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('cursors must be an object mapping stream keys to numeric event ids');
  }
  const cursors: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`cursors["${key}"] must be a number`);
    }
    cursors[key] = value;
  }
  return cursors;
}

/** Snapshot every stream of the caller against the cursors. */
function collect(
  context: ToolContext,
  cursors: Record<string, number>,
): { result: WaitForEventsResult; hasEvents: boolean } {
  const streams: Record<string, WaitForEventsStream> = {};
  let hasEvents = false;

  for (const s of context.ingestorManager.getStreams(context.callerAlias)) {
    const key = `${s.connection}:${s.instanceId}`;
    const after = Object.hasOwn(cursors, key) ? cursors[key] : -1;
    const events = s.ingestor.getEvents(after);
    let cursor = after;
    for (const e of events) if (e.id > cursor) cursor = e.id;
    if (events.length > 0) hasEvents = true;
    streams[key] = { connection: s.connection, instanceId: s.instanceId, events, cursor };
  }

  const unknownStreams = Object.keys(cursors).filter((k) => !Object.hasOwn(streams, k));
  return { result: { streams, unknownStreams, timedOut: false }, hasEvents };
}

/**
 * Run one `wait_for_events` call. `context.signal` aborts a hold (the remote
 * server wires it to the HTTP request closing); `context.sessionId` scopes the
 * per-session cap.
 */
export function waitForEvents(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<WaitForEventsResult> {
  const cursors = parseCursors(input.cursors);
  const timeoutMs = clampWaitTimeout(input.timeout_ms, context.outboundBudgetMs);
  const { signal } = context;

  const first = collect(context, cursors);
  if (first.hasEvents) return Promise.resolve(first.result);
  if (draining) return Promise.reject(new Error('server shutting down'));
  if (timeoutMs === 0) return Promise.resolve({ ...first.result, timedOut: true });
  if (signal?.aborted) return Promise.reject(new Error('wait aborted: client disconnected'));

  // The admin API has no session; key it by caller so it is still capped.
  const sessionKey = context.sessionId ?? `caller:${context.callerAlias}`;
  const { callerAlias } = context;
  acquireHold(sessionKey, callerAlias);

  const mgr = context.ingestorManager;

  return new Promise<WaitForEventsResult>((resolve, reject) => {
    let done = false;

    const finish = (outcome: () => WaitForEventsResult | Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      mgr.offEvent(onEvent);
      signal?.removeEventListener('abort', onAbort);
      activeReleasers.delete(answerTimedOut);
      releaseHold(sessionKey, callerAlias);
      let value: WaitForEventsResult | Error;
      try {
        value = outcome();
      } catch (err) {
        value = err instanceof Error ? err : new Error(String(err));
      }
      if (value instanceof Error) reject(value);
      else resolve(value);
    };

    // Collection is synchronous and the listener is registered in the same
    // tick as the first check, so no event can slip between the two.
    function onEvent(event: IngestedEvent): void {
      if (event.callerAlias !== callerAlias) return;
      // A wake whose stream has nothing past its cursor (cursor ahead of the
      // buffer) keeps holding rather than answering empty.
      let next: ReturnType<typeof collect>;
      try {
        next = collect(context, cursors);
      } catch (err) {
        finish(() => (err instanceof Error ? err : new Error(String(err))));
        return;
      }
      if (next.hasEvents) finish(() => next.result);
    }

    function onAbort(): void {
      finish(() => new Error('wait aborted: client disconnected'));
    }

    function answerTimedOut(): void {
      finish(() => {
        const last = collect(context, cursors);
        return last.hasEvents ? last.result : { ...last.result, timedOut: true };
      });
    }

    const timer = setTimeout(answerTimedOut, timeoutMs);

    activeReleasers.add(answerTimedOut);
    mgr.onEvent(onEvent);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
