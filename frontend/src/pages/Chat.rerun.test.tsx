/**
 * Rerun from a message: the fork menu's entry opens a confirmation, and
 * confirming asks the server to rerun (with the picked message's role and the
 * tree-parent precondition) and opens the chat that took this one's place.
 * Harness as Chat.treeRefetch.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import Chat from "./Chat";
import { getMessages, rerunChatFrom, RerunError, type ParsedMessage } from "../api";
import { getComposerDraft } from "../utils/localStorage";

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

/** Opens bubble `i`'s fork menu and picks "Rerun from here". */
function rerunFrom(i: number) {
  fireEvent.click(screen.getAllByTitle("Fork conversation from here")[i]!);
  fireEvent.click(screen.getByRole("button", { name: "Rerun from here" }));
}

/** How many bubbles' fork menus offer Rerun — each menu opened and closed in turn. */
function rerunnableCount() {
  let n = 0;
  for (const fork of screen.queryAllByTitle("Fork conversation from here")) {
    fireEvent.click(fork);
    n += screen.queryAllByRole("button", { name: "Rerun from here" }).length;
    fireEvent.click(fork);
  }
  return n;
}

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
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("reruns an assistant message's prompt after confirming, then opens the chat that replaced this one", async () => {
  render(tree());
  await screen.findByText("first answer");
  // One per bubble: the user prompt and the reply.
  expect(rerunnableCount()).toBe(2);
  rerunFrom(1);
  expect(await screen.findByText(/The prompt this reply answers is sent again/)).toBeTruthy();
  expect(rerunChatFrom).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
  await waitFor(() => expect(rerunChatFrom).toHaveBeenCalledWith("original", A1, "assistant", { expectedParentChatId: null }));
  expect(await screen.findByText("landed on replacement")).toBeTruthy();
});

it("sends nothing when the confirmation is cancelled", async () => {
  render(tree());
  await screen.findByText("first question");
  rerunFrom(0);
  expect(await screen.findByText(/This message is sent again/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/This message is sent again/)).toBeNull();
  expect(rerunChatFrom).not.toHaveBeenCalled();
});

it("offers no Rerun on a slash command or a compaction summary", async () => {
  vi.mocked(getMessages).mockResolvedValueOnce([
    { role: "user", type: "text", content: "/review", isBuiltInCommand: true, timestamp: Q1 },
    { role: "assistant", type: "text", content: "reviewed", timestamp: A1 },
    { role: "user", type: "text", content: "Summary of earlier", isCompactSummary: true, timestamp: "2026-01-01T10:00:05.000Z" },
  ] as ParsedMessage[]);
  render(tree());
  await screen.findByText("reviewed");
  // The command and the summary have none; nor does the reply to the command.
  expect(rerunnableCount()).toBe(0);
});

it("offers no Rerun on a reply to a slash command or a compaction, where the server would refuse", async () => {
  vi.mocked(getMessages).mockResolvedValueOnce([
    { role: "user", type: "text", content: "/review", isBuiltInCommand: true, timestamp: Q1 },
    { role: "assistant", type: "text", content: "reviewed", timestamp: A1 },
    { role: "system", type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: "2026-01-01T10:00:04.000Z" },
    { role: "user", type: "text", content: "Summary", isCompactSummary: true, timestamp: "2026-01-01T10:00:04.000Z" },
    { role: "assistant", type: "text", content: "ack", timestamp: "2026-01-01T10:00:05.000Z" },
    { role: "user", type: "text", content: "real question", timestamp: "2026-01-01T10:00:06.000Z" },
    { role: "assistant", type: "text", content: "real answer", timestamp: "2026-01-01T10:00:07.000Z" },
  ] as ParsedMessage[]);
  render(tree());
  await screen.findByText("real answer");
  // Only "real question" and "real answer".
  expect(rerunnableCount()).toBe(2);
});

it("offers no Rerun on a command's output, a handoff preamble, or the replies right after them", async () => {
  vi.mocked(getMessages).mockResolvedValueOnce([
    { role: "user", type: "text", content: "<local-command-stdout>Compacted </local-command-stdout>", isCommandOutput: true, timestamp: Q1 },
    { role: "assistant", type: "text", content: "noted", timestamp: A1 },
    {
      role: "user",
      type: "text",
      content: '<conversation_handoff from="Claude Code" to="Codex">\nx\n</conversation_handoff>',
      timestamp: "2026-01-01T10:00:02.000Z",
    },
    { role: "assistant", type: "text", content: "Understood", timestamp: "2026-01-01T10:00:02.000Z" },
  ] as ParsedMessage[]);
  render(tree());
  await screen.findByText("Understood");
  expect(rerunnableCount()).toBe(0);
});

it("holds the page with a pending indicator until the server answers", async () => {
  let answer!: (value: Awaited<ReturnType<typeof rerunChatFrom>>) => void;
  vi.mocked(rerunChatFrom).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  render(tree());
  await screen.findByText("first answer");
  rerunFrom(0);
  fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
  expect(await screen.findByText("Starting the rerun…")).toBeTruthy();
  answer({ chat: { id: "replacement" } as never, original: null });
  expect(await screen.findByText("landed on replacement")).toBeTruthy();
});

it("on a run that could not start: puts the prompt back in the new chat's composer and says why", async () => {
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.mocked(rerunChatFrom).mockResolvedValueOnce({
    chat: { id: "replacement" } as never,
    original: null,
    runError: "effort not supported",
    promptText: "first question",
  });
  render(tree());
  await screen.findByText("first question");
  rerunFrom(0);
  fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
  expect(await screen.findByText("landed on replacement")).toBeTruthy();
  expect(getComposerDraft("replacement")).toBe("first question");
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("effort not supported"));
});

it("on a refusal that left a fresh chat running: says so and opens that chat", async () => {
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.mocked(rerunChatFrom).mockRejectedValueOnce(new RerunError("moved. The rerun is running as a separate chat.", 409, "stray"));
  render(tree());
  await screen.findByText("first question");
  rerunFrom(0);
  fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
  expect(await screen.findByText("landed on stray")).toBeTruthy();
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("separate chat"));
});

it("on a plain refusal: says so and stays", async () => {
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.mocked(rerunChatFrom).mockRejectedValueOnce(new RerunError("This chat is still running", 409));
  render(tree());
  await screen.findByText("first question");
  rerunFrom(0);
  fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining("still running")));
  expect(screen.getByText("first question")).toBeTruthy();
  expect(screen.queryByText(/landed on/)).toBeNull();
});
