/**
 * Select & quote on the real chat page: text selected in a reply is quoted
 * into the composer's tray, and the next send carries it as a blockquote ahead
 * of what was typed. The tray empties as the message goes out and gets its
 * quotes back if the send is refused. Harness as Chat.rerun.test.tsx, with a
 * composer stub that renders the tray it is handed and sends "Why?".
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import Chat from "./Chat";
import { formatQuoteOrigin } from "../utils/messageQuotes";
import { getQuotes, resetQuoteTraysForTests } from "../hooks/useQuoteTray";

const Q1 = "2026-01-01T10:00:00.000Z";
const A1 = "2026-01-01T10:00:01.000Z";
const focusComposer = vi.fn();

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
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", async () => {
  const { useEffect } = await import("react");
  function PromptInputStub({
    onSend,
    accessory,
    onFocusRequest,
  }: {
    onSend: (prompt: string) => void;
    accessory?: ReactNode;
    onFocusRequest?: (focus: (() => void) | null) => void;
  }) {
    useEffect(() => {
      onFocusRequest?.(() => focusComposer);
    }, [onFocusRequest]);
    return (
      <div>
        {accessory}
        <button type="button" onClick={() => onSend("Why?")}>
          send
        </button>
      </div>
    );
  }
  return { default: PromptInputStub, parseLeadingCommand: (text: string) => ({ command: null, rest: text }) };
});
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

let refuseSend = false;
const sentPrompts = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => String(url) === "/api/chats/original/message" && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init!.body)).prompt as string);

const tree = () => (
  <MemoryRouter initialEntries={["/chat/original"]}>
    <Routes>
      <Route path="/chat/:id" element={<Chat />} />
    </Routes>
  </MemoryRouter>
);

/** Select the first `length` characters of the text node holding `text`, as a user would. */
function selectIn(text: string, length: number) {
  const el = screen.getByText(text);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode()!;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

beforeEach(() => {
  refuseSend = false;
  resetQuoteTraysForTests();
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
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/chats/original/message" && init?.method === "POST") {
        if (refuseSend) return { ok: false, status: 500, body: null, json: async () => ({ error: "agent unavailable" }) };
        return { ok: true, status: 200, body: new ReadableStream({ start: (c) => c.close() }), json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function quoteFromAnswer(action: "Quote" | "Ask" = "Quote") {
  render(tree());
  await screen.findByText("first answer");
  selectIn("first answer", 5);
  fireEvent.click(await screen.findByRole("button", { name: action }));
  await screen.findByTestId("quote-chip");
}

it("sends a quoted passage as a blockquote ahead of the typed text, and empties the tray", async () => {
  await quoteFromAnswer();
  expect(screen.queryByRole("toolbar")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "send" }));

  await waitFor(() => expect(sentPrompts()).toHaveLength(1));
  const origin = formatQuoteOrigin({ role: "assistant", timestamp: A1 });
  expect(sentPrompts()[0]).toBe(`> **${origin}:**\n> first\n\nWhy?`);
  expect(screen.queryByTestId("quote-chip")).toBeNull();
  expect(getQuotes("original")).toHaveLength(0);
});

it("puts the quotes back when the send is refused", async () => {
  refuseSend = true;
  await quoteFromAnswer();

  fireEvent.click(screen.getByRole("button", { name: "send" }));

  await waitFor(() => expect(sentPrompts()).toHaveLength(1));
  expect(await screen.findByTestId("quote-chip")).toBeTruthy();
  expect(getQuotes("original").map((q) => q.text)).toEqual(["first"]);
});

it("Ask quotes the passage and focuses the composer", async () => {
  await quoteFromAnswer("Ask");
  expect(focusComposer).toHaveBeenCalledTimes(1);
});

it("sends the typed text alone, unchanged, with an empty tray", async () => {
  render(tree());
  await screen.findByText("first answer");
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  await waitFor(() => expect(sentPrompts()).toEqual(["Why?"]));
});
