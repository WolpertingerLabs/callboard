// @vitest-environment jsdom
/**
 * Opening a chat whose run is already in progress must end in the same state
 * as starting the run from the page: "is thinking…" up, the dock's 5s poll
 * running, and the session-inactive safety net armed.
 *
 * In-app switching is the path that matters: the session registry already
 * knows the target chat is running, so the auto-connect effect acts in the
 * very commit that changes `id` — and the per-chat reset that runs in that
 * commit must not undo it.
 *
 * Real `Chat` and `ActivityDock`. The registry is a per-chat store the test
 * flips; `/stream` connects stay pending until the test opens them; and the
 * dock's 5s poll is the only 5000ms interval on the page, so it is captured
 * and ticked by hand instead of on a clock.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import Chat from "./Chat";
import { getActivity, stopChat } from "../api";
import type { ChatActivityResponse } from "../api";

type Session = { type: "web"; startedAt: number };

const { server, registry } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let sessions: Record<string, Session | null> = {};
  return {
    server: { activity: {} as Record<string, ChatActivityResponse> },
    registry: {
      get: (id: string) => sessions[id] ?? null,
      set: (id: string, next: Session | null) => {
        sessions = { ...sessions, [id]: next };
        listeners.forEach((l) => l());
      },
      reset: () => {
        sessions = {};
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
  getChat: vi.fn(async (id: string) => ({ id, title: `Chat ${id}`, folder: "/tmp/project", is_git_repo: false, metadata: "{}" })),
  getMessages: vi.fn(async (id: string) => [{ role: "user", type: "text", content: `message in ${id}` }]),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async (id: string) => server.activity[id]),
  stopChat: vi.fn(async () => ({ stopped: false })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
}));
vi.mock("../contexts/SessionContext", () => ({
  useIsSessionActive: (id: string) =>
    useSyncExternalStore(registry.subscribe, () => registry.get(id)),
  useMetadataVersion: () => 0,
}));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/PromptInput", () => ({ default: () => null }));

const OPEN_WATCH: ChatActivityResponse = {
  activities: [],
  conditionWatch: { id: "w1", chatId: "a", text: "CI to finish", attempts: 3, maxAttempts: 20, firstStartedAt: 0, lastCheckedAt: 0 },
  awaitingChildren: 0,
};
const TORN_DOWN: ChatActivityResponse = { activities: [], conditionWatch: null, awaitingChildren: 0 };
const CHECKING = /Checking: CI to finish \(attempt 3\/20\)/;
const THINKING = /is thinking\.\.\./;

type Connect = { chatId: string; signal: AbortSignal; resolve: (res: unknown) => void };
/** One per `/stream` connect, in order. Left pending until the test opens it. */
let connects: Connect[];
/** The page's live 5000ms intervals: the dock poll. */
let polls: Map<number, () => void>;
/** How connect `i` behaves; leave it alone to keep it pending. */
let connectPlan: (i: number, c: Connect & { reject: (err: unknown) => void }) => void;

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/** Settle connect `i` with a live body, returning the server's end of it. */
function openStream(i: number) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
  connects[i].signal.addEventListener("abort", () => {
    try {
      ctrl.error(abortError());
    } catch {
      // already closed
    }
  });
  connects[i].resolve({ ok: true, status: 200, body, json: async () => ({}) });
  return {
    send: (frame: object) => ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)),
    close: () => ctrl.close(),
  };
}

