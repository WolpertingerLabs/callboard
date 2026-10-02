// @vitest-environment jsdom
/**
 * The dock comes down with the run, through the real page's fetch path.
 *
 * The dock only re-reads `GET /activity` on stream frames and on a 5s poll that
 * runs while `streaming` is true. Every way a run can end sets `streaming`
 * false, so whichever one fires is the last chance to re-read — miss it and the
 * row the dead run left up stays until the user navigates or refocuses. An
 * open condition watch makes that visible: it outlives any single wait and has
 * no countdown to run down, so a stale "Checking: …" line reads as live work.
 *
 * The other half is cost: `/activity` is rate-limited and `/stream` is not, and
 * the auto-connect loop reconnects with no backoff while the registry says the
 * session is active. Re-reads on that loop's path must stay bounded, and an
 * abort the page issues itself must not re-read twice.
 *
 * Real `Chat` and `ActivityDock`; `getActivity` answers from a mutable
 * `server` record, `/stream` connects are scripted per call (default: a
 * deferred the test settles, with its body tied to the request's AbortSignal
 * the way real fetch does), and the session registry is a store the test flips.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import Chat from "./Chat";
import { getActivity, stopChat } from "../api";
import type { ChatActivityResponse } from "../api";

const { server, registry } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let active: { type: "web"; startedAt: number } | null = { type: "web", startedAt: 1 };
  return {
    server: {
      activity: null as unknown as ChatActivityResponse,
      /** When set, the next reads hang until the test answers them. */
      hold: null as null | Array<(value: ChatActivityResponse) => void>,
      read(): Promise<ChatActivityResponse> {
        const held = this.hold;
        if (held) return new Promise((resolve) => held.push(resolve));
        return Promise.resolve(this.activity);
      },
    },
    registry: {
      get: () => active,
      set: (next: typeof active) => {
        active = next;
        listeners.forEach((l) => l());
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  };
});

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Watching CI", folder: "/tmp/project", is_git_repo: false, metadata: "{}" })),
  getMessages: vi.fn(async () => [{ role: "user", type: "text", content: "wait for CI" }]),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(() => server.read()),
  stopChat: vi.fn(async () => ({ stopped: false })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
}));
vi.mock("../contexts/SessionContext", () => ({
  useIsSessionActive: () => useSyncExternalStore(registry.subscribe, registry.get),
  useMetadataVersion: () => 0,
}));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/PromptInput", () => ({
  default: ({ onSend }: { onSend: (prompt: string) => void }) => (
    <button type="button" onClick={() => onSend("hi")}>
      send
    </button>
  ),
}));

const OPEN_WATCH: ChatActivityResponse = {
  activities: [],
  conditionWatch: {
    id: "w1",
    chatId: "c1",
    text: "CI to finish",
    attempts: 3,
    maxAttempts: 20,
    firstStartedAt: Date.now() - 60_000,
    lastCheckedAt: Date.now(),
  },
  awaitingChildren: 0,
};
const TORN_DOWN: ChatActivityResponse = { activities: [], conditionWatch: null, awaitingChildren: 0 };

type Connect = { resolve: (res: unknown) => void; reject: (err: unknown) => void; signal?: AbortSignal };
/** One per `/stream` connect, in order. Unsettled = a connect still pending. */
let connects: Connect[];
/** Overrides how connect `i` behaves; return undefined to leave it pending. */
let connectPlan: (i: number, c: Connect) => void;

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/** A live body that errors when the request is aborted, as real fetch does. */
function liveBody(signal?: AbortSignal) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
  signal?.addEventListener("abort", () => {
    try {
      ctrl.error(abortError());
    } catch {
      // already closed
    }
  });
  return {
    body,
    send: (frame: object) => ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)),
    close: () => ctrl.close(),
    error: (err: unknown) => ctrl.error(err),
  };
}

/** Settle connect `i` with a live body, returning the server's end of it. */
function openStream(i: number) {
  const live = liveBody(connects[i].signal);
  connects[i].resolve({ ok: true, status: 200, body: live.body, json: async () => ({}) });
  return live;
}

