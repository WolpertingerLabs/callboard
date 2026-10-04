/**
 * event-watcher: the wait_for_events long-poll loop and its legacy fallback.
 *
 * The hub is mocked at the ProxyLike boundary. Every callTool returns a
 * promise the test settles by hand, so "in flight" is a real state here and
 * timing (immediate re-issue vs backoff vs 3s legacy interval) is asserted
 * against fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./event-log.js", () => ({
  appendEvent: vi.fn(),
}));
vi.mock("./trigger-dispatcher.js", () => ({
  dispatchEvent: vi.fn(),
}));
vi.mock("./proxy-singleton.js", () => ({
  getProxy: vi.fn(),
  resetClient: vi.fn(),
}));
vi.mock("./agent-file-service.js", () => ({
  listAgents: vi.fn(() => []),
}));
vi.mock("./agent-settings.js", () => ({
  resolveAgentKeyAlias: vi.fn(() => ({})),
}));

import { appendEvent } from "./event-log.js";
import { dispatchEvent } from "./trigger-dispatcher.js";
import { getProxy, resetClient } from "./proxy-singleton.js";
import { startWatcherForAlias, stopWatcherForAlias, shutdownEventWatchers } from "./event-watcher.js";

const ALIAS = "default";
const UNKNOWN_WAIT = "Unknown tool: wait_for_events";

interface Call {
  tool: string;
  input: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  settled?: boolean;
}

/** A hub whose every call stays pending until the test settles it. */
function makeHub() {
  const calls: Call[] = [];
  const client = {
    callTool: vi.fn((tool: string, input: Record<string, unknown> = {}) => {
      return new Promise((resolve, reject) => {
        calls.push({ tool, input, resolve, reject });
      });
    }),
  };
  const pending = () => calls.filter((c) => !c.settled);
  const settle = (c: Call, fn: () => void) => {
    c.settled = true;
    fn();
  };
  return {
    client,
    calls,
    /** The single unsettled call (asserts there is exactly one, of this tool). */
    current(tool: string): Call {
      const open = pending();
      expect(open.map((c) => c.tool)).toEqual([tool]);
      return open[0];
    },
    pendingTools: () => pending().map((c) => c.tool),
    resolve(c: Call, value: unknown) {
      settle(c, () => c.resolve(value));
    },
    reject(c: Call, message: string) {
      settle(c, () => c.reject(new Error(message)));
    },
  };
}

type Hub = ReturnType<typeof makeHub>;

function ev(id: number, source: string, extra: Record<string, unknown> = {}) {
  return { id, source, eventType: "MESSAGE_CREATE", receivedAt: new Date(0).toISOString(), data: { id }, ...extra };
}

function stream(connection: string, events: ReturnType<typeof ev>[], cursor: number, instanceId = "_default") {
  return { connection, instanceId, events, cursor };
}

/** Let resolved promises run their continuations without advancing time. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(appendEvent).mockReset();
  vi.mocked(dispatchEvent).mockReset();
  vi.mocked(resetClient).mockReset();
  // appendEvent dedupes by idempotency key: emulate that so dispatch-once is real.
  const seen = new Set<string>();
  vi.mocked(appendEvent).mockImplementation((e: any) => {
    if (e.idempotencyKey && seen.has(e.idempotencyKey)) return null;
    if (e.idempotencyKey) seen.add(e.idempotencyKey);
    return { ...e, storedAt: 1 };
  });
  hub = makeHub();
  vi.mocked(getProxy).mockReturnValue(hub.client);
});

afterEach(() => {
  shutdownEventWatchers();
  vi.useRealTimers();
});

/** Start the watcher and run past the initial 3s delay to the first call. */
async function start() {
  startWatcherForAlias(ALIAS);
  await vi.advanceTimersByTimeAsync(3000);
}

const dispatchedIds = () => vi.mocked(dispatchEvent).mock.calls.map(([e]: any[]) => `${e.source}#${e.id}`);

