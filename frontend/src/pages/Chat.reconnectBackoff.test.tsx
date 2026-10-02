// @vitest-environment jsdom
/**
 * The auto-connect loop backs off.
 *
 * While the session registry reports a chat's session active, every `/stream`
 * that ends sends the page straight back to it. A `/stream` that fails fast
 * used to spin with no delay: one reviewer probe of a chat whose `/stream`
 * answered `message_error` recorded 401 connects and 401 rate-limited
 * `getMessages` in 821ms, which is the whole 300/min API budget, after which
 * every call in the app 429s for the rest of the minute.
 *
 * Real `Chat`. The registry is a per-chat store the test flips; `/stream`
 * connects are scripted per call; and the page's clock (`Date`, `setTimeout`)
 * is frozen, so the backoff only advances when the test advances it. Promises,
 * React's scheduler and `setInterval` stay real, so waits go through
 * `pollUntil` on the real `setInterval` (`waitFor`'s timeout is a faked
 * setTimeout under vitest). `Math.random` is pinned to 0 (no jitter) unless a
 * test says otherwise, so the schedule is exact.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import Chat from "./Chat";
import { getMessages } from "../api";

type Session = { type: "web"; startedAt: number };

const { registry } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let sessions: Record<string, Session | null> = {};
  return {
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
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  stopChat: vi.fn(async () => ({ stopped: false })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
}));
vi.mock("../contexts/SessionContext", () => ({
  useIsSessionActive: (id: string) => useSyncExternalStore(registry.subscribe, () => registry.get(id)),
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

type Connect = {
  chatId: string;
  signal: AbortSignal;
  resolve: (res: unknown) => void;
  reject: (err: unknown) => void;
};
/** One per `/stream` connect, in order. */
let connects: Connect[];
/** How connect `i` behaves; leave it alone to keep it pending. */
let connectPlan: (i: number, c: Connect) => void;
/** One per `POST /message`, in order, left pending for the test to answer. */
let posts: Connect[];
let random: MockInstance<() => number>;

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

/** A live body that errors when the request is aborted, as real fetch does. */
function liveBody(signal: AbortSignal) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
  signal.addEventListener("abort", () => {
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
  };
}

/** Settle `c` with a live body, returning the server's end of it. */
function open(c: Connect) {
  const live = liveBody(c.signal);
  c.resolve({ ok: true, status: 200, body: live.body, json: async () => ({}) });
  // Every connect opens with this, the refusals included (utils/sse.ts beginSSE).
  live.send({ type: "server_info", protocolVersion: 1 });
  return live;
}

// The ways a connect fails fast.
const REJECT = (c: Connect) => c.reject(new TypeError("Failed to fetch"));
const REFUSE_502 = (c: Connect) => c.resolve({ ok: false, status: 502, body: null, json: async () => ({}) });
const CLOSE_EMPTY = (c: Connect) => open(c).close();
/** What stream.ts answers when it has no session to follow. */
const REFUSAL = (c: Connect) => {
  const live = open(c);
  live.send({ type: "message_error", content: "No active session found" });
  live.close();
};

// Every wait below is a real-time poll with its own 3s deadline, well inside
// this. A broken page then fails a test on an assertion, not on vitest's
// timeout — which leaves that test's loop running into the next one.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Bumped as each test ends. A wait started by an earlier test sees it and
 * stops, so a test that failed mid-wait can't drive the page (or the frozen
 * clock) of the one after it.
 */
let generation = 0;

