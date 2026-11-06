/**
 * Rerun from a message: the bubble's hover button opens a confirmation, and
 * confirming asks the server to rerun (with the picked message's role and the
 * tree-parent precondition) and opens the chat that took this one's place.
 * Harness as Chat.treeRefetch.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import Chat from "./Chat";
import { rerunChatFrom } from "../api";

const Q1 = "2026-01-01T10:00:00.000Z";
const A1 = "2026-01-01T10:00:01.000Z";

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Work", folder: "/tmp", is_git_repo: true, metadata: "{}" })),
  getChatTree: vi.fn(async (id: string) => ({
    targetChatId: id,
    rootChatId: id,
    ancestors: [],
    tree: { chatId: id, title: "Work", provider: "claude-code", status: "stopped", folder: "/tmp", createdAt: "", updatedAt: "", children: [] },
  })),
  getMessages: vi.fn(async () => [
    { role: "user", type: "text", content: "first question", timestamp: Q1 },
    { role: "assistant", type: "text", content: "first answer", timestamp: A1 },
  ]),
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
  rerunChatFrom: vi.fn(async () => ({ chat: { id: "replacement" }, original: null, prompt: Q1 })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", () => ({ default: () => <textarea aria-label="Composer" /> }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

/** The original renders the real page; anywhere else is where a rerun landed. */
function Page() {
  const { id } = useParams();
  return id === "original" ? <Chat /> : <div>landed on {id}</div>;
}

const tree = () => (
  <MemoryRouter initialEntries={["/chat/original"]}>
    <Routes>
      <Route path="/chat/:id" element={<Page />} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
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

it("reruns an assistant message's prompt after confirming, then opens the chat that replaced this one", async () => {
  render(tree());
  await screen.findByText("first answer");
  const buttons = screen.getAllByRole("button", { name: "Rerun from here" });
  // One per bubble: the user prompt and the reply.
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]!);
  expect(await screen.findByText(/The prompt this reply answers is sent again/)).toBeTruthy();
  expect(rerunChatFrom).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
  await waitFor(() => expect(rerunChatFrom).toHaveBeenCalledWith("original", A1, "assistant", { expectedParentChatId: null }));
  expect(await screen.findByText("landed on replacement")).toBeTruthy();
});

it("sends nothing when the confirmation is cancelled", async () => {
  render(tree());
  await screen.findByText("first question");
  fireEvent.click(screen.getAllByRole("button", { name: "Rerun from here" })[0]!);
  expect(await screen.findByText(/This message is sent again/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/This message is sent again/)).toBeNull();
  expect(rerunChatFrom).not.toHaveBeenCalled();
});
