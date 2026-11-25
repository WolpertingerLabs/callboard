/**
 * Unit tests for the `wait_for_events` long-poll tool.
 *
 * Drives the real tool handler against a real IngestorManager whose ingestors
 * come from a test-only factory, so stream discovery, caller scoping, and the
 * manager's event fan-out are all exercised rather than mocked.
 */
import { getEventListeners } from 'node:events';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

import type { RemoteServerConfig } from '../shared/config.js';
import { BaseIngestor } from './ingestors/base-ingestor.js';
import { IngestorManager } from './ingestors/manager.js';
import { registerIngestorFactory } from './ingestors/registry.js';
import { toolHandlers, type ToolContext } from './tool-dispatch.js';
import {
  activeWaitCount,
  clampWaitTimeout,
  MAX_WAITS_PER_CALLER,
  MAX_WAITS_PER_SESSION,
  MAX_WAITS_TOTAL,
  releaseAllWaits,
  resumeWaits,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_MAX_TIMEOUT_MS,
  type WaitForEventsResult,
} from './wait-for-events.js';

// ── Fake ingestor ──────────────────────────────────────────────────────────

class FakeIngestor extends BaseIngestor {
  start(): Promise<void> {
    this.state = 'connected';
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.state = 'stopped';
    return Promise.resolve();
  }
  push(eventType: string, data: unknown = {}): void {
    this.pushEvent(eventType, data);
  }
  get instance(): string | undefined {
    return this.instanceId;
  }
  get connection(): string {
    return this.connectionAlias;
  }
}

const fakes: FakeIngestor[] = [];

beforeAll(() => {
  registerIngestorFactory(
    'websocket:wfe-fake',
    (connectionAlias, _config, secrets, bufferSize, instanceId) => {
      const fake = new FakeIngestor(connectionAlias, 'websocket', secrets, bufferSize, instanceId);
      fakes.push(fake);
      return fake;
    },
  );
});

/** Find the live fake for a caller's connection instance (`_default` = single-instance).
 *  The most recent match wins, so a restarted instance resolves to its replacement. */
function fake(caller: string, connection: string, instanceId = '_default'): FakeIngestor {
  for (let i = fakes.length - 1; i >= 0; i--) {
    const f = fakes[i];
    if (
      f.callerAlias === caller &&
      f.connection === connection &&
      (f.instance ?? '_default') === instanceId
    ) {
      return f;
    }
  }
  throw new Error(`no fake for ${caller}:${connection}:${instanceId}`);
}

const fakeIngestor = {
  type: 'websocket' as const,
  websocket: { gatewayUrl: 'wss://fake.invalid', protocol: 'wfe-fake' },
};

function makeConfig(): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    connectors: [
      { alias: 'chat', allowedEndpoints: [], ingestor: fakeIngestor },
      { alias: 'boards', allowedEndpoints: [], ingestor: fakeIngestor },
    ],
    callers: {
      alice: {
        connections: ['chat', 'boards'],
        listenerInstances: {
          boards: { b1: { params: {} }, b2: { params: {} } },
        },
      },
      bob: { connections: ['chat'] },
    },
    rateLimitPerMinute: 240,
  };
}

async function makeManager(): Promise<IngestorManager> {
  fakes.length = 0;
  const mgr = new IngestorManager(makeConfig());
  await mgr.startAll();
  return mgr;
}

function ctx(
  mgr: IngestorManager,
  callerAlias = 'alice',
  extra: Partial<ToolContext> = {},
): ToolContext {
  return {
    callerAlias,
    ingestorManager: mgr,
    refreshRoutes: () => undefined,
    sessionId: `session-${callerAlias}`,
    ...extra,
  };
}

async function wait(
  context: ToolContext,
  input: Record<string, unknown> = {},
): Promise<WaitForEventsResult> {
  return (await toolHandlers.wait_for_events(input, [], context)) as WaitForEventsResult;
}

