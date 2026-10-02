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
 * Real `Chat` and `ActivityDock`; `getActivity` answers from a mutable
 * `server` record, `/stream` connects are deferreds the test settles, and the
 * session registry is a store the test flips.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import type { ChatActivityResponse } from "../api";

const { server, registry } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let active: { type: "web"; startedAt: number } | null = { type: "web", startedAt: 1 };
  return {
    server: { activity: null as unknown as ChatActivityResponse },
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
  getActivity: vi.fn(async () => server.activity),
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
vi.mock("../components/PromptInput", () => ({ default: () => null }));

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

/** One per `/stream` connect, in order. Unsettled = a connect still pending. */
let connects: Array<{ resolve: (res: unknown) => void; reject: (err: unknown) => void }>;

/** Settle connect `i` with a live body, returning the server's end of it. */
function openStream(i: number) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
  connects[i].resolve({ ok: true, status: 200, body, json: async () => ({}) });
  return {
    send: (frame: object) => ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)),
    close: () => ctrl.close(),
    error: (err: unknown) => ctrl.error(err),
  };
}

beforeEach(() => {
  server.activity = OPEN_WATCH;
  registry.set({ type: "web", startedAt: 1 });
  connects = [];
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
          connects.push({ resolve, reject });
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const CHECKING = /Checking: CI to finish \(attempt 3\/20\)/;

/** Mount on a chat whose run is mid-way through a condition watch. */
async function mountWatching() {
  render(
    <MemoryRouter initialEntries={["/chat/c1"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText(CHECKING);
  await waitFor(() => expect(connects).toHaveLength(1));
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
  // A registry poll tick after mount (any session's change bumps the version
  // and rebuilds the map). The safety net only arms from an auto-connect run
  // after the page's id-reset effect, which clears it on the mount commit.
  await act(async () => registry.set({ type: "web", startedAt: 1 }));
  // The connect is still pending — nothing from the stream will ever arrive.
  server.activity = TORN_DOWN;
  registry.set(null);
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
});
