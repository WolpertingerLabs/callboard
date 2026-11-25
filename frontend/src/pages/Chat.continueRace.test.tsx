// @vitest-environment jsdom
/**
 * Continue must not be undone by the stopped run's own terminal refetch.
 *
 * On `message_complete` (reason "aborted") the page refetches the chat and the
 * transcript together. The chat record — carrying `stoppedByUserAt` — can land
 * first, which puts Continue on screen while the transcript fetch is still
 * out. Clicked in that window, the late transcript used to be written over the
 * new run with the "Session was interrupted." notice appended. The refetch is
 * now dropped once a send has happened since the event (sendGenerationRef).
 *
 * Harness after Chat.runningSwitch.test.tsx: a controllable session registry,
 * `/stream` bodies the test drives, and the composer stubbed out.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import { getMessages } from "../api";
import type { ParsedMessage } from "../api";
import { CONTINUE_PROMPT, INTERRUPTED_MESSAGE } from "../utils/continueAfterInterrupt";

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

const TRANSCRIPT: ParsedMessage[] = [
  { role: "user", type: "text", content: "build it", timestamp: "2026-11-25T10:00:00.000Z" },
  { role: "assistant", type: "text", content: "working on it", timestamp: "2026-11-25T10:00:01.000Z" },
];

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({
    id,
    title: "Stopped",
    folder: "/tmp/project",
    is_git_repo: false,
    metadata: "{}",
    stoppedByUserAt: "2026-11-25T10:00:05.000Z",
  })),
  getMessages: vi.fn(async () => TRANSCRIPT),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
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
vi.mock("../components/PromptInput", () => ({ default: () => null }));

/** The server's end of the page's `/stream` connect. */
let stream: { send: (frame: object) => void } | null;
const posts: string[] = [];

beforeEach(() => {
  registry.reset();
  registry.set("c1", { type: "web", startedAt: 1 });
  stream = null;
  posts.length = 0;
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
      const url = String(input);
      if (url.endsWith("/stream") && !stream) {
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
        stream = { send: (frame) => ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)) };
        return { ok: true, status: 200, body, json: async () => ({}) };
      }
      if ((init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/message")) {
        posts.push(JSON.parse(String(init!.body)).prompt);
        // The new run: open, and silent for the rest of the test.
        return { ok: true, status: 200, body: new ReadableStream({ start: () => {} }), json: async () => ({}) };
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

it("a Continue clicked before the stopped run's transcript refetch lands is not overwritten by it", async () => {
  render(
    <MemoryRouter initialEntries={["/chat/c1"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("working on it");
  await waitFor(() => expect(stream).not.toBeNull());

  // The terminal refetch of the transcript stays out until the test says so.
  let answer!: (messages: ParsedMessage[]) => void;
  vi.mocked(getMessages).mockImplementationOnce(() => new Promise<ParsedMessage[]>((resolve) => (answer = resolve)));

  // The user's Stop, as the run reports it: the registry lets go, then the
  // run's terminal event arrives. The chat record (with the flag) answers
  // straight away; the transcript does not.
  act(() => registry.set("c1", null));
  await act(async () => stream!.send({ type: "message_complete", reason: "aborted" }));
  await waitFor(() => expect(vi.mocked(getMessages).mock.calls.length).toBeGreaterThanOrEqual(2));

  await act(async () => {
    fireEvent.click(await screen.findByTestId("continue-after-interrupt"));
  });
  await waitFor(() => expect(posts).toEqual([CONTINUE_PROMPT]));
  expect(screen.getByTestId("continued-divider")).toBeTruthy();

  // Now the stopped run's transcript lands.
  await act(async () => answer(TRANSCRIPT));
  await act(async () => {});

  expect(screen.queryByText(INTERRUPTED_MESSAGE)).toBeNull();
  // The new run's in-flight Continue is still on screen.
  expect(screen.getByTestId("continued-divider")).toBeTruthy();
});