beforeEach(() => {
  registry.reset();
  registry.set("a", { type: "web", startedAt: 1 });
  connects = [];
  posts = [];
  connectPlan = () => {};
  random = vi.spyOn(Math, "random").mockReturnValue(0);
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
      const match = /\/api\/chats\/([^/]+)\/(stream|message)$/.exec(String(input));
      if (match) {
        return new Promise((resolve, reject) => {
          const signal = init!.signal!;
          const c: Connect = { chatId: match[1], signal, resolve, reject };
          signal.addEventListener("abort", () => reject(abortError()));
          if (match[2] === "message") {
            posts.push(c);
            return;
          }
          connects.push(c);
          connectPlan(connects.length - 1, c);
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  generation += 1;
  // Unmount first (it aborts the page's connects), then drop whatever the page
  // left on the frozen clock: a backoff wake must not fire into the next test.
  cleanup();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  registry.reset();
  random.mockRestore();
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

/** Poll on the real `setInterval` with a real deadline. */
async function pollUntil(check: () => boolean, what: string, timeoutMs = 3_000) {
  const startedIn = generation;
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (generation !== startedIn) throw new Error(`abandoned waiting for ${what}: its test is over`);
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

/** Let whatever the last step set off finish, without moving the frozen clock. */
async function unwind() {
  let ticks = 0;
  await pollUntil(() => ticks++ === 5, "five real ticks");
}

/** Move the frozen clock on, then let the page catch up. */
async function advance(ms: number) {
  if (!vi.isFakeTimers()) throw new Error("advance() after the test's clock was reset");
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await unwind();
}

const connectsTo = (chatId: string) => connects.filter((c) => c.chatId === chatId).length;
const messageReadsOf = (chatId: string) => vi.mocked(getMessages).mock.calls.filter(([arg]) => arg === chatId).length;

/**
 * Mount idle on B, freeze the clock, and switch in-app to A, whose session is
 * already active: the page attaches at once, and every later connect is the
 * backoff's doing.
 */
async function openA() {
  render(
    <MemoryRouter initialEntries={["/chat/b"]}>
      <Nav />
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("message in b");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  await go("a");
}

/** Switch in-app on the frozen clock. */
async function go(chatId: "a" | "b") {
  await act(async () => fireEvent.click(screen.getByText(`open ${chatId}`)));
  await pollUntil(() => !!screen.queryByText(`message in ${chatId}`), `chat ${chatId} to load`);
  await unwind();
}

/**
 * Expect exactly one new connect to `chatId` at `delay` from now, and not a
 * millisecond sooner. 0 means at once: the clock doesn't move, though a 0ms
 * timer may still have to fire.
 */
async function expectRetryAfter(chatId: string, delay: number) {
  const before = connectsTo(chatId);
  if (delay > 1) {
    await advance(delay - 1);
    expect(connectsTo(chatId), `nothing before ${delay}ms`).toBe(before);
  }
  await advance(Math.min(delay, 1));
  expect(connectsTo(chatId), `a retry at ${delay}ms`).toBe(before + 1);
}

/** Every delay the schedule takes, from the 1st failure on: 500ms doubling, capped at 30s. */
const SCHEDULE = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];

// --- The schedule --------------------------------------------------------

it.each([
  ["the connect is rejected (daemon down)", REJECT],
  ["the connect is refused (502 from a tunnel)", REFUSE_502],
  ["the stream opens and closes empty", CLOSE_EMPTY],
])("reconnects on the backoff schedule when every connect fails fast: %s", async (_label, fail) => {
  connectPlan = (_i, c) => fail(c);
  await openA();
  // The connect on opening the chat is immediate…
  expect(connectsTo("a")).toBe(1);
  // …and each fast failure after it waits twice as long as the last, up to 30s.
  for (const delay of SCHEDULE) await expectRetryAfter("a", delay);
  expect(connectsTo("a")).toBe(1 + SCHEDULE.length);
});

it("jitters each delay down by up to a quarter, never up past the cap", async () => {
  random.mockReturnValue(0.999_999);
  connectPlan = (_i, c) => REJECT(c);
  await openA();
  for (const ceiling of SCHEDULE) await expectRetryAfter("a", Math.round(ceiling * (1 - 0.25 * 0.999_999)));
});

// --- Stop retrying -------------------------------------------------------

it("stops after four refusals in a row (/stream and getMessages both bounded) and says so", async () => {
  // A `/stream` with no session to follow answers message_error and closes,
  // and the page refetches the transcript for each one. Forever, on main.
  connectPlan = (_i, c) => REFUSAL(c);
  await openA();
  const loadReads = messageReadsOf("a") - 1;
  // Where the reviewer's probe counted 401 of each in 821ms:
  await expectRetryAfter("a", 500);
  await advance(321);
  expect(connectsTo("a")).toBe(2);
  expect(messageReadsOf("a") - loadReads).toBe(2);
  // Two more, on schedule; then it gives up, ~3.5s after opening the chat.
  await expectRetryAfter("a", 1_000 - 321);
  await expectRetryAfter("a", 2_000);
  const notice = /Can't follow this run \(No active session found\)\. Stopped retrying\./;
  await pollUntil(() => !!screen.queryByText(notice), "the give-up notice");
  // Nothing more, however long the registry keeps saying the session is
  // active — including the poll rebuilding its entry on every version bump.
  await advance(10 * 60_000);
  await act(async () => registry.set("a", { type: "web", startedAt: 1 }));
  await advance(60_000);
  expect(connectsTo("a")).toBe(4);
  expect(messageReadsOf("a") - loadReads).toBe(4);
  // The refusals are in the transcript, once.
  expect(screen.getAllByText("No active session found")).toHaveLength(1);
});

it("keeps a run's own error on screen when the retry after it is refused", async () => {
  // The run fails on its very first frame. The 500ms retry beats the registry
  // to the run ending, and /stream, with no session left, refuses it.
  connectPlan = (i, c) => {
    if (i > 0) return REFUSAL(c);
    const live = open(c);
    live.send({ type: "message_error", content: "Invalid API key" });
    live.close();
  };
  await openA();
  await pollUntil(() => !!screen.queryByText("Invalid API key"), "the run's error");
  await expectRetryAfter("a", 500);
  // The refusal's transcript refetch has landed, and the run's error is still what it shows.
  await unwind();
  expect(screen.getByText("Invalid API key")).toBeTruthy();
  expect(screen.queryByText("No active session found")).toBeNull();
  // The registry catches up; nothing replaces it after that either.
  await act(async () => registry.set("a", null));
  await advance(60_000);
  expect(connectsTo("a")).toBe(2);
  expect(screen.getByText("Invalid API key")).toBeTruthy();
  // A new session is a new run: its refusal is its own, and it shows.
  await act(async () => registry.set("a", { type: "web", startedAt: 2 }));
  await unwind();
  expect(connectsTo("a")).toBe(3);
  await pollUntil(() => !!screen.queryByText("No active session found"), "the new session's refusal");
});

it("shows a later refusal once a run has been heard from since the error", async () => {
  // The run's error, then a stream with run frames (something is running
  // again), then a refusal: the error is history by then, and the refusal is
  // what the transcript should say.
  connectPlan = (i, c) => {
    if (i === 0) {
      const live = open(c);
      live.send({ type: "message_error", content: "Invalid API key" });
      live.close();
    } else if (i === 1) {
      const live = open(c);
      live.send({ type: "message_update" });
      live.close();
    } else REFUSAL(c);
  };
  await openA();
  await pollUntil(() => !!screen.queryByText("Invalid API key"), "the run's error");
  await expectRetryAfter("a", 500);
  // The stream that worked: the 500ms floor from its start.
  await expectRetryAfter("a", 500);
  await pollUntil(() => !!screen.queryByText("No active session found"), "the refusal");
  expect(screen.queryByText("Invalid API key")).toBeNull();
});

it("starts over after giving up: on Reconnect, on a new session, and clears when the session ends", async () => {
  connectPlan = (_i, c) => REFUSAL(c);
  await openA();
  for (const delay of [500, 1_000, 2_000]) await expectRetryAfter("a", delay);
  const gaveUp = /Can't follow this run/;
  await pollUntil(() => !!screen.queryByText(gaveUp), "the give-up notice");

  // Reconnect: at once, and with a fresh four tries.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Reconnect$/ })));
  await unwind();
  expect(connectsTo("a")).toBe(5);
  for (const delay of [500, 1_000, 2_000]) await expectRetryAfter("a", delay);
  await pollUntil(() => !!screen.queryByText(gaveUp), "the give-up notice again");
  await advance(60_000);
  expect(connectsTo("a")).toBe(8);

  // A new session on the chat (a different startedAt) is a different run.
  await act(async () => registry.set("a", { type: "web", startedAt: 2 }));
  await unwind();
  expect(connectsTo("a")).toBe(9);
  expect(screen.queryByText(gaveUp)).toBeNull();
  for (const delay of [500, 1_000, 2_000]) await expectRetryAfter("a", delay);
  await pollUntil(() => !!screen.queryByText(gaveUp), "the give-up notice for the new session");

  // The session ending leaves nothing to have given up on.
  await act(async () => registry.set("a", null));
  await unwind();
  expect(screen.queryByText(gaveUp)).toBeNull();
  expect(screen.queryByRole("button", { name: /^Reconnect$/ })).toBeNull();
});

it("never gives up on a run that fails after its frames, and still spaces the reconnects", async () => {
  // A message_error after the run's frames is the run failing, not /stream
  // refusing: it resets the backoff like any stream that worked. The next
  // connect still waits out the 500ms floor from the last one's start.
  connectPlan = (_i, c) => {
    const live = open(c);
    live.send({ type: "message_update" });
    live.send({ type: "message_error", content: "boom" });
    live.close();
  };
  await openA();
  for (let i = 0; i < 10; i++) await expectRetryAfter("a", 500);
  expect(screen.queryByText(/Can't follow this run/)).toBeNull();
});

// --- What resets it ------------------------------------------------------

it.each([
  [
    "a run frame",
    async (c: Connect) => {
      const live = open(c);
      live.send({ type: "message_update" });
      await unwind();
      live.close();
      // The floor: never two auto-connects within 500ms of each other.
      return 500;
    },
  ],
  [
    "staying open 10s",
    async (c: Connect) => {
      // Heartbeats are SSE comments, which the reader never sees as frames.
      const live = open(c);
      await advance(10_000);
      live.close();
      return 0;
    },
  ],
])("a stream that worked resets the backoff: %s", async (_label, work) => {
  connectPlan = (i, c) => {
    if (i !== 5) REJECT(c);
  };
  await openA();
  for (const delay of SCHEDULE.slice(0, 5)) await expectRetryAfter("a", delay);
  // Connect 6 is the one that works. Without it, the next wait would be 16s.
  expect(connectsTo("a")).toBe(6);
  const floor = await work(connects[5]);
  await unwind();
  await expectRetryAfter("a", floor);
  // The next failure is a first failure again.
  await expectRetryAfter("a", 500);
  await expectRetryAfter("a", 1_000);
});

it("a tab return re-attaches to a quiet live run at once, every time", async () => {
  // A live run that sends nothing for a while: a long tool call, a pending
  // prompt, a subagent wait. Each tab return aborts the stream and attaches
  // again. Those aborts are the page's own, not failures, so none of them
  // may push the next attach out.
  connectPlan = (_i, c) => {
    open(c);
  };
  await openA();
  expect(connectsTo("a")).toBe(1);
  for (let ret = 1; ret <= 8; ret++) {
    await advance(3_000);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await unwind();
    expect(connects[ret - 1].signal.aborted, `return ${ret} drops the old stream`).toBe(true);
    expect(connectsTo("a"), `return ${ret} re-attaches without waiting`).toBe(ret + 1);
  }
  expect(connects.filter((c) => !c.signal.aborted)).toHaveLength(1);
});

it("switching chats starts the backoff over, and the chat left never retries", async () => {
  connectPlan = (_i, c) => REJECT(c);
  await openA();
  registry.set("b", { type: "web", startedAt: 1 });
  for (const delay of SCHEDULE.slice(0, 5)) await expectRetryAfter("a", delay);
  // A is now waiting out 16s.
  const aConnects = connectsTo("a");
  await go("b");
  expect(connectsTo("b")).toBe(1);
  // B's first failure waits 500ms, not A's 16s.
  await expectRetryAfter("b", 500);
  await expectRetryAfter("b", 1_000);
  // A's pending retry went with it.
  await advance(60_000);
  expect(connectsTo("a")).toBe(aConnects);
  // And coming back to A starts it over too.
  await go("a");
  expect(connectsTo("a")).toBe(aConnects + 1);
  await expectRetryAfter("a", 500);
});

it("the Reconnect button skips the wait and starts the count over", async () => {
  connectPlan = (_i, c) => REJECT(c);
  await openA();
  for (const delay of SCHEDULE.slice(0, 6)) await expectRetryAfter("a", delay);
  // Waiting out 30s now, with the failed connect's banner up.
  const before = connectsTo("a");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Reconnect$/ })));
  await unwind();
  expect(connectsTo("a")).toBe(before + 1);
  // That one failed too: a first failure.
  await expectRetryAfter("a", 500);
});

it("sending skips the wait, and the reconnect after the send's stream is immediate", async () => {
  connectPlan = (_i, c) => REJECT(c);
  await openA();
  for (const delay of SCHEDULE.slice(0, 6)) await expectRetryAfter("a", delay);
  const before = connectsTo("a");
  await act(async () => fireEvent.click(screen.getByText("send")));
  await unwind();
  expect(posts).toHaveLength(1);
  // The send's own stream ends without a frame; the session is still active,
  // so the page goes back to /stream — now, not 30s from now.
  const live = liveBody(posts[0].signal);
  posts[0].resolve({ ok: true, status: 200, body: live.body, json: async () => ({}) });
  live.close();
  await unwind();
  expect(connectsTo("a")).toBe(before + 1);
  await expectRetryAfter("a", 500);
});
