/**
 * Select & quote on the real chat page, with real bubbles and the real
 * eligibility rule: text selected in a reply is quoted into the composer's
 * tray, and the next send carries it as a blockquote ahead of what was typed.
 *
 * The tray empties as the message goes out. Whatever way the send then fails
 * — refused outright, no answer at all, or a 409 whose confirmation is
 * cancelled — the quotes come back, and the typed question with them unless
 * something new has been typed since. A slash command goes out as typed and
 * leaves the tray alone. Harness as Chat.rerun.test.tsx, with a composer stub
 * that keeps its text, registers the setter and focus hooks the real one
 * does, and renders the tray it is handed.
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
const S1 = "2026-01-01T10:00:02.000Z";
const focusComposer = vi.fn();
/** The chat's commands as the server lists them; empty is "not loaded yet". */
let chatSlashCommands: string[] = ["compact"];

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
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", async (importOriginal) => {
  const { useEffect, useState } = await import("react");
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
    const [text, setText] = useState("");
    useEffect(() => {
      onFocusRequest?.(() => focusComposer);
    }, [onFocusRequest]);
    useEffect(() => {
      onSetValue?.(() => (value: Update) => setText((cur) => (typeof value === "function" ? value(cur) : value)));
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

type Settled = "ok" | "refuse" | "throw" | "drift" | "uncommitted";
type Reply = Settled | Promise<Settled>;
let replies: Reply[] = [];
const respond = (status: number, body: unknown) => ({ ok: false, status, body: null, json: async () => body });

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
const send = () => fireEvent.click(screen.getByRole("button", { name: "send" }));
const origin = formatQuoteOrigin({ role: "assistant", timestamp: A1 });
const QUOTED = `> **${origin}:**\n> first`;

beforeEach(() => {
  replies = [];
  chatSlashCommands = ["compact"];
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
        const reply = await (replies.shift() ?? "ok");
        if (reply === "refuse") return respond(500, { error: "agent unavailable" });
        if (reply === "throw") throw new TypeError("Failed to fetch");
        if (reply === "drift") return respond(409, { error: "branch_drift", message: "The branch moved." });
        if (reply === "uncommitted") return respond(409, { error: "uncommitted_changes", message: "Dirty tree." });
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

  type("Why?");
  send();

  await waitFor(() => expect(sentPrompts()).toHaveLength(1));
  expect(sentPrompts()[0]).toBe(`${QUOTED}\n\nWhy?`);
  expect(screen.queryByTestId("quote-chip")).toBeNull();
  expect(getQuotes("original")).toHaveLength(0);
});

it("puts the quotes and the typed question back when the send is refused", async () => {
  replies = ["refuse"];
  await quoteFromAnswer();
  type("Why?");
  send();

  await waitFor(() => expect(sentPrompts()).toHaveLength(1));
  expect(await screen.findByTestId("quote-chip")).toBeTruthy();
  expect(getQuotes("original").map((q) => q.text)).toEqual(["first"]);
  expect(composer().value).toBe("Why?");
});

it("puts them back when the request gets no answer at all", async () => {
  replies = ["throw"];
  await quoteFromAnswer();
  type("Why?");
  send();

  await waitFor(() => expect(getQuotes("original")).toHaveLength(1));
  expect(composer().value).toBe("Why?");
});

it("never writes the question back over something typed while the send was pending", async () => {
  let refuse!: () => void;
  replies = [new Promise<"refuse">((resolve) => (refuse = () => resolve("refuse")))];
  await quoteFromAnswer();
  type("Why?");
  send();
  await waitFor(() => expect(sentPrompts()).toHaveLength(1));

  type("something new");
  await act(async () => refuse());

  await waitFor(() => expect(getQuotes("original")).toHaveLength(1));
  expect(composer().value).toBe("something new");
});

it.each([
  ["drift", "Branch Changed", "Continue Anyway"],
  ["uncommitted", "Uncommitted Changes Detected", "Switch Branch Anyway"],
] as const)("a %s 409: Cancel puts the quotes and question back", async (reply, title, _confirm) => {
  replies = [reply];
  await quoteFromAnswer();
  type("Why?");
  send();

  await screen.findByText(title);
  expect(getQuotes("original")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(getQuotes("original").map((q) => q.text)).toEqual(["first"]);
  expect(composer().value).toBe("Why?");
});

it.each([
  ["drift", "Branch Changed", "Continue Anyway"],
  ["uncommitted", "Uncommitted Changes Detected", "Switch Branch Anyway"],
] as const)("a %s 409: the confirmed retry sends the quotes, and its own refusal puts them back", async (reply, title, confirm) => {
  replies = [reply, "refuse"];
  await quoteFromAnswer();
  type("Why?");
  send();

  await screen.findByText(title);
  fireEvent.click(screen.getByRole("button", { name: confirm }));

  await waitFor(() => expect(sentPrompts()).toHaveLength(2));
  expect(sentPrompts()[1]).toBe(`${QUOTED}\n\nWhy?`);
  await waitFor(() => expect(getQuotes("original")).toHaveLength(1));
  expect(composer().value).toBe("Why?");
});

it.each([
  ["drift", "Branch Changed", "Continue Anyway"],
  ["uncommitted", "Uncommitted Changes Detected", "Switch Branch Anyway"],
] as const)("a %s 409: a confirmed retry that goes through leaves the tray and composer empty", async (reply, title, confirm) => {
  let accept!: () => void;
  replies = [reply, new Promise<Settled>((resolve) => (accept = () => resolve("ok")))];
  await quoteFromAnswer();
  type("Why?");
  send();

  await screen.findByText(title);
  fireEvent.click(screen.getByRole("button", { name: confirm }));
  await waitFor(() => expect(sentPrompts()).toHaveLength(2));
  expect(sentPrompts()[1]).toBe(`${QUOTED}\n\nWhy?`);
  // Pending: nothing handed back, so nothing can be sent twice.
  expect(getQuotes("original")).toHaveLength(0);
  expect(composer().value).toBe("");

  await act(async () => accept());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(getQuotes("original")).toHaveLength(0);
  expect(screen.queryByTestId("quote-chip")).toBeNull();
  expect(composer().value).toBe("");
  expect(screen.queryByText(title)).toBeNull();
});

it("treats a command-shaped prompt as a command before the command list has loaded", async () => {
  chatSlashCommands = [];
  await quoteFromAnswer();
  type("/compact keep the API notes");
  send();

  await waitFor(() => expect(sentPrompts()).toEqual(["/compact keep the API notes"]));
  expect(getQuotes("original").map((q) => q.text)).toEqual(["first"]);

  // A path is still prose, list or no list.
  type("/tmp/x is that path");
  send();
  await waitFor(() => expect(sentPrompts()[1]).toBe(`${QUOTED}\n\n/tmp/x is that path`));
});

it("sends a slash command as typed and leaves the tray alone", async () => {
  await quoteFromAnswer();
  type("/compact keep the API notes");
  send();

  await waitFor(() => expect(sentPrompts()).toEqual(["/compact keep the API notes"]));
  expect(getQuotes("original").map((q) => q.text)).toEqual(["first"]);
  expect(screen.getByTestId("quote-chip")).toBeTruthy();
});

it("still quotes text that merely starts with a slash but names no command", async () => {
  await quoteFromAnswer();
  type("/tmp/x is that path");
  send();

  await waitFor(() => expect(sentPrompts()).toEqual([`${QUOTED}\n\n/tmp/x is that path`]));
});

it("Ask quotes the passage and focuses the composer", async () => {
  await quoteFromAnswer("Ask");
  expect(focusComposer).toHaveBeenCalledTimes(1);
});

it("sends the typed text alone, unchanged, with an empty tray", async () => {
  render(tree());
  await screen.findByText("first answer");
  type("Why?");
  send();
  await waitFor(() => expect(sentPrompts()).toEqual(["Why?"]));
});

it("keeps the bubble's metadata line out of a quote whose selection runs into it", async () => {
  render(tree());
  await screen.findByText("first answer");
  const body = firstText(screen.getByText("first answer"));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let modelText: Node | null = null;
  while (!modelText && walker.nextNode()) if (walker.currentNode.textContent!.includes("opus-test-model")) modelText = walker.currentNode;
  selectRange(body, 6, modelText!, 8);
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));

  expect(getQuotes("original").map((q) => q.text)).toEqual(["answer"]);
});

it("offers no bar on a subagent's message, by the real eligibility rule", async () => {
  render(tree());
  await screen.findByText("subagent musing");
  selectIn("subagent musing", 8);
  // Past the settle delay: the bar would be up by now.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
  expect(screen.queryByRole("toolbar")).toBeNull();

  selectIn("first question", 5);
  expect(await screen.findByRole("toolbar")).toBeTruthy();
});