beforeEach(() => {
  registry.reset();
  registry.set("a", { type: "web", startedAt: 1 });
  server.activity = { a: OPEN_WATCH, b: TORN_DOWN };
  connects = [];
  polls = new Map();
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
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let nextPoll = -1;
  vi.stubGlobal("setInterval", ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== 5000) return realSetInterval(fn, ms, ...rest);
    const handle = nextPoll--;
    polls.set(handle, fn);
    return handle;
  }) as typeof setInterval);
  vi.stubGlobal("clearInterval", ((handle?: number) => {
    if (handle !== undefined && polls.delete(handle)) return;
    realClearInterval(handle);
  }) as typeof clearInterval);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const match = /\/api\/chats\/([^/]+)\/stream$/.exec(String(input));
      if (match) {
        return new Promise((resolve, reject) => {
          const signal = init!.signal!;
          const c = { chatId: match[1], signal, resolve };
          connects.push(c);
          signal.addEventListener("abort", () => reject(abortError()));
          connectPlan(connects.length - 1, { ...c, reject });
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

function Nav() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/chat/a")}>
        open a
      </button>
      <button type="button" onClick={() => navigate("/chat/b")}>
        open b
      </button>
    </>
  );
}

/** Mount on a chat, with in-app navigation to the other. */
async function mountOn(chatId: "a" | "b") {
  render(
    <MemoryRouter initialEntries={[`/chat/${chatId}`]}>
      <Nav />
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText(`message in ${chatId}`);
}

/** Mount on idle chat B, with in-app navigation to A. */
const mountOnIdleB = () => mountOn("b");

const readsOf = (chatId: string) => vi.mocked(getActivity).mock.calls.filter(([arg]) => arg === chatId).length;
const liveConnects = () => connects.filter((c) => !c.signal.aborted);
/** Every connect in order, `(x)` marking the aborted ones: `a(x),b`. */
const connectLog = () => connects.map((c) => `${c.chatId}${c.signal.aborted ? "(x)" : ""}`).join(",");
/** Let effects and promise chains run without advancing any clock. */
const flush = () => act(async () => {});

/** Fire the dock poll as if 5s had passed. */
async function tickPoll() {
  await act(async () => polls.forEach((fn) => fn()));
}

async function go(chatId: "a" | "b") {
  await act(async () => fireEvent.click(screen.getByText(`open ${chatId}`)));
  await screen.findByText(`message in ${chatId}`);
  await flush();
}

/** Everything a run started from this page has on. */
async function expectFollowingRunOnA() {
  await screen.findByText(CHECKING);
  expect(screen.getByText(THINKING)).toBeTruthy();
  expect(liveConnects().map((c) => c.chatId)).toEqual(["a"]);
  expect(polls.size).toBe(1);
  const before = readsOf("a");
  await tickPoll();
  expect(readsOf("a")).toBe(before + 1);
}

it("switching in-app to a running chat shows the indicator, starts the dock poll, and arms the session-inactive cleanup", async () => {
  await mountOnIdleB();
  expect(connects).toHaveLength(0);
  expect(polls.size).toBe(0);

  await go("a");
  await expectFollowingRunOnA();

  // The run ends without a word on the stream (connect still pending): only
  // the safety net can notice, and it must abort the connect, take the
  // indicator down and re-read the dock.
  server.activity.a = TORN_DOWN;
  await act(async () => registry.set("a", null));
  expect(connects[0].signal.aborted).toBe(true);
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
  expect(screen.queryByText(THINKING)).toBeNull();
  expect(polls.size).toBe(0);
});

it("brings everything down when that run completes", async () => {
  await mountOnIdleB();
  await go("a");
  await expectFollowingRunOnA();

  const stream = openStream(0);
  server.activity.a = TORN_DOWN;
  // The server ends the response after the run's last frame.
  await act(async () => {
    stream.send({ type: "message_complete" });
    stream.close();
  });
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
  // The registry catches up a beat later.
  await act(async () => registry.set("a", null));
  await flush();
  expect(screen.queryByText(THINKING)).toBeNull();
  expect(polls.size).toBe(0);
  // Nothing reconnects to the finished run.
  expect(connects).toHaveLength(1);
});

it("restores the run state on every switch A → B → A without double-connecting", async () => {
  await mountOnIdleB();

  await go("a");
  await expectFollowingRunOnA();
  expect(connects).toHaveLength(1);

  const bReadsBefore = readsOf("b");
  await go("b");
  // Leaving A drops its stream and everything that followed it; B is idle.
  expect(connects[0].signal.aborted).toBe(true);
  expect(liveConnects()).toHaveLength(0);
  expect(screen.queryByText(THINKING)).toBeNull();
  expect(screen.queryByText(CHECKING)).toBeNull();
  expect(polls.size).toBe(0);
  // B's dock is read once, by the switch itself.
  expect(readsOf("b")).toBe(bReadsBefore + 1);

  await go("a");
  await expectFollowingRunOnA();
  // Exactly one new connect, still exactly one after things settle.
  expect(connects.map((c) => c.chatId)).toEqual(["a", "a"]);
  await flush();
  expect(connects).toHaveLength(2);

  // And the second visit's safety net is armed too.
  server.activity.a = TORN_DOWN;
  await act(async () => registry.set("a", null));
  expect(connects[1].signal.aborted).toBe(true);
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
  expect(screen.queryByText(THINKING)).toBeNull();
  expect(polls.size).toBe(0);
});

// --- Leaving one running chat for another --------------------------------

it.each([
  ["streaming", () => openStream(0).send({ type: "message_update" })],
  ["still connecting", () => {}],
])("switching from running A (%s) to running B opens exactly one stream to B", async (_label, attachA) => {
  registry.set("b", { type: "web", startedAt: 2 });
  await mountOn("a");
  await waitFor(() => expect(connects).toHaveLength(1));
  await act(async () => attachA());
  await go("b");
  expect(connectLog()).toBe("a(x),b");
  expect(screen.getByText(THINKING)).toBeTruthy();
  expect(polls.size).toBe(1);
  // A's aborted connect has unwound by now. Registry polls rebuild the map on
  // every version bump, so B's entry is a fresh object each time and the
  // auto-connect effect re-runs: it must still see B's stream as attached.
  await act(async () => registry.set("b", { type: "web", startedAt: 2 }));
  await act(async () => registry.set("b", { type: "web", startedAt: 2 }));
  await flush();
  expect(connectLog()).toBe("a(x),b");
});

it("stopping A and then switching to running B still follows B", async () => {
  registry.set("b", { type: "web", startedAt: 2 });
  vi.mocked(stopChat).mockResolvedValue({ stopped: true } as Awaited<ReturnType<typeof stopChat>>);
  await mountOn("a");
  await waitFor(() => expect(connects).toHaveLength(1));
  openStream(0);
  // The stop suppresses reconnecting to A until the registry catches up,
  // which it hasn't by the time the user moves on.
  await act(async () => fireEvent.click(screen.getByTitle("Stop generation")));
  await waitFor(() => expect(stopChat).toHaveBeenCalledWith("a"));
  await go("b");
  expect(liveConnects().map((c) => c.chatId)).toEqual(["b"]);
  expect(screen.getByText(THINKING)).toBeTruthy();
});

it("follows running B after A completes, even when both sessions report the same startedAt", async () => {
  // startedAt is a timestamp, not an id: two chats can share one.
  registry.set("b", { type: "web", startedAt: 1 });
  await mountOn("a");
  await waitFor(() => expect(connects).toHaveLength(1));
  const stream = openStream(0);
  // A's run ends while the registry still lags and reports it active.
  await act(async () => {
    stream.send({ type: "message_complete" });
    stream.close();
  });
  await go("b");
  expect(connects.filter((c) => c.chatId === "b" && !c.signal.aborted)).toHaveLength(1);
  expect(screen.getByText(THINKING)).toBeTruthy();
});

// --- What following the run costs ----------------------------------------

/** Poll on the real `setInterval` with a real deadline (`waitFor`'s timeout is faked here). */
async function pollUntil(check: () => boolean, timeoutMs: number, what: string) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await act(
      () =>
        new Promise<void>((resolve) => {
          const t = setInterval(() => {
            clearInterval(t);
            resolve();
          }, 10);
        }),
    );
  }
}