beforeEach(() => {
  server.activity = OPEN_WATCH;
  server.hold = null;
  registry.set({ type: "web", startedAt: 1 });
  connects = [];
  connectPlan = () => {};
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  for (const name of ["IntersectionObserver", "ResizeObserver"])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stream")) {
        return new Promise((resolve, reject) => {
          const c: Connect = { resolve, reject, signal: init?.signal ?? undefined };
          connects.push(c);
          init?.signal?.addEventListener("abort", () => reject(abortError()));
          connectPlan(connects.length - 1, c);
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const CHECKING = /Checking: CI to finish \(attempt 3\/20\)/;
const reads = () => vi.mocked(getActivity).mock.calls.length;
const settle = (ms = 100) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

function ChatWithSwitch() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/chat/c2")}>
        open c2
      </button>
      <Chat />
    </>
  );
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/chat/c1"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Mount on a chat whose run is mid-way through a condition watch. */
async function mountWatching() {
  const view = mount();
  await screen.findByText(CHECKING);
  await waitFor(() => expect(connects).toHaveLength(1));
  return view;
}

/** Mount idle, then let the run start while the page is open. */
async function mountThenGoLive(beforeLive?: () => void) {
  registry.set(null);
  const view = mount();
  await screen.findByText(CHECKING);
  beforeLive?.();
  await act(async () => registry.set({ type: "web", startedAt: 1 }));
  return view;
}

// Each case resolves well inside the 5s poll, so only the end-of-run re-read
// can be what clears the row.

it("re-reads the dock when the run completes", async () => {
  await mountWatching();
  const stream = openStream(0);
  stream.send({ type: "message_update" });
  // The run's finally clears the watch in the same tick it emits done.
  server.activity = TORN_DOWN;
  stream.send({ type: "message_complete" });
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

it("re-reads the dock when the run fails", async () => {
  await mountWatching();
  const stream = openStream(0);
  server.activity = TORN_DOWN;
  stream.send({ type: "message_error", content: "boom" });
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

it.each([
  ["ends without the run's last frame (daemon restart)", (s: ReturnType<typeof openStream>) => s.close()],
  ["errors mid-read (network loss)", (s: ReturnType<typeof openStream>) => s.error(new TypeError("network error"))],
])("re-reads the dock when the stream %s", async (_label, drop) => {
  await mountWatching();
  const stream = openStream(0);
  stream.send({ type: "message_update" });
  server.activity = TORN_DOWN;
  drop(stream);
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

it.each([
  ["the connect fails", () => connects[0].reject(new TypeError("Failed to fetch"))],
  ["the server refuses it", () => connects[0].resolve({ ok: false, status: 503, body: null, json: async () => ({}) })],
])("re-reads the dock when the stream cannot connect: %s", async (_label, fail) => {
  await mountWatching();
  server.activity = TORN_DOWN;
  fail();
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

it("re-reads the dock when the session goes inactive before the stream delivered anything", async () => {
  await mountWatching();
  // The connect is still pending — nothing from the stream will ever arrive.
  server.activity = TORN_DOWN;
  registry.set(null);
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

it("re-reads the dock when the 5-minute inactivity timeout gives up on a silent stream", async () => {
  // Five minutes of silence, compressed.
  const realSetTimeout = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, ms === 300_000 ? 150 : ms, ...rest)) as typeof setTimeout);
  await mountThenGoLive();
  await waitFor(() => expect(connects).toHaveLength(1));
  openStream(0);
  server.activity = TORN_DOWN;
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

it("re-reads the dock when the run is stopped from the page", async () => {
  const { container } = await mountWatching();
  server.activity = TORN_DOWN;
  // Nothing was running server-side any more: the local-stop path.
  fireEvent.click(container.querySelector(".chat-header-generation-stop")!);
  await waitFor(() => expect(stopChat).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

it("re-reads the dock from the Reconnect button", async () => {
  registry.set(null);
  mount();
  await screen.findByText(CHECKING);
  // A failed send is what puts the network-error banner up.
  fireEvent.click(screen.getByText("send"));
  const reconnect = await screen.findByRole("button", { name: /^Reconnect$/ });
  server.activity = TORN_DOWN;
  fireEvent.click(reconnect);
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});

// --- What the re-reads cost ---------------------------------------------

const SPINS = 40;
const LOOP_MODES: Array<[string, (c: Connect) => void]> = [
  ["the connect is rejected (daemon down)", (c) => c.reject(new TypeError("Failed to fetch"))],
  ["the connect is refused (502 from a tunnel)", (c) => c.resolve({ ok: false, status: 502, body: null, json: async () => ({}) })],
  [
    "the stream opens and closes empty",
    (c) => {
      const live = liveBody(c.signal);
      c.resolve({ ok: true, status: 200, body: live.body, json: async () => ({}) });
      live.close();
    },
  ],
  [
    "the stream says message_error and closes (registry lagging)",
    (c) => {
      const live = liveBody(c.signal);
      c.resolve({ ok: true, status: 200, body: live.body, json: async () => ({}) });
      live.send({ type: "message_error", content: "gone" });
      live.close();
    },
  ],
];

/**
 * Freeze the throttle's clock (`Date`, `setTimeout`) so its windows open and
 * close only when the test says, however slow the box runs the loop. Promises,
 * React's scheduler, `setInterval` and `performance` stay real, so the page
 * still runs; `waitFor`'s own timeout is a faked setTimeout under vitest, so
 * waits while frozen go through `pollUntil` instead.
 */
function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
}

/** Poll on the real `setInterval` with a real deadline. */
async function pollUntil(check: () => boolean, timeoutMs: number, what: string) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await act(() => new Promise<void>((resolve) => {
      const t = setInterval(() => {
        clearInterval(t);
        resolve();
      }, 10);
    }));
  }
}

it.each(LOOP_MODES)("keeps /activity reads bounded while the reconnect loop spins: %s", async (_label, fail) => {
  // The pre-existing auto-connect loop: registry still active, every connect
  // fails fast, and each failure reconnects at once. Capped at SPINS, after
  // which the connect is left pending.
  connectPlan = (i, c) => {
    if (i < SPINS) fail(c);
  };
  // The loop can run to its cap inside the act that starts it, so the
  // baseline is taken before going live.
  let before = 0;
  await mountThenGoLive(() => {
    freezeClock();
    before = reads();
    server.activity = TORN_DOWN;
  });
  await pollUntil(() => connects.length === SPINS + 1, 10_000, `${SPINS} reconnects`);
  // All SPINS stream ends fell in one window: one read at once…
  expect(reads() - before).toBe(1);
  // …and the rest collapsed into one trailing read when it closes.
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(reads() - before).toBe(2);
  // Bounded without losing the read that matters.
  expect(screen.queryByText(CHECKING)).toBeNull();
});

it("drops a trailing read still queued for the chat being left", async () => {
  connectPlan = (i, c) => {
    if (i < 2) c.reject(new TypeError("Failed to fetch"));
  };
  registry.set(null);
  render(
    <MemoryRouter initialEntries={["/chat/c1"]}>
      <Routes>
        <Route path="/chat/:id" element={<ChatWithSwitch />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText(CHECKING);
  freezeClock();
  // Two stream ends for c1 inside one window: one read now, one queued.
  await act(async () => registry.set({ type: "web", startedAt: 1 }));
  await pollUntil(() => connects.length === 3, 10_000, "two failed connects");
  const readsOf = (chatId: string) => vi.mocked(getActivity).mock.calls.filter(([arg]) => arg === chatId).length;
  const c1Before = readsOf("c1");
  fireEvent.click(screen.getByText("open c2"));
  await pollUntil(() => readsOf("c2") > 0, 10_000, "c2's own read");
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(readsOf("c1")).toBe(c1Before);
});

it("still re-reads the last stream end when an earlier one in the window saw the watch", async () => {
  // A drop the server hadn't noticed yet: the first read still sees the watch.
  connectPlan = (i, c) => {
    if (i === 0) c.reject(new TypeError("Failed to fetch"));
  };
  await mountThenGoLive();
  await waitFor(() => expect(connects).toHaveLength(2));
  expect(screen.getByText(CHECKING)).toBeTruthy();
  // The run is gone by the next failure, inside the same window. That read is
  // coalesced, not dropped.
  server.activity = TORN_DOWN;
  await act(async () => connects[1].reject(new TypeError("Failed to fetch")));
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull(), { timeout: 2_000 });
});

it("re-reads once, not twice, when the safety net aborts a live stream", async () => {
  await mountWatching();
  openStream(0);
  await settle();
  const before = reads();
  server.activity = TORN_DOWN;
  await act(async () => registry.set(null));
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
  await settle();
  expect(reads() - before).toBe(1);
});

it("re-reads once, not twice, when a tab resume aborts a live stream", async () => {
  await mountWatching();
  openStream(0);
  await settle();
  const before = reads();
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await settle();
  expect(reads() - before).toBe(1);
});

it("does not re-read when leaving the page aborts a live stream", async () => {
  const { unmount } = await mountWatching();
  openStream(0);
  await settle();
  const before = reads();
  unmount();
  await settle();
  expect(reads() - before).toBe(0);
});

it("does not let a late answer to an older read put the row back", async () => {
  await mountWatching();
  // A read that hangs (a slow poll tick)…
  server.hold = [];
  const held = server.hold;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(held).toHaveLength(1);
  // …overtaken by a newer one that sees the run gone.
  server.hold = null;
  server.activity = TORN_DOWN;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
  // The old answer lands last, still describing the watch.
  await act(async () => held[0](OPEN_WATCH));
  await settle();
  expect(screen.queryByText(CHECKING)).toBeNull();
});
