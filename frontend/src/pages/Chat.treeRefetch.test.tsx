/**
 * The open chat's parentage tree (header indicator + inline fork markers) is
 * fetched when the chat opens and again — debounced — on metadata events, so
 * a child split off from the sidebar drops out of an open parent's tree
 * without a reload. Harness as Chat.nativeParentLink.test.tsx.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import { getChatTree } from "../api";

const session = vi.hoisted(() => ({ metadataVersion: 0 }));
vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Parent", folder: "/tmp", is_git_repo: true, metadata: "{}" })),
  getChatTree: vi.fn(async (id: string) => ({
    targetChatId: id,
    rootChatId: id,
    ancestors: [],
    tree: { chatId: id, title: "Parent", provider: "claude-code", status: "stopped", folder: "/tmp", createdAt: "", updatedAt: "", children: [] },
  })),
  getMessages: vi.fn(async () => []),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  getCard: vi.fn(async () => ({ card: null })),
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => session.metadataVersion }));
vi.mock("../components/PromptInput", () => ({ default: () => <textarea aria-label="Composer" /> }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

const tree = () => (
  <MemoryRouter initialEntries={["/chat/parent"]}>
    <Routes>
      <Route path="/chat/:id" element={<Chat />} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  session.metadataVersion = 0;
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
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("fetches the tree on open, then once more after a burst of metadata events", async () => {
  const view = render(tree());
  await waitFor(() => expect(getChatTree).toHaveBeenCalledTimes(1));
  expect(getChatTree).toHaveBeenLastCalledWith("parent");

  // Three events in quick succession — one refetch, after the debounce.
  for (let v = 1; v <= 3; v++) {
    session.metadataVersion = v;
    view.rerender(tree());
  }
  expect(getChatTree).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(getChatTree).toHaveBeenCalledTimes(2), { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 600));
  expect(getChatTree).toHaveBeenCalledTimes(2);
});
