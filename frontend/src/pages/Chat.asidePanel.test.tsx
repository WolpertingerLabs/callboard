/**
 * The aside panel on the real chat page: `?aside=<id>` opens the aside's own
 * Chat, embedded beside the main one, which stays mounted (its composer keeps
 * what was typed). The marker chip and the header list open it; forks still
 * navigate. Close and Escape close it (popping the entry the open pushed); a
 * reply in it can be inserted into the main chat's quote tray. The embedded
 * chat carries no page header and no Ask as aside of its own, and nothing
 * complains about two chat views at once. Harness as Chat.askAside.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import Chat from "./Chat";
import { getQuotes, resetQuoteTraysForTests } from "../hooks/useQuoteTray";

const Q1 = "2026-01-01T10:00:00.000Z";
const A1 = "2026-01-01T10:00:01.000Z";

const node = (chatId: string, extra: Record<string, unknown> = {}) => ({
  chatId,
  title: chatId,
  provider: "claude-code",
  status: "stopped",
  folder: "/tmp",
  createdAt: "2026-01-01T11:00:00.000Z",
  updatedAt: "",
  children: [],
  ...extra,
});
let treeChildren: ReturnType<typeof node>[] = [];

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: id, folder: "/tmp", is_git_repo: true, metadata: "{}", slash_commands: ["compact"] })),
  getChatTree: vi.fn(async (id: string) => ({
    targetChatId: id,
    rootChatId: "original",
    ancestors: [],
    tree: id === "original" ? node("original", { children: treeChildren }) : node(id),
  })),
  getMessages: vi.fn(async (id: string) =>
    id === "original"
      ? [
          { role: "user", type: "text", content: "first question", timestamp: Q1 },
          { role: "assistant", type: "text", content: "first answer", timestamp: A1 },
        ]
      : [
          { role: "user", type: "text", content: "why so?", timestamp: "2026-01-01T11:00:00.000Z" },
          { role: "assistant", type: "text", content: "because of reasons", timestamp: "2026-01-01T11:00:01.000Z" },
        ],
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
vi.mock("../components/PromptInput", async (importOriginal) => {
  const { useState } = await import("react");
  function PromptInputStub({ accessory, chatId }: { accessory?: ReactNode; chatId?: string }) {
    const [text, setText] = useState("");
    return (
      <div data-testid={`composer-${chatId}`}>
        {accessory}
        <input aria-label="Composer" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
    );
  }
  const real = await importOriginal<typeof import("../components/PromptInput")>();
  return { default: PromptInputStub, parseLeadingCommand: real.parseLeadingCommand };
});
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

const page = (entry = "/chat/original") => (
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

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  treeChildren = [
    node("aside-1", { role: "aside", title: "Aside: why so?", forkedAt: A1, asideQuotes: [{ timestamp: A1, role: "assistant", text: "first" }] }),
  ];
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
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("opens the aside from the URL beside the main chat, with a compact bar and no second page header", async () => {
  render(page("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  expect(screen.getByText("first answer")).toBeTruthy();
  expect(within(panel()).getByText("Aside: why so?")).toBeTruthy();
  expect(within(panel()).getByRole("button", { name: "Close aside" })).toBeTruthy();
  // One page header's worth of chrome, the main chat's.
  expect(screen.getAllByTitle("Chat permissions")).toHaveLength(1);
  expect(screen.getAllByRole("radiogroup", { name: "View mode" })).toHaveLength(1);
  // A stop button in each, for each chat's own run.
  expect(screen.getAllByTitle("No active generation")).toHaveLength(2);
  expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("already published"), expect.anything());
});

it("opens from the marker chip, keeps the main chat mounted, and closes back to where it was", async () => {
  render(page());
  await screen.findByText("first answer");
  const [mainComposer] = screen.getAllByLabelText("Composer") as HTMLInputElement[];
  fireEvent.change(mainComposer!, { target: { value: "half-typed" } });

  fireEvent.click(await screen.findByRole("button", { name: "1 aside" }));
  await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  // Not remounted: the composer still holds what was typed.
  expect((screen.getAllByLabelText("Composer")[0] as HTMLInputElement).value).toBe("half-typed");

  fireEvent.click(within(panel()).getByRole("button", { name: "Close aside" }));
  await waitFor(() => expect(location()).toBe("/chat/original"));
  expect(screen.queryByTestId("aside-panel")).toBeNull();
  expect((screen.getAllByLabelText("Composer")[0] as HTMLInputElement).value).toBe("half-typed");
});

it("closes on Escape from inside the panel", async () => {
  render(page("/chat/original?aside=aside-1"));
  const reply = await within(panel()).findByText("because of reasons");
  fireEvent.keyDown(reply, { key: "Escape" });
  await waitFor(() => expect(location()).toBe("/chat/original"));
});

it("opens asides from a mixed marker's menu, while a fork there still navigates", async () => {
  treeChildren = [...treeChildren, node("fork-1", { role: "fork", title: "A fork", forkedAt: A1 })];
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Aside: why so\?/ }));
  await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));

  fireEvent.click(screen.getByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /A fork/ }));
  await waitFor(() => expect(location()).toBe("/chat/fork-1"));
});

it("lists the chat's asides in the header, and opens the one picked", async () => {
  render(page());
  await screen.findByText("first answer");
  fireEvent.click(await screen.findByRole("button", { name: "1 aside in this chat" }));
  const menu = await screen.findByRole("menu", { name: "Asides of this chat" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Aside: why so\?/ }));
  await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
});

it("inserts an aside's reply into the main chat's tray, labelled as the aside's", async () => {
  render(page("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  // Only replies offer it, and only in the panel.
  expect(within(panel()).getAllByRole("button", { name: /Insert into main chat/ })).toHaveLength(1);
  fireEvent.click(within(panel()).getByRole("button", { name: /Insert into main chat/ }));
  expect(getQuotes("original")).toMatchObject([{ text: "because of reasons", fromChatId: "aside-1", label: "Aside reply", messageIndex: -1 }]);
  expect(getQuotes("aside-1")).toHaveLength(0);
  // The main composer's tray shows it; a second click adds nothing.
  await within(screen.getByTestId("composer-original")).findByTestId("quote-chip");
  fireEvent.click(within(panel()).getByRole("button", { name: /Inserted into main chat/ }));
  await within(panel()).findByText("Already in main chat");
  expect(getQuotes("original")).toHaveLength(1);
});

it("offers no Ask as aside inside the panel", async () => {
  render(page("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  // A quote in the aside's own tray shows its chip but no aside controls.
  const reply = within(panel()).getByText("because of reasons");
  const text = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT).nextNode()!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 7);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
  await within(screen.getByTestId("composer-aside-1")).findByTestId("quote-chip");
  expect(within(panel()).queryByRole("button", { name: /Ask as aside/ })).toBeNull();
  window.getSelection()!.removeAllRanges();
});