/** Cursors that mark everything currently buffered as seen. */
function seenAll(mgr: IngestorManager, caller = 'alice'): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const s of mgr.getStreams(caller)) {
    const events = s.ingestor.getEvents();
    cursors[`${s.connection}:${s.instanceId}`] = events.length ? events[events.length - 1].id : -1;
  }
  return cursors;
}

/** Let pending promise callbacks run without advancing fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
  // Start every test from zero holds and not draining, so one failing test
  // that leaves a wait parked cannot cascade into unrelated ones.
  releaseAllWaits();
  resumeWaits();
  vi.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('wait_for_events', () => {
  it('returns immediately when a stream already has events past its cursor', async () => {
    const mgr = await makeManager();
    fake('alice', 'chat').push('MESSAGE_CREATE', { n: 1 });

    const result = await wait(ctx(mgr), { cursors: {}, timeout_ms: 30_000 });

    expect(result.timedOut).toBe(false);
    expect(result.streams['chat:_default'].events).toHaveLength(1);
    expect(result.streams['chat:_default'].cursor).toBe(
      result.streams['chat:_default'].events[0].id,
    );
    expect(activeWaitCount()).toBe(0);
  });

  it('lists every active stream for the caller, including empty ones', async () => {
    const mgr = await makeManager();
    const result = await wait(ctx(mgr), { timeout_ms: 0 });

    expect(Object.keys(result.streams).sort()).toEqual(['boards:b1', 'boards:b2', 'chat:_default']);
    expect(result.streams['boards:b1']).toEqual({
      connection: 'boards',
      instanceId: 'b1',
      events: [],
      cursor: -1,
    });
    expect(result.unknownStreams).toEqual([]);
  });

  it('echoes the input cursor for a stream with no new events', async () => {
    const mgr = await makeManager();
    fake('alice', 'chat').push('a');
    const cursors = seenAll(mgr);

    const result = await wait(ctx(mgr), { cursors, timeout_ms: 0 });

    expect(result.streams['chat:_default'].events).toEqual([]);
    expect(result.streams['chat:_default'].cursor).toBe(cursors['chat:_default']);
  });

  it('holds, then wakes on a new event for one of the caller’s streams', async () => {
    vi.useFakeTimers();
    const mgr = await makeManager();
    let settled = false;
    const pending = wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 20_000 }).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    expect(activeWaitCount()).toBe(1);

    fake('alice', 'boards', 'b2').push('updateCard', { id: 7 });
    const result = await pending;

    expect(result.timedOut).toBe(false);
    expect(result.streams['boards:b2'].events.map((e) => e.data)).toEqual([{ id: 7 }]);
    expect(result.streams['boards:b1'].events).toEqual([]);
    expect(result.streams['chat:_default'].events).toEqual([]);
    expect(activeWaitCount()).toBe(0);
    expect(mgr.eventListenerCount).toBe(0);
  });

  it('sees an event emitted synchronously right after the call', async () => {
    // Pins that the subscription happens in the same tick as the first check:
    // an `async` refactor that subscribes after a yield would lose this event.
    vi.useFakeTimers();
    const mgr = await makeManager();
    const pending = wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 1_000 });
    fake('alice', 'chat').push('sync');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(true);
    expect((await pending).timedOut).toBe(false);
  });

  it('wakes on the replacement after an ingestor is restarted mid-wait', async () => {
    vi.useFakeTimers();
    const mgr = await makeManager();
    const old = fake('alice', 'chat');
    old.push('before-restart');
    const cursors = seenAll(mgr);
    const pending = wait(ctx(mgr), { cursors, timeout_ms: 5_000 });
    await flush();

    await mgr.restartOne('alice', 'chat');
    const replacement = fake('alice', 'chat');
    expect(replacement).not.toBe(old);
    expect(activeWaitCount()).toBe(1); // the restart alone does not answer

    replacement.push('after-restart', { fresh: true });
    const result = await pending;

    expect(result.timedOut).toBe(false);
    // New epoch ids sit above the old cursor, so the stale cursor still works.
    expect(result.streams['chat:_default'].events.map((e) => e.data)).toEqual([{ fresh: true }]);
    expect(result.streams['chat:_default'].cursor).toBeGreaterThan(cursors['chat:_default']);
    expect(mgr.eventListenerCount).toBe(0);
  });

  it('drops a stream stopped mid-wait and still wakes on the others', async () => {
    vi.useFakeTimers();
    const mgr = await makeManager();
    const cursors = seenAll(mgr);
    const pending = wait(ctx(mgr), { cursors, timeout_ms: 5_000 });
    await flush();

    await mgr.stopOne('alice', 'boards', 'b1');
    expect(activeWaitCount()).toBe(1);
    fake('alice', 'boards', 'b2').push('still-here');
    const result = await pending;

    expect(result.timedOut).toBe(false);
    expect(result.streams).not.toHaveProperty('boards:b1');
    expect(result.unknownStreams).toEqual(['boards:b1']);
    expect(result.streams['boards:b2'].events).toHaveLength(1);
  });

  it('returns empty with timedOut:true when nothing arrives', async () => {
    vi.useFakeTimers();
    const mgr = await makeManager();
    const pending = wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.timedOut).toBe(true);
    expect(Object.keys(result.streams)).toHaveLength(3);
    for (const s of Object.values(result.streams)) expect(s.events).toEqual([]);
    expect(activeWaitCount()).toBe(0);
    expect(mgr.eventListenerCount).toBe(0);
  });

  it("is not woken by, and does not leak, another caller's events", async () => {
    vi.useFakeTimers();
    const mgr = await makeManager();
    const pending = wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 2_000 });

    fake('bob', 'chat').push('MESSAGE_CREATE', { secret: 'bob-only' });
    await flush();
    expect(activeWaitCount()).toBe(1); // still holding

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(JSON.stringify(result)).not.toContain('bob-only');
  });

  it("never returns another caller's buffered events, even on an immediate return", async () => {
    const mgr = await makeManager();
    fake('bob', 'chat').push('MESSAGE_CREATE', { secret: 'bob-only' });
    fake('alice', 'chat').push('MESSAGE_CREATE', { mine: true });

    const result = await wait(ctx(mgr), { timeout_ms: 0 });

    expect(result.streams['chat:_default'].events.map((e) => e.data)).toEqual([{ mine: true }]);
    expect(JSON.stringify(result)).not.toContain('bob-only');
    const bobResult = await wait(ctx(mgr, 'bob'), { timeout_ms: 0 });
    expect(Object.keys(bobResult.streams)).toEqual(['chat:_default']);
  });

  it('keeps a separate cursor per instance of a multi-instance connection', async () => {
    const mgr = await makeManager();
    // b1 is created first so its epoch (and every id) is below b2's.
    fake('alice', 'boards', 'b1').push('e1');
    fake('alice', 'boards', 'b2').push('e2');
    const b2Id = fake('alice', 'boards', 'b2').getEvents()[0].id;
    const b1Id = fake('alice', 'boards', 'b1').getEvents()[0].id;
    expect(b1Id).toBeLessThan(b2Id);

    // A client that has seen b2 must still get b1's (lower-id) event.
    const result = await wait(ctx(mgr), {
      cursors: { 'boards:b2': b2Id },
      timeout_ms: 0,
    });

    expect(result.streams['boards:b1'].events.map((e) => e.id)).toEqual([b1Id]);
    expect(result.streams['boards:b2'].events).toEqual([]);
    expect(result.streams['boards:b2'].cursor).toBe(b2Id);
  });

  it('reports cursor keys that name no active stream in unknownStreams', async () => {
    const mgr = await makeManager();
    const result = await wait(ctx(mgr), {
      cursors: { 'chat:_default': -1, 'gone:_default': 5, 'boards:b9': 1 },
      timeout_ms: 0,
    });

    expect(result.unknownStreams.sort()).toEqual(['boards:b9', 'gone:_default']);
    expect(result.streams).not.toHaveProperty('gone:_default');
  });

  it("reports another caller's stream key as unknown rather than serving it", async () => {
    const mgr = await makeManager();
    fake('alice', 'boards', 'b1').push('alice-board');

    const result = await wait(ctx(mgr, 'bob'), { cursors: { 'boards:b1': -1 }, timeout_ms: 0 });

    expect(result.unknownStreams).toEqual(['boards:b1']);
    expect(result.streams).not.toHaveProperty('boards:b1');
  });

  it('keeps holding when a woken stream has nothing past its cursor', async () => {
    vi.useFakeTimers();
    const mgr = await makeManager();
    // Cursor far ahead of any real id: the event wakes us but is not "new".
    const pending = wait(ctx(mgr), {
      cursors: { ...seenAll(mgr), 'chat:_default': Number.MAX_SAFE_INTEGER },
      timeout_ms: 3_000,
    });

    fake('alice', 'chat').push('old-news');
    await flush();
    expect(activeWaitCount()).toBe(1);

    fake('alice', 'boards', 'b1').push('fresh');
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.streams['boards:b1'].events).toHaveLength(1);
    expect(result.streams['chat:_default'].events).toEqual([]);
  });

  it('rejects malformed cursors', async () => {
    const mgr = await makeManager();
    await expect(wait(ctx(mgr), { cursors: { 'chat:_default': 'x' } })).rejects.toThrow(/cursors/);
    await expect(wait(ctx(mgr), { cursors: [1, 2] })).rejects.toThrow(/cursors/);
  });

  describe('timeout clamping', () => {
    it('defaults to 25s and clamps to [0, 55000]', () => {
      expect(WAIT_DEFAULT_TIMEOUT_MS).toBe(25_000);
      expect(WAIT_MAX_TIMEOUT_MS).toBe(55_000);
      expect(clampWaitTimeout(undefined)).toBe(25_000);
      expect(clampWaitTimeout('30')).toBe(25_000);
      expect(clampWaitTimeout(NaN)).toBe(25_000);
      expect(clampWaitTimeout(-5)).toBe(0);
      expect(clampWaitTimeout(0)).toBe(0);
      expect(clampWaitTimeout(40_000)).toBe(40_000);
      expect(clampWaitTimeout(10_000_000)).toBe(55_000);
      expect(clampWaitTimeout(Infinity)).toBe(55_000);
    });

    it("never holds past the local proxy's advertised outbound budget", () => {
      expect(clampWaitTimeout(40_000, 20_000)).toBe(20_000);
      expect(clampWaitTimeout(10_000, 20_000)).toBe(10_000);
      expect(clampWaitTimeout(40_000, undefined)).toBe(40_000);
      expect(clampWaitTimeout(40_000, 0)).toBe(40_000); // malformed budget = no clamp
    });

    it('holds a timeout above the max for exactly 55s', async () => {
      vi.useFakeTimers();
      const mgr = await makeManager();
      let settled = false;
      const pending = wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 999_999 }).then((r) => {
        settled = true;
        return r;
      });

      await vi.advanceTimersByTimeAsync(54_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).timedOut).toBe(true);
    });

    it('answers immediately for timeout_ms 0 with nothing new', async () => {
      const mgr = await makeManager();
      const result = await wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 0 });
      expect(result.timedOut).toBe(true);
      expect(activeWaitCount()).toBe(0);
    });
  });

  describe('hold caps', () => {
    it(`allows ${MAX_WAITS_PER_SESSION} concurrent waits per session and rejects the next`, async () => {
      vi.useFakeTimers();
      const mgr = await makeManager();
      const c = ctx(mgr);
      const input = { cursors: seenAll(mgr), timeout_ms: 1_000 };
      const held = [wait(c, input), wait(c, input)];
      await flush();
      expect(activeWaitCount()).toBe(2);

      await expect(wait(c, input)).rejects.toThrow('too many concurrent waits');

      // A different session of the same caller is unaffected.
      const other = wait(ctx(mgr, 'alice', { sessionId: 'session-alice-2' }), input);
      await flush();
      expect(activeWaitCount()).toBe(3);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([...held, other]);
      expect(activeWaitCount()).toBe(0);

      // Slots are released: the session can wait again.
      const again = wait(c, input);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await again).timedOut).toBe(true);
    });

    it('does not count an immediate answer against the cap', async () => {
      vi.useFakeTimers();
      const mgr = await makeManager();
      const c = ctx(mgr);
      const input = { cursors: seenAll(mgr), timeout_ms: 1_000 };
      const held = [wait(c, input), wait(c, input)];
      await flush();

      fake('alice', 'chat').push('x');
      // The push wakes both holders; a fresh immediate poll still succeeds.
      await Promise.all(held);
      const result = await wait(c, { cursors: {}, timeout_ms: 0 });
      expect(result.streams['chat:_default'].events).toHaveLength(1);
    });

    it(`allows ${MAX_WAITS_PER_CALLER} concurrent waits per caller across sessions and rejects the next`, async () => {
      vi.useFakeTimers();
      const mgr = await makeManager();
      expect(MAX_WAITS_PER_CALLER).toBe(8);
      const input = { cursors: seenAll(mgr), timeout_ms: 1_000 };
      const held: Promise<WaitForEventsResult>[] = [];
      // Spread over sessions so the per-session cap is never the one that bites.
      for (let i = 0; i < MAX_WAITS_PER_CALLER; i++) {
        held.push(wait(ctx(mgr, 'alice', { sessionId: `alice-s${Math.floor(i / 2)}` }), input));
      }
      await flush();
      expect(activeWaitCount()).toBe(MAX_WAITS_PER_CALLER);

      await expect(wait(ctx(mgr, 'alice', { sessionId: 'alice-fresh' }), input)).rejects.toThrow(
        'too many concurrent waits',
      );

      // Another caller still gets a slot.
      const bob = wait(ctx(mgr, 'bob'), { cursors: seenAll(mgr, 'bob'), timeout_ms: 1_000 });
      await flush();
      expect(activeWaitCount()).toBe(MAX_WAITS_PER_CALLER + 1);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([...held, bob]);
      expect(activeWaitCount()).toBe(0);

      // Released: the caller can hold again.
      const again = wait(ctx(mgr, 'alice', { sessionId: 'alice-fresh' }), input);
      await flush();
      expect(activeWaitCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await again;
    });

    it(`allows ${MAX_WAITS_TOTAL} concurrent waits hub-wide and rejects the next`, async () => {
      vi.useFakeTimers();
      const mgr = await makeManager();
      const input = { cursors: seenAll(mgr), timeout_ms: 1_000 };
      const held: Promise<WaitForEventsResult>[] = [];
      // Spread over callers so the per-caller cap is never the one that bites.
      for (let i = 0; i < MAX_WAITS_TOTAL; i++) {
        held.push(wait(ctx(mgr, `caller${i % 16}`, { sessionId: `s${i}` }), input));
      }
      await flush();
      expect(activeWaitCount()).toBe(MAX_WAITS_TOTAL);

      await expect(wait(ctx(mgr, 'caller-new', { sessionId: 'fresh' }), input)).rejects.toThrow(
        'too many concurrent waits',
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(held);
      expect(activeWaitCount()).toBe(0);
      expect(mgr.eventListenerCount).toBe(0);
    });
  });

  describe('releaseAllWaits (shutdown)', () => {
    it('answers every held wait with timedOut:true and frees all resources', async () => {
      vi.useFakeTimers();
      const mgr = await makeManager();
      const ac = new AbortController();
      const held = [
        wait(ctx(mgr, 'alice', { signal: ac.signal }), {
          cursors: seenAll(mgr),
          timeout_ms: 30_000,
        }),
        wait(ctx(mgr, 'bob'), { cursors: seenAll(mgr, 'bob'), timeout_ms: 30_000 }),
      ];
      await flush();
      expect(activeWaitCount()).toBe(2);
      expect(mgr.eventListenerCount).toBe(2);

      expect(releaseAllWaits()).toBe(2);
      const [alice, bob] = await Promise.all(held);

      expect(alice.timedOut).toBe(true);
      expect(Object.keys(alice.streams)).toHaveLength(3);
      expect(bob.timedOut).toBe(true);
      expect(activeWaitCount()).toBe(0);
      expect(mgr.eventListenerCount).toBe(0);
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects new waits while draining, so clients back off instead of spinning', async () => {
      const mgr = await makeManager();
      releaseAllWaits();

      // An instant timedOut reply would make a watcher re-issue at once and
      // burn its whole rate limit; a tool error sends it into backoff.
      const rejected = wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 30_000 });
      await expect(rejected).rejects.toThrow('server shutting down');
      await expect(rejected).rejects.not.toThrow(/Unknown tool/);
      await expect(wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 0 })).rejects.toThrow(
        'server shutting down',
      );
      expect(activeWaitCount()).toBe(0);
      expect(mgr.eventListenerCount).toBe(0);

      resumeWaits();
      const held = wait(ctx(mgr), { cursors: seenAll(mgr), timeout_ms: 30_000 });
      await flush();
      expect(activeWaitCount()).toBe(1);
      releaseAllWaits();
      expect((await held).timedOut).toBe(true);
    });

    it('still hands out already-buffered events while draining', async () => {
      // Ring buffers are in memory: events not delivered now are lost on restart.
      const mgr = await makeManager();
      const cursors = seenAll(mgr);
      fake('alice', 'chat').push('last-words', { bye: true });
      releaseAllWaits();

      const result = await wait(ctx(mgr), { cursors, timeout_ms: 30_000 });
      expect(result.streams['chat:_default'].events.map((e) => e.data)).toEqual([{ bye: true }]);

      // Once caught up, the next call is rejected rather than answered empty.
      const caughtUp = { ...cursors, 'chat:_default': result.streams['chat:_default'].cursor };
      await expect(wait(ctx(mgr), { cursors: caughtUp })).rejects.toThrow('server shutting down');
    });
  });

  describe('abort', () => {
    it('releases the waiter and every listener when the signal aborts', async () => {
      const mgr = await makeManager();
      const baseline = mgr.eventListenerCount;
      const ac = new AbortController();
      const pending = wait(ctx(mgr, 'alice', { signal: ac.signal }), {
        cursors: seenAll(mgr),
        timeout_ms: 30_000,
      });
      await flush();
      expect(activeWaitCount()).toBe(1);
      expect(mgr.eventListenerCount).toBe(baseline + 1);

      ac.abort();

      await expect(pending).rejects.toThrow(/aborted/);
      expect(activeWaitCount()).toBe(0);
      expect(mgr.eventListenerCount).toBe(baseline);
    });

    it('rejects without holding when the signal is already aborted', async () => {
      const mgr = await makeManager();
      const ac = new AbortController();
      ac.abort();
      await expect(
        wait(ctx(mgr, 'alice', { signal: ac.signal }), {
          cursors: seenAll(mgr),
          timeout_ms: 30_000,
        }),
      ).rejects.toThrow(/aborted/);
      expect(activeWaitCount()).toBe(0);
      expect(mgr.eventListenerCount).toBe(0);
    });

    it('does not grow listeners across many waits on any exit path', async () => {
      vi.useFakeTimers();
      const mgr = await makeManager();
      const ac = new AbortController();
      const signalListeners = (): number => getEventListeners(ac.signal, 'abort').length;
      const ingestorListeners = fake('alice', 'chat').listenerCount('event');
      const c = ctx(mgr, 'alice', { signal: ac.signal });

      for (let i = 0; i < 20; i++) {
        // timeout path
        const t = wait(c, { cursors: seenAll(mgr), timeout_ms: 10 });
        await vi.advanceTimersByTimeAsync(10);
        await t;
        // event path
        const e = wait(c, { cursors: seenAll(mgr), timeout_ms: 1_000 });
        await flush();
        fake('alice', 'chat').push(`n${i}`);
        await e;
      }

      expect(mgr.eventListenerCount).toBe(0);
      expect(signalListeners()).toBe(0);
      expect(fake('alice', 'chat').listenerCount('event')).toBe(ingestorListeners);
      expect(activeWaitCount()).toBe(0);
    });
  });
});
