/**
 * The Reconnect button refetches the transcript. If the user switches chats
 * while that refetch is in flight, its result belongs to the chat they left
 * and must not be applied to the one they are now looking at — the same
 * `currentIdRef` guard the tab-resume refetch uses.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import Chat from "./Chat";
import { getMessages } from "../api";

const session = vi.hoisted(() => ({ active: true, value: { type: "web", startedAt: 1 } }));
vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: `Chat ${id}`, folder: "/tmp", is_git_repo: true, metadata: "{}" })),
  getMessages: vi.fn(async () => []),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({
  useIsSessionActive: (id: string) => (id === "a" && session.active ? session.value : null),
  useMetadataVersion: () => 0,
}));
vi.mock("../components/PromptInput", () => ({ default: ({ disabled }: { disabled: boolean }) => <textarea aria-label="Composer" disabled={disabled} /> }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div>Git diff view</div> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div>Debug view</div> }));

function GoToB() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/chat/b")}>go to b</button>;
}

beforeEach(() => {
  session.active = true;
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
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/stream")) {
        // The stream drops and the session then reads as ended, leaving the
        // network error (and its Reconnect button) on screen.
        session.active = false;
        throw new TypeError("Failed to fetch");
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("drops a reconnect refetch that resolves after switching chats", async () => {
  render(
    <MemoryRouter initialEntries={["/chat/a"]}>
      <GoToB />
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Network error occurred");

  let resolveA!: (msgs: unknown[]) => void;
  vi.mocked(getMessages).mockImplementation(async (id: string) => {
    if (id === "a") return new Promise((resolve) => (resolveA = resolve)) as never;
    return [{ role: "user", type: "text", content: "message in chat B" }] as never;
  });

  await act(async () => {
    fireEvent.click(screen.getAllByTitle("Reconnect to stream")[0]);
  });
  await waitFor(() => expect(getMessages).toHaveBeenCalledWith("a"));

  await act(async () => {
    fireEvent.click(screen.getByText("go to b"));
  });
  await screen.findByText("message in chat B");

  await act(async () => {
    resolveA([{ role: "user", type: "text", content: "stale message from chat A" }]);
  });

  expect(screen.queryByText("stale message from chat A")).toBeNull();
  expect(screen.getByText("message in chat B")).toBeTruthy();
});