/** Let a connect that just failed finish unwinding, on the frozen clock. */
async function unwind() {
  let ticks = 0;
  await pollUntil(() => ticks++ === 5, 10_000, "five real ticks");
}

it.each([
  ["the connect is rejected (daemon down)", (c: { reject: (err: unknown) => void }) => c.reject(new TypeError("Failed to fetch"))],
  [
    "the connect is refused (502 from a tunnel)",
    (c: { resolve: (res: unknown) => void }) => c.resolve({ ok: false, status: 502, body: null, json: async () => ({}) }),
  ],
])("keeps /activity reads to one per second when the run switched to drops into the reconnect loop: %s", async (_label, fail) => {
  // Following the run means following it into the reconnect loop too, the
  // same as a run started from the page. The loop backs off, and the
  // end-of-stream re-reads on it stay capped: the first retry (at most 500ms
  // on) still falls in the window the first failure's read opened.
  connectPlan = (_i, c) => fail(c);
  await mountOnIdleB();
  // Freeze the page's clock: the throttle's windows and the backoff move only when the test says.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  server.activity.a = TORN_DOWN;
  await act(async () => fireEvent.click(screen.getByText("open a")));
  // The switch's own read, plus one for the first stream end…
  await pollUntil(() => connects.length === 1 && readsOf("a") === 2, 10_000, "the first stream end's read");
  await unwind();
  await act(() => vi.advanceTimersByTimeAsync(500));
  await pollUntil(() => connects.length === 2, 10_000, "the first retry");
  await unwind();
  expect(readsOf("a")).toBe(2);
  // …and the retry's collapses into one trailing read when the window closes.
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(readsOf("a")).toBe(3);
  expect(connects).toHaveLength(2);
});
