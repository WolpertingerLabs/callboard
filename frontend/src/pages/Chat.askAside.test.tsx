/**
 * Ask as aside on the real chat page: the quote tray's quotes plus the
 * composer's question go to POST /chats/:id/fork as an aside (kind, fork
 * point, quotes, prompt, time zone, chat view, plugins, permissions, harness),
 * and on success the tray and composer are emptied and the page goes to the
 * aside. A refusal leaves both exactly as they were and says why; an older
 * daemon (a plain fork back) is named; a second click while the first is out
 * sends nothing. Harness as Chat.quoteTray.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import Chat from "./Chat";
import { getQuotes, resetQuoteTraysForTests } from "../hooks/useQuoteTray";

const Q1 = "2026-01-01T10:00:00.000Z";
const A1 = "2026-01-01T10:00:01.000Z";
const S1 = "2026-01-01T10:00:02.000Z";
const focusComposer = vi.fn();
/** The chat's commands as the chat record lists them. */
const chatSlashCommands: string[] = ["compact"];
/** Whether the separate command fetch (used when the record lists none) ever answers. */
const commandFetchHangs = false;

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Work", folder: "/tmp", is_git_repo: true, metadata: "{}", slash_commands: chatSlashCommands })),
  getChatTree: vi.fn(async (id: string) => ({
    targetChatId: id,
    rootChatId: id,
    ancestors: [],
    tree: { chatId: id, title: "Work", provider: "claude-code", status: "stopped", folder: "/tmp", createdAt: "", updatedAt: "", children: [] },
  })),
  getMessages: vi.fn(async () => [
    { role: "user", type: "text", content: "first question", timestamp: Q1 },
    { role: "assistant", type: "text", content: "first answer", timestamp: A1, model: "opus-test-model" },
    { role: "assistant", type: "text", content: "subagent musing", timestamp: S1, teamName: "helper" },
  ]),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(() => (commandFetchHangs ? new Promise(() => {}) : Promise.resolve({ slashCommands: [], plugins: [] }))),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", async (importOriginal) => {
  const { useEffect, useRef, useState } = await import("react");
  type Update = string | ((current: string) => string);
  function PromptInputStub({
    onSend,
    accessory,
    onFocusRequest,
    onSetValue,
  }: {
    onSend: (prompt: string) => void;
    accessory?: ReactNode;
    onFocusRequest?: (focus: (() => void) | null) => void;
    onSetValue?: (setter: (value: Update) => void) => void;
  }) {
    const [text, setTextState] = useState("");
    // Like the real composer, an updater is resolved at the moment of the call,
    // against the live value — Ask as aside reads the question that way.
    const live = useRef("");
    const setText = (next: string) => {
      live.current = next;
      setTextState(next);
    };
    useEffect(() => {
      onFocusRequest?.(() => focusComposer);
    }, [onFocusRequest]);
    useEffect(() => {
      onSetValue?.(() => (value: Update) => setText(typeof value === "function" ? value(live.current) : value));
    }, [onSetValue]);
    return (
      <div>
        {accessory}
        <input aria-label="Composer" value={text} onChange={(e) => setText(e.target.value)} />
        <button
          type="button"
          onClick={() => {
            onSend(text);
            setText("");
          }}
        >
          send
        </button>
      </div>
    );
  }
  const real = await importOriginal<typeof import("../components/PromptInput")>();
  return { default: PromptInputStub, parseLeadingCommand: real.parseLeadingCommand };
});
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

const tree = () => (
  <MemoryRouter initialEntries={["/chat/original"]}>
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

const firstText = (el: Element) => document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;

function selectRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

/** Select the first `length` characters of the text node holding `text`, as a user would. */
function selectIn(text: string, length: number) {
  const node = firstText(screen.getByText(text));
  selectRange(node, 0, node, length);
}

const composer = () => screen.getByLabelText("Composer") as HTMLInputElement;
const type = (value: string) => fireEvent.change(composer(), { target: { value } });

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

type ForkReply = "ok" | "refuse" | "old" | Promise<"ok">;
let forkReplies: ForkReply[] = [];
const forkBodies = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => String(url) === "/api/chats/original/fork" && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init!.body)));
const askButton = () => screen.getByRole("button", { name: /Ask as aside|Asking/ });

beforeEach(() => {
  forkReplies = [];
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
      if (url === "/api/chats/original/fork" && init?.method === "POST") {
        const reply = await (forkReplies.shift() ?? "ok");
        if (reply === "refuse") return { ok: false, status: 400, json: async () => ({ error: "quotes[0] is after the fork point" }) };
        const chatRole = reply === "old" ? "fork" : "aside";
        return { ok: true, status: 201, json: async () => ({ id: "aside-1", folder: "/tmp", metadata: JSON.stringify({ chatRole }), started: true }) };
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

async function quoteAndType(question: string) {
  render(tree());
  await screen.findByText("first answer");
  selectIn("first answer", 5);
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
  await screen.findByTestId("quote-chip");
  type(question);
}

it("creates the aside from the tray and the composer, empties both, and opens it", async () => {
  await quoteAndType("Why?");
  fireEvent.click(askButton());

  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/aside-1"));
  expect(forkBodies()).toEqual([
    {
      timestamp: A1,
      kind: "aside",
      quotes: [{ timestamp: A1, role: "assistant", text: "first" }],
      prompt: "Why?",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  ]);
  expect(getQuotes("original")).toHaveLength(0);
});

it("sends Read only and an explicit harness and model", async () => {
  await quoteAndType("Why?");
  fireEvent.click(screen.getByRole("button", { name: "Read only" }));
  fireEvent.change(screen.getByLabelText("Aside harness"), { target: { value: "codex" } });
  fireEvent.change(screen.getByLabelText("Aside model"), { target: { value: "gpt-x" } });
  fireEvent.click(askButton());

  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  expect(forkBodies()[0]).toMatchObject({ permissions: { fileWrite: "ask", codeExecution: "ask" }, provider: "codex", model: "gpt-x" });
});

it("leaves the tray and the question in place when the aside is refused, and says why", async () => {
  forkReplies = ["refuse"];
  await quoteAndType("Why?");
  fireEvent.click(askButton());

  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("after the fork point"));
  expect(getQuotes("original").map((q) => q.text)).toEqual(["first"]);
  expect(composer().value).toBe("Why?");
  expect(screen.getByTestId("location").textContent).toBe("/chat/original");
});

it("names an older daemon that made a plain fork", async () => {
  forkReplies = ["old"];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  expect((await screen.findByRole("alert")).textContent).toMatch(/too old for asides/);
  expect(getQuotes("original")).toHaveLength(1);
});

it("sends one request for a double click, and is disabled while it is out", async () => {
  let release!: () => void;
  forkReplies = [new Promise<"ok">((resolve) => (release = () => resolve("ok")))];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  fireEvent.click(askButton());
  await waitFor(() => expect(askButton()).toHaveProperty("disabled", true));
  fireEvent.click(askButton());
  expect(forkBodies()).toHaveLength(1);
  await act(async () => release());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/aside-1"));
  expect(forkBodies()).toHaveLength(1);
});

it("asks for a question before sending anything", async () => {
  await quoteAndType("   ");
  fireEvent.click(askButton());
  expect((await screen.findByRole("alert")).textContent).toMatch(/Type your question/);
  expect(focusComposer).toHaveBeenCalled();
  expect(forkBodies()).toHaveLength(0);
});