describe("event-watcher wait mode", () => {
  it("advances per-stream cursors and dispatches each new event once", async () => {
    await start();

    let call = hub.current("wait_for_events");
    expect(call.input).toEqual({ cursors: {}, timeout_ms: 25_000 });

    hub.resolve(call, {
      streams: {
        "discord-bot:_default": stream("discord-bot", [ev(5, "discord-bot"), ev(7, "discord-bot")], 7),
        "trello:board-a": stream("trello", [ev(100, "trello", { instanceId: "board-a" })], 100, "board-a"),
        "trello:board-b": stream("trello", [], -1, "board-b"),
      },
      unknownStreams: [],
      timedOut: false,
    });
    await flush();

    expect(dispatchedIds()).toEqual(["discord-bot#5", "discord-bot#7", "trello#100"]);
    // The stored record keeps instanceId and callerAlias exactly as before.
    expect(vi.mocked(appendEvent).mock.calls[2][0]).toMatchObject({ callerAlias: ALIAS, source: "trello", instanceId: "board-a", id: 100 });

    // Next wait carries every stream's own cursor, including the empty one.
    call = hub.current("wait_for_events");
    expect(call.input).toEqual({
      cursors: { "discord-bot:_default": 7, "trello:board-a": 100, "trello:board-b": -1 },
      timeout_ms: 25_000,
    });

    hub.resolve(call, {
      streams: {
        "discord-bot:_default": stream("discord-bot", [ev(8, "discord-bot")], 8),
        "trello:board-a": stream("trello", [], 100, "board-a"),
        "trello:board-b": stream("trello", [], -1, "board-b"),
      },
      unknownStreams: [],
      timedOut: false,
    });
    await flush();

    expect(dispatchedIds()).toEqual(["discord-bot#5", "discord-bot#7", "trello#100", "discord-bot#8"]);
    expect(hub.current("wait_for_events").input.cursors).toEqual({ "discord-bot:_default": 8, "trello:board-a": 100, "trello:board-b": -1 });
  });

  it("keeps appendEvent dedupe: a duplicate idempotency key is stored and dispatched once", async () => {
    await start();
    hub.resolve(hub.current("wait_for_events"), {
      streams: { "slack:_default": stream("slack", [ev(1, "slack", { idempotencyKey: "k1" })], 1) },
    });
    await flush();
    hub.resolve(hub.current("wait_for_events"), {
      streams: { "slack:_default": stream("slack", [ev(2, "slack", { idempotencyKey: "k1" })], 2) },
    });
    await flush();

    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect(dispatchedIds()).toEqual(["slack#1"]);
  });

  it("re-issues the wait immediately after a reply, including a timed-out empty one", async () => {
    await start();
    expect(hub.client.callTool).toHaveBeenCalledTimes(1);

    hub.resolve(hub.current("wait_for_events"), { streams: {}, unknownStreams: [], timedOut: true });
    await flush(); // no time passes
    expect(hub.client.callTool).toHaveBeenCalledTimes(2);
    expect(hub.pendingTools()).toEqual(["wait_for_events"]);

    // Never touches ingestor_status / poll_events while the hub supports waits.
    expect(hub.calls.map((c) => c.tool)).toEqual(["wait_for_events", "wait_for_events"]);
  });

  it("backs off exponentially on errors and resets after a success", async () => {
    await start();

    hub.reject(hub.current("wait_for_events"), "Proxy request failed: 429");
    await flush();
    expect(hub.pendingTools()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5999);
    expect(hub.pendingTools()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    hub.reject(hub.current("wait_for_events"), "too many concurrent waits");
    await flush();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(hub.pendingTools()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    hub.resolve(hub.current("wait_for_events"), { streams: {} });
    await flush();
    // Success: straight back to an immediate re-issue.
    expect(hub.pendingTools()).toEqual(["wait_for_events"]);
    expect(resetClient).not.toHaveBeenCalled();
  });

  it("resets the proxy client on a 401, as the legacy loop did", async () => {
    await start();
    hub.reject(hub.current("wait_for_events"), "Proxy request failed: 401");
    await flush();
    expect(resetClient).toHaveBeenCalledWith(ALIAS);
  });

  it("treats a reply without streams as an error, not as success", async () => {
    await start();
    hub.resolve(hub.current("wait_for_events"), [ev(1, "slack")]);
    await flush();
    expect(hub.pendingTools()).toEqual([]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(hub.pendingTools()).toEqual(["wait_for_events"]);
  });

  it("picks up streams first seen mid-run at their returned cursor", async () => {
    await start();
    hub.resolve(hub.current("wait_for_events"), {
      streams: { "discord-bot:_default": stream("discord-bot", [ev(3, "discord-bot")], 3) },
    });
    await flush();

    // A new connection and a new instance appear in this reply with events already in it.
    hub.resolve(hub.current("wait_for_events"), {
      streams: {
        "discord-bot:_default": stream("discord-bot", [], 3),
        "github:_default": stream("github", [ev(40, "github"), ev(41, "github")], 41),
        "trello:board-c": stream("trello", [ev(9, "trello", { instanceId: "board-c" })], 9, "board-c"),
      },
    });
    await flush();

    expect(dispatchedIds()).toEqual(["discord-bot#3", "github#40", "github#41", "trello#9"]);
    expect(hub.current("wait_for_events").input.cursors).toEqual({
      "discord-bot:_default": 3,
      "github:_default": 41,
      "trello:board-c": 9,
    });
  });

  it("stopping during an in-flight wait drops the reply and never reschedules", async () => {
    await start();
    const call = hub.current("wait_for_events");

    stopWatcherForAlias(ALIAS);
    hub.resolve(call, { streams: { "slack:_default": stream("slack", [ev(1, "slack")], 1) } });
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(hub.client.callTool).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopping during an in-flight wait that then fails does not reschedule either", async () => {
    await start();
    const call = hub.current("wait_for_events");
    stopWatcherForAlias(ALIAS);
    hub.reject(call, "Proxy request failed: 503");
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(hub.client.callTool).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a restart during an in-flight wait leaves exactly one loop running", async () => {
    await start();
    const stale = hub.current("wait_for_events");

    startWatcherForAlias(ALIAS); // stop + start, as a settings change does
    hub.resolve(stale, { streams: { "slack:_default": stream("slack", [ev(1, "slack")], 1) } });
    await flush();
    expect(dispatchEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.pendingTools()).toEqual(["wait_for_events"]);
    expect(hub.current("wait_for_events").input.cursors).toEqual({});
  });
});

describe("event-watcher legacy fallback", () => {
  /** Answer one legacy cycle: ingestor_status, then each poll_events. */
  async function answerLegacyCycle(statuses: { connection: string }[], events: Record<string, ReturnType<typeof ev>[]>) {
    hub.resolve(hub.current("ingestor_status"), statuses);
    await flush();
    const polls = hub.calls.filter((c) => c.tool === "poll_events" && !c.settled);
    expect(polls.map((p) => p.input.connection).sort()).toEqual(statuses.map((s) => s.connection).sort());
    for (const p of polls) hub.resolve(p, events[p.input.connection as string] ?? []);
    await flush();
    return polls;
  }

  it("falls back to ingestor_status + poll_events on the hub's unknown-tool error, in the same cycle", async () => {
    await start();
    hub.reject(hub.current("wait_for_events"), UNKNOWN_WAIT);
    await flush();

    const polls = await answerLegacyCycle([{ connection: "slack" }], { slack: [ev(4, "slack")] });
    expect(polls[0].input).toEqual({ after_id: -1, connection: "slack" });
    expect(dispatchedIds()).toEqual(["slack#4"]);

    // Next legacy cycle on the 3s interval, with the advanced cursor; no wait probe.
    expect(hub.pendingTools()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    const next = await answerLegacyCycle([{ connection: "slack" }], {});
    expect(next[0].input).toEqual({ after_id: 4, connection: "slack" });
    expect(hub.calls.filter((c) => c.tool === "wait_for_events")).toHaveLength(1);
  });

  it("does not mistake other failures for an old hub", async () => {
    await start();
    for (const message of ["Unknown tool: wait_for_events_v2", "Rate limit exceeded: Unknown tool: wait_for_events", "Unknown connection: slack"]) {
      hub.reject(hub.current("wait_for_events"), message);
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(hub.calls.map((c) => c.tool).every((t) => t === "wait_for_events")).toBe(true);
  });

  it("re-probes every 10 minutes and switches back once the hub supports waits", async () => {
    await start();
    hub.reject(hub.current("wait_for_events"), UNKNOWN_WAIT);
    await flush();
    await answerLegacyCycle([{ connection: "slack" }], { slack: [ev(4, "slack")] });

    // Legacy cycles until the probe is due. Each one is answered so the loop keeps going.
    let probe: Call | undefined;
    for (let elapsed = 0; elapsed <= 10 * 60_000 + 3000 && !probe; elapsed += 3000) {
      await vi.advanceTimersByTimeAsync(3000);
      const open = hub.pendingTools();
      if (open[0] === "wait_for_events") probe = hub.current("wait_for_events");
      else await answerLegacyCycle([{ connection: "slack" }], {});
    }
    expect(probe).toBeDefined();
    // The first legacy cycle ran at ~3s; the probe comes 10 min after the fallback, not before.
    expect(Date.now()).toBeGreaterThanOrEqual(3000 + 10 * 60_000);

    // Still unsupported: back to legacy for another 10 minutes.
    hub.reject(probe!, UNKNOWN_WAIT);
    await flush();
    await answerLegacyCycle([{ connection: "slack" }], {});
    const waitCallsAfterFirstReprobe = hub.calls.filter((c) => c.tool === "wait_for_events").length;
    expect(waitCallsAfterFirstReprobe).toBe(2);

    probe = undefined;
    for (let elapsed = 0; elapsed <= 10 * 60_000 + 3000 && !probe; elapsed += 3000) {
      await vi.advanceTimersByTimeAsync(3000);
      if (hub.pendingTools()[0] === "wait_for_events") probe = hub.current("wait_for_events");
      else await answerLegacyCycle([{ connection: "slack" }], {});
    }
    expect(probe).toBeDefined();
    // The legacy per-connection cursor seeds the matching _default stream: nothing re-delivered.
    expect(probe!.input.cursors).toEqual({ "slack:_default": 4 });

    // Hub upgraded: the probe succeeds and the watcher stays in wait mode.
    hub.resolve(probe!, { streams: { "slack:_default": stream("slack", [ev(5, "slack")], 5) } });
    await flush();
    expect(dispatchedIds()).toEqual(["slack#4", "slack#5"]);
    expect(hub.current("wait_for_events").input.cursors).toEqual({ "slack:_default": 5 });
  });

  it("carries wait-mode cursors into legacy mode if the hub loses wait_for_events", async () => {
    await start();
    hub.resolve(hub.current("wait_for_events"), {
      streams: {
        "slack:_default": stream("slack", [ev(4, "slack")], 4),
        "trello:a": stream("trello", [ev(20, "trello")], 20, "a"),
        "trello:b": stream("trello", [ev(30, "trello")], 30, "b"),
      },
    });
    await flush();
    hub.reject(hub.current("wait_for_events"), UNKNOWN_WAIT);
    await flush();

    hub.resolve(hub.current("ingestor_status"), [{ connection: "slack" }, { connection: "trello" }]);
    await flush();
    const polls = hub.calls.filter((c) => c.tool === "poll_events");
    expect(Object.fromEntries(polls.map((p) => [p.input.connection, p.input.after_id]))).toEqual({ slack: 4, trello: 30 });
  });

  it("stopping during an in-flight legacy cycle does not reschedule", async () => {
    await start();
    hub.reject(hub.current("wait_for_events"), UNKNOWN_WAIT);
    await flush();
    const status = hub.current("ingestor_status");
    stopWatcherForAlias(ALIAS);
    hub.resolve(status, [{ connection: "slack" }]);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.pendingTools()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
