/**
 * Where focus goes when the aside panel closes, with the REAL composer in both
 * chats — the one that autofocuses its textarea when it mounts, which is what
 * made the panel's own mount-time read of `document.activeElement` see the
 * aside's textarea rather than what opened it.
 *
 * - Ask as aside: the button that asked goes away with the emptied tray, so
 *   focus comes back to the main composer, not to <body>.
 * - Opened from the URL: the same.
 * - Opened from the header list: back to the list's button.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Chat from "./Chat";
import { resetQuoteTraysForTests } from "../hooks/useQuoteTray";

const Q1 = "2026-01-01T10:00:00.000Z";
const A1 = "2026-01-01T10:00:01.000Z";
const created = vi.hoisted(() => new Set<string>());

const asideNode = {
  chatId: "aside-1",
  title: "Aside: Why?",
  role: "aside",
  forkedAt: A1,
  provider: "claude-code",
  status: "stopped",
  folder: "/tmp",
  createdAt: "",
  updatedAt: "",
  children: [],
};

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: id, folder: "/tmp", is_git_repo: false, metadata: "{}", slash_commands: ["compact"] })),
  getChatTree: vi.fn(async (id: string) => ({
    targetChatId: id,
    rootChatId: "original",
    ancestors: [],
    tree: {
      chatId: id,
      title: id,
      provider: "claude-code",
      status: "stopped",
      folder: "/tmp",
      createdAt: "",
      updatedAt: "",
      children: id === "original" && created.has("aside-1") ? [asideNode] : [],
    },
  })),
  getMessages: vi.fn(async (id: string) =>
    id === "original"
      ? [
          { role: "user", type: "text", content: "first question", timestamp: Q1 },
          { role: "assistant", type: "text", content: "first answer", timestamp: A1 },
        ]
      : [{ role: "assistant", type: "text", content: "the aside's reply", timestamp: "2026-01-01T11:00:00.000Z" }],
  ),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}
const page = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route
        path="/chat/:id"
        element={
          <>
            <Chat />
            <LocationProbe />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
);
const location = () => screen.getByTestId("location").textContent;
const panel = () => screen.getByTestId("aside-panel");
const mainComposer = () => within(document.querySelector<HTMLElement>(".chat-page > .chat-layout")!).getByPlaceholderText("Send a message...");
const asideComposer = () => within(panel()).getByPlaceholderText("Send a message...");

beforeEach(() => {
  created.clear();
  resetQuoteTraysForTests();
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  // A desktop pointer: the composers autofocus, as they do for real.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("hover: hover"), media: query, addEventListener() {}, removeEventListener() {} }));
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
      if (url === "/api/chats/original/fork" && init?.method === "POST") {
        created.add("aside-1");
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: "aside-1", folder: "/tmp", metadata: JSON.stringify({ chatRole: "aside", title: "Aside: Why?" }), started: false }),
        };
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
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

it("gives focus back to the main composer after Ask as aside, whose button went with the tray", async () => {
  render(page("/chat/original"));
  const answer = await screen.findByText("first answer");
  // Quote, type the question, ask.
  const text = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT).nextNode()!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 5);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
  fireEvent.change(mainComposer(), { target: { value: "Why?" } });
  const ask = await screen.findByRole("button", { name: "Ask as aside" });
  ask.focus();
  fireEvent.click(ask);

  await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
  await within(panel()).findByText("the aside's reply");
  await settle();
  // The aside's composer took focus on mounting — the case that broke this.
  expect(document.activeElement).toBe(asideComposer());

  fireEvent.keyDown(asideComposer(), { key: "Escape" });
  await waitFor(() => expect(location()).toBe("/chat/original"));
  expect(document.activeElement).toBe(mainComposer());
});

it("gives focus back to the main composer when the panel was opened from the URL", async () => {
  created.add("aside-1");
  render(page("/chat/original?aside=aside-1"));
  await within(panel()).findByText("the aside's reply");
  await settle();
  fireEvent.keyDown(panel(), { key: "Escape" });
  await waitFor(() => expect(location()).toBe("/chat/original"));
  expect(document.activeElement).toBe(mainComposer());
});

it("gives focus back to the header list's button when the panel was opened from it", async () => {
  created.add("aside-1");
  render(page("/chat/original"));
  const listButton = await screen.findByRole("button", { name: "1 aside in this chat" });
  listButton.focus();
  fireEvent.click(listButton);
  fireEvent.click(within(screen.getByRole("menu", { name: "Asides of this chat" })).getByRole("menuitem", { name: /Aside: Why\?/ }));
  await within(panel()).findByText("the aside's reply");
  await settle();
  expect(document.activeElement).toBe(asideComposer());
  fireEvent.keyDown(asideComposer(), { key: "Escape" });
  await waitFor(() => expect(location()).toBe("/chat/original"));
  expect(document.activeElement).toBe(listButton);
});
