// @vitest-environment jsdom
/**
 * A run ending takes down the prompt it was suspended on. Stop is the common
 * case: the daemon aborts the run, drops the pending request and sends the
 * run's last `message_complete` (reason `aborted`) — the Allow/Deny card must
 * go with it, not linger under "Session was interrupted.". Same for
 * `message_error`, and for a tab that missed the end and re-reads `/pending`.
 *
 * What survives a run's end: a non-blocking computer-control approval (it
 * outlives runs, so `/pending` decides) and a plan review rebuilt from the
 * transcript (it never belonged to a run).
 *
 * Real `Chat` and `FeedbackPanel`; `/stream` connects stay pending until the
 * test opens them and pushes frames.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import { getMessages, getPending, stopChat, type PendingAction } from "../api";

const fixture = vi.hoisted(() => ({ active: { type: "web", startedAt: 1 } as { type: string; startedAt: number } | null }));

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: `Chat ${id}`, folder: "/tmp/project", is_git_repo: false, metadata: "{}" })),
  getMessages: vi.fn(async () => [{ role: "user", type: "text", content: "hello" }]),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  stopChat: vi.fn(async () => ({ stopped: true })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => fixture.active, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", () => ({ default: () => null }));

type Connect = { signal: AbortSignal; resolve: (res: unknown) => void };
let connects: Connect[];
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
  return { send: (frame: object) => act(async () => ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))) };
}

const PERMISSION = { type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "rm -rf build" } } as const;
const APPROVAL: PendingAction = {
  type: "permission_request",
  requestId: "cu1",
  toolName: "computer_use",
  controlRequest: true,
  humanOnly: true,
  nonBlocking: true,
};
const PROMPT = "Permission requested";
const flush = () => act(async () => {});

beforeEach(() => {
  fixture.active = { type: "web", startedAt: 1 };
  connects = [];
  vi.mocked(getPending).mockReset().mockResolvedValue(null);
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
      if (/\/api\/chats\/[^/]+\/stream$/.test(String(input))) {
        return new Promise((resolve, reject) => {
          const signal = init!.signal!;
          connects.push({ signal, resolve });
          signal.addEventListener("abort", () => reject(abortError()));
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

async function mountRunning() {
  render(
    <MemoryRouter initialEntries={["/chat/a"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("hello");
  await waitFor(() => expect(connects).toHaveLength(1));
  return openStream(0);
}

it("Stop takes the Allow/Deny card down with the run and shows the interrupted notice", async () => {
  const stream = await mountRunning();
  await stream.send(PERMISSION);
  expect(await screen.findByText(PROMPT)).toBeTruthy();

  await act(async () => fireEvent.click(screen.getByTitle("Stop generation")));
  await waitFor(() => expect(stopChat).toHaveBeenCalledWith("a"));
  // The daemon dropped the request on stop; the run's last frame follows.
  await stream.send({ type: "message_complete", reason: "aborted" });

  await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
  expect(await screen.findByText("Session was interrupted.")).toBeTruthy();
});

it("a stop from elsewhere (no click here) clears the card on message_complete", async () => {
  const stream = await mountRunning();
  await stream.send(PERMISSION);
  expect(await screen.findByText(PROMPT)).toBeTruthy();
  await stream.send({ type: "message_complete", reason: "aborted" });
  await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
});

it("re-reads /pending after the run ends, so a prompt the daemon still holds comes back", async () => {
  const stream = await mountRunning();
  await stream.send(PERMISSION);
  expect(await screen.findByText(PROMPT)).toBeTruthy();
  // A newer run's prompt the old run's last frame raced.
  vi.mocked(getPending).mockResolvedValue({ type: "permission_request", requestId: "r2", toolName: "Write", input: {} });
  const reads = vi.mocked(getPending).mock.calls.length;
  await stream.send({ type: "message_complete" });
  await waitFor(() => expect(vi.mocked(getPending).mock.calls.length).toBeGreaterThan(reads));
  expect(await screen.findByText(PROMPT)).toBeTruthy();
});

it("message_error clears the card too", async () => {
  const stream = await mountRunning();
  await stream.send(PERMISSION);
  expect(await screen.findByText(PROMPT)).toBeTruthy();
  await stream.send({ type: "message_error", content: "boom" });
  await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
});

it("a non-blocking computer-control approval outlives the run while the daemon still holds it", async () => {
  const stream = await mountRunning();
  await stream.send({ ...APPROVAL, type: "permission_request" });
  expect(await screen.findByText(PROMPT)).toBeTruthy();
  vi.mocked(getPending).mockResolvedValue(APPROVAL);
  const reads = vi.mocked(getPending).mock.calls.length;
  await stream.send({ type: "message_complete" });
  await waitFor(() => expect(vi.mocked(getPending).mock.calls.length).toBeGreaterThan(reads));
  await flush();
  expect(screen.getByText(PROMPT)).toBeTruthy();
});

it("a non-blocking approval the stop withdrew goes once /pending reports nothing", async () => {
  const stream = await mountRunning();
  await stream.send({ ...APPROVAL, type: "permission_request" });
  expect(await screen.findByText(PROMPT)).toBeTruthy();
  await stream.send({ type: "message_complete", reason: "aborted" });
  await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
});

it("a tab that missed the stop drops the server's card when /pending comes back empty", async () => {
  vi.mocked(getPending).mockResolvedValue({ type: "permission_request", requestId: "r1", toolName: "Bash", input: {} });
  await mountRunning();
  expect(await screen.findByText(PROMPT)).toBeTruthy();

  // Stopped while hidden; the tab comes back and re-reads.
  vi.mocked(getPending).mockResolvedValue(null);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
});

it("keeps a plan review rebuilt from the transcript when /pending is empty", async () => {
  fixture.active = null;
  vi.mocked(getMessages).mockResolvedValue([
    { role: "user", type: "text", content: "hello" },
    { role: "assistant", type: "tool_use", toolName: "ExitPlanMode", toolUseId: "t1", content: "The plan" },
  ] as never);
  render(
    <MemoryRouter initialEntries={["/chat/a"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText("Plan review")).toBeTruthy();
  // The tab comes back: /pending is empty, and this card has no requestId.
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await flush();
  expect(screen.getByText("Plan review")).toBeTruthy();
});
