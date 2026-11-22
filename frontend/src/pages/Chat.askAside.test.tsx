/**
 * Ask as aside on the real chat page: the quote tray's quotes plus the
 * composer's question go to POST /chats/:id/fork as an aside (kind, fork
 * point, quotes, prompt, time zone, chat view, plugins, permissions, harness),
 * and on success the tray and composer are emptied and the aside opens in the
 * side panel beside this chat (`?aside=`), which stays on screen. A refusal leaves both exactly as they were and says why; an older
 * daemon (a plain fork back) is named; a second click while the first is out
 * sends nothing. Harness as Chat.quoteTray.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import Chat from "./Chat";
import { addQuote, getQuotes, resetQuoteTraysForTests } from "../hooks/useQuoteTray";
import { getAsideRecentTarget, getComposerDraft, saveAsideReadOnly, saveAsideRecentTarget, saveComposerDraft } from "../utils/localStorage";
import { getMessages } from "../api";
import { quoteFromAsideReply } from "../utils/messageQuotes";

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
    tree: {
      chatId: id,
      title: "Work",
      provider: "claude-code",
      status: "stopped",
      folder: "/tmp",
      createdAt: "",
      updatedAt: "",
      // Once the daemon has made it, the aside is in its parent's tree — what the panel waits for.
      children:
        id === "original" && created.has("aside-1")
          ? [
              {
                chatId: "aside-1",
                title: "Aside: Why?",
                role: "aside",
                provider: "claude-code",
                status: "ongoing",
                folder: "/tmp",
                createdAt: "",
                updatedAt: "",
                children: [],
              },
            ]
          : [],
    },
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
/** Chats the session registry reports as running, and attachments in the stub composer. */
/** Asides the stubbed daemon has created, which its trees then list. */
const created = vi.hoisted(() => new Set<string>());
const composerState = vi.hoisted(() => ({ files: [] as File[], active: new Set<string>() }));
vi.mock("../contexts/SessionContext", () => ({
  useIsSessionActive: (id?: string) => (id && composerState.active.has(id) ? { startedAt: 1 } : null),
  useMetadataVersion: () => 0,
}));
vi.mock("../components/PromptInput", async (importOriginal) => {
  const { useEffect, useRef, useState } = await import("react");
  type Update = string | ((current: string) => string);
  function PromptInputStub({
    onSend,
    accessory,
    onFocusRequest,
    onSetValue,
    onSnapshotRequest,
    onRemoveImages,
    sendBlockedReason,
    onCommandLeadChange,
    isCommandPrompt,
    sendVariants,
    onSendVariant,
  }: {
    onSend: (prompt: string) => void;
    sendVariants?: { aside?: { enabled: boolean; reason?: string } };
    onSendVariant?: (variant: "aside", prompt: string, files: File[]) => Promise<void>;
    accessory?: ReactNode;
    onFocusRequest?: (focus: (() => void) | null) => void;
    onSetValue?: (setter: (value: Update) => void) => void;
    onSnapshotRequest?: (get: (() => { prompt: string; attachments: number; files: File[] }) | null) => void;
    onRemoveImages?: (remove: (files: File[]) => void) => void;
    sendBlockedReason?: string;
    onCommandLeadChange?: (leads: boolean) => void;
    isCommandPrompt?: (prompt: string) => boolean;
  }) {
    const [text, setTextState] = useState("");
    // Like the real composer, an updater is resolved at the moment of the call,
    // against the live value — Ask as aside reads the question that way.
    const liveRef = useRef("");
    const setText = (next: string) => {
      liveRef.current = next;
      setTextState(next);
    };
    useEffect(() => {
      onFocusRequest?.(() => focusComposer);
    }, [onFocusRequest]);
    useEffect(() => {
      onSetValue?.(() => (value: Update) => setText(typeof value === "function" ? value(liveRef.current) : value));
    }, [onSetValue]);
    useEffect(() => {
      // Trimmed, as the real composer composes the prompt it would send.
      onSnapshotRequest?.(() => ({ prompt: liveRef.current.trim(), attachments: composerState.files.length, files: [...composerState.files] }));
      return () => onSnapshotRequest?.(null);
    }, [onSnapshotRequest]);
    useEffect(() => {
      onRemoveImages?.(() => (files: File[]) => {
        composerState.files = composerState.files.filter((file) => !files.includes(file));
      });
    }, [onRemoveImages]);
    useEffect(() => {
      onCommandLeadChange?.(isCommandPrompt?.(text) ?? false);
    }, [text, isCommandPrompt, onCommandLeadChange]);
    return (
      <div>
        {accessory}
        <input aria-label="Composer" value={text} onChange={(e) => setText(e.target.value)} />
        {sendBlockedReason && <div data-testid="send-blocked">{sendBlockedReason}</div>}
        <button
          type="button"
          onClick={() => {
            onSend(text);
            setText("");
          }}
        >
          send
        </button>
        {/* The send menu's aside row, as the real composer runs it: the
            prompt and files handed over, the clearing left to the page. */}
        {sendVariants?.aside && (
          <button
            type="button"
            disabled={!sendVariants.aside.enabled}
            title={sendVariants.aside.reason}
            onClick={() => void onSendVariant!("aside", liveRef.current.trim(), [...composerState.files])}
          >
            send as aside
          </button>
        )}
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

/** The main chat's composer: once the aside panel opens, the aside's own composer is the second. */
const composer = () => screen.getAllByLabelText("Composer")[0] as HTMLInputElement;
const type = (value: string) => fireEvent.change(composer(), { target: { value } });

function LocationProbe() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return (
    <>
      <div data-testid="location">{pathname + search}</div>
      <button type="button" onClick={() => navigate("/chat/other")}>
        go elsewhere
      </button>
    </>
  );
}

/** "oldNoImages": a daemon before attachments, which ignores them; "oldUnstarted": the same with no question, so it starts nothing. */
type ForkReply = "ok" | "refuse" | "refuseTarget" | "old" | "runError" | "oldNoImages" | "oldUnstarted" | Promise<"ok">;
/** How the stubbed upload route answers: every file stored, or one refused. */
let uploadReply: "ok" | "partial" = "ok";
const uploads = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === "/api/images/upload" && init?.method === "POST");
let forkReplies: ForkReply[] = [];
const forkBodies = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => String(url) === "/api/chats/original/fork" && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init!.body)));
const askButton = () => screen.getByRole("button", { name: /Ask as aside|Asking/ });

beforeEach(() => {
  forkReplies = [];
  created.clear();
  composerState.files = [];
  uploadReply = "ok";
  composerState.active = new Set();
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
        if (reply === "refuseTarget")
          return { ok: false, status: 400, json: async () => ({ error: 'Unknown target provider "nope"', code: "fork_target_invalid" }) };
        const chatRole = reply === "old" ? "fork" : "aside";
        if (chatRole === "aside") created.add("aside-1");
        const title = reply === "old" ? "Fork: Work" : "Aside: Why?";
        const outcome =
          reply === "runError"
            ? { runError: "engine down", promptText: "> **Assistant:**\n> first\n\nWhy?" }
            : reply === "oldUnstarted"
              ? {}
              : { started: true };
        // A current daemon counts the attachments it took; an older one ignores them.
        const sentImages = (JSON.parse(String(init.body)).imageIds ?? []) as string[];
        const attached = sentImages.length > 0 && reply !== "oldNoImages" && reply !== "oldUnstarted" ? { attachedImages: sentImages.length } : {};
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: "aside-1", folder: "/tmp", metadata: JSON.stringify({ chatRole, title }), ...outcome, ...attached }),
        };
      }
      if (url === "/api/images/upload" && init?.method === "POST") {
        const files = (init.body as FormData).getAll("images") as File[];
        const stored = (uploadReply === "partial" ? files.slice(1) : files).map((file, i) => ({ id: `img-${i}`, originalName: file.name }));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: uploadReply === "ok", images: stored, ...(uploadReply === "partial" && { errors: ["too big"] }) }),
        };
      }
      if (url === "/api/chats/aside-1/stream") {
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

async function quoteAndType(question: string) {
  render(tree());
  await screen.findByText("first answer");
  selectIn("first answer", 5);
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
  await screen.findByTestId("quote-chip");
  type(question);
}

it("creates the aside from the tray and the composer, empties both, and opens it in the panel", async () => {
  await quoteAndType("Why?");
  fireEvent.click(askButton());

  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(screen.getByTestId("aside-panel")).toBeTruthy();
  // The main chat is still on screen beside it.
  expect(screen.getAllByText("first answer").length).toBeGreaterThan(0);
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
  expect(getComposerDraft("original")).toBe("");
  expect(composer().value).toBe("");
});

it("sends Read only and an explicit harness and model", async () => {
  await quoteAndType("Why?");
  fireEvent.click(screen.getByRole("button", { name: "Read only" }));
  fireEvent.change(screen.getByLabelText("Aside harness"), { target: { value: "codex" } });
  fireEvent.change(screen.getByLabelText("Aside model"), { target: { value: "gpt-x" } });
  fireEvent.click(askButton());

  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  // Read only is the daemon's to apply (caps, no model reviewer): sent as a flag.
  expect(forkBodies()[0]).toMatchObject({ readOnly: true, provider: "codex", model: "gpt-x" });
  expect(forkBodies()[0]).not.toHaveProperty("permissions");
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
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(forkBodies()).toHaveLength(1);
});

it("asks for a question before sending anything", async () => {
  await quoteAndType("   ");
  fireEvent.click(askButton());
  expect((await screen.findByRole("alert")).textContent).toMatch(/Type your question/);
  expect(focusComposer).toHaveBeenCalled();
  expect(forkBodies()).toHaveLength(0);
});

it("blocks the composer's own send while the aside is out", async () => {
  let release!: () => void;
  forkReplies = [new Promise<"ok">((resolve) => (release = () => resolve("ok")))];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  expect((await screen.findByTestId("send-blocked")).textContent).toMatch(/Asking the aside/);
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/chats/original/message")).toBe(false);
  await act(async () => release());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
});

it("does not pull the user back from another chat, nor show the request there", async () => {
  let release!: () => void;
  forkReplies = [new Promise<"ok">((resolve) => (release = () => resolve("ok")))];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  await screen.findByRole("button", { name: "Asking…" });

  // Move on, with a quote waiting in the other chat's tray.
  addQuote("other", { id: "q-other", messageIndex: 1, timestamp: A1, role: "assistant", text: "elsewhere" });
  fireEvent.click(screen.getByRole("button", { name: "go elsewhere" }));
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/other"));
  expect(await screen.findByRole("button", { name: "Ask as aside" })).toHaveProperty("disabled", false);
  expect(screen.queryByTestId("send-blocked")).toBeNull();

  // The draft the original chat's composer saved, with a trailing newline.
  saveComposerDraft("original", "Why?\n");
  await act(async () => release());
  await waitFor(() => expect(getQuotes("original")).toHaveLength(0));
  expect(screen.getByTestId("location").textContent).toBe("/chat/other");
  expect(getComposerDraft("original")).toBe("");
});

const file = (name: string) => new File(["x"], name, { type: "image/png" });

it("uploads the composer's attachments and sends them with the aside, then takes them out of the composer", async () => {
  const [a, b] = [file("a.png"), file("b.png")];
  composerState.files = [a, b];
  await quoteAndType("What is this?");
  fireEvent.click(askButton());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(uploads()).toHaveLength(1);
  expect(forkBodies()[0]).toMatchObject({ timestamp: A1, prompt: "What is this?", imageIds: ["img-0", "img-1"] });
  expect(composerState.files).toEqual([]);
  expect(composer().value).toBe("");
});

it("asks with attachments and no question", async () => {
  composerState.files = [file("a.png")];
  await quoteAndType("");
  fireEvent.click(askButton());
  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  expect(forkBodies()[0]).toMatchObject({ quotes: [{ timestamp: A1, role: "assistant", text: "first" }], imageIds: ["img-0"] });
  expect(forkBodies()[0]).not.toHaveProperty("prompt");
});

it("sends nothing, and keeps everything, when an attachment does not upload", async () => {
  uploadReply = "partial";
  const files = [file("a.png"), file("b.png")];
  composerState.files = [...files];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  expect((await screen.findByRole("alert")).textContent).toMatch(/too big/);
  expect(forkBodies()).toHaveLength(0);
  expect(composerState.files).toEqual(files);
  expect(getQuotes("original")).toHaveLength(1);
  expect(composer().value).toBe("Why?");
});

it("says nothing was asked when an older daemon dropped the attachments of an aside with no question", async () => {
  // A daemon before attachments starts no turn without a prompt: the aside exists, empty.
  forkReplies = ["oldUnstarted"];
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  const a = file("a.png");
  composerState.files = [a];
  await quoteAndType("");
  fireEvent.click(askButton());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(forkBodies()[0]).toMatchObject({ imageIds: ["img-0"] });
  expect(forkBodies()[0]).not.toHaveProperty("prompt");
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls[0]![0]).toMatch(/created, but nothing was sent in it/);
  expect(alert.mock.calls[0]![0]).not.toMatch(/was asked/);
  expect(composerState.files).toEqual([a]);
});

it("takes the sent attachments out of the composer even after the user moved to another chat", async () => {
  // The composer is not per chat: its attachments go wherever it goes, and
  // would be sent again from the next chat.
  let release!: () => void;
  forkReplies = [new Promise<"ok">((resolve) => (release = () => resolve("ok")))];
  const [a, b] = [file("a.png"), file("b.png")];
  composerState.files = [a];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  await screen.findByRole("button", { name: "Asking…" });
  fireEvent.click(screen.getByRole("button", { name: "go elsewhere" }));
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/other"));
  // Attached in the other chat while the aside was out: stays.
  composerState.files = [...composerState.files, b];
  await act(async () => release());
  await waitFor(() => expect(composerState.files).toEqual([b]));
  expect(forkBodies()[0]).toMatchObject({ imageIds: ["img-0"] });
  expect(screen.getByTestId("location").textContent).toBe("/chat/other");
});

it("says so, and keeps the attachments, when an older daemon dropped them", async () => {
  forkReplies = ["oldNoImages"];
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  const a = file("a.png");
  composerState.files = [a];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(alert).toHaveBeenCalledWith(expect.stringMatching(/too old for attachments/));
  // The question went; the files it could not take did not.
  expect(composer().value).toBe("");
  expect(composerState.files).toEqual([a]);
});

it("passes a system message's quote through as system", async () => {
  await quoteAndType("Why?");
  // A system quote in the tray, as PR 1 can make from a system text message.
  addQuote("original", { id: "q-sys", messageIndex: 0, timestamp: Q1, role: "system", text: "notice" });
  fireEvent.click(askButton());
  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  expect(forkBodies()[0].quotes).toEqual([
    { timestamp: A1, role: "assistant", text: "first" },
    { timestamp: Q1, role: "system", text: "notice" },
  ]);
});

it("reads the aside's transcript once on attaching to its stream", async () => {
  composerState.active = new Set(["aside-1"]);
  await quoteAndType("Why?");
  const before = vi.mocked(getMessages).mock.calls.filter(([id]) => id === "aside-1").length;
  fireEvent.click(askButton());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/chats/aside-1/stream")).toBe(true));
  // The page's own load, plus the read on attach.
  await waitFor(() => expect(vi.mocked(getMessages).mock.calls.filter(([id]) => id === "aside-1").length - before).toBe(2));
});

it("keeps an aside whose question could not be sent, with the text in its composer", async () => {
  forkReplies = ["runError"];
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("engine down"));
  expect(getComposerDraft("aside-1")).toBe("> **Assistant:**\n> first\n\nWhy?");
  expect(getQuotes("original")).toHaveLength(0);
});

it("empties the composer when the question had trailing whitespace", async () => {
  await quoteAndType("Why?  \n");
  fireEvent.click(askButton());
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(forkBodies()[0].prompt).toBe("Why?");
  expect(composer().value).toBe("");
});

it("is disabled, with the reason, while the composer leads with a slash command", async () => {
  await quoteAndType("/compact keep the tests");
  await waitFor(() => expect(askButton()).toHaveProperty("disabled", true));
  expect(screen.getByText(/slash command runs in this chat/)).toBeTruthy();
  fireEvent.click(askButton());
  expect(forkBodies()).toHaveLength(0);

  type("Why?");
  await waitFor(() => expect(askButton()).toHaveProperty("disabled", false));
});

it("forgets the remembered harness only when the daemon refuses that target", async () => {
  saveAsideRecentTarget({ provider: "codex", model: "gpt-x" });
  forkReplies = ["refuse"];
  await quoteAndType("Why?");
  fireEvent.click(screen.getByRole("button", { name: "Codex · gpt-x" }));
  fireEvent.click(askButton());
  await screen.findByRole("alert");
  // A quote problem says nothing about the harness.
  expect(getAsideRecentTarget()).toEqual({ provider: "codex", model: "gpt-x" });

  forkReplies = ["refuseTarget"];
  fireEvent.click(askButton());
  await waitFor(() => expect(getAsideRecentTarget()).toBeNull());
});

it("names the plain fork an older daemon made, so it can be deleted", async () => {
  forkReplies = ["old"];
  await quoteAndType("Why?");
  fireEvent.click(askButton());
  expect((await screen.findByRole("alert")).textContent).toMatch(/created an ordinary fork instead \(not started\), “Fork: Work”, which you can delete/);
});

it("leaves out, and keeps in the tray, a passage inserted from an aside", async () => {
  await quoteAndType("Why?");
  act(() => {
    addQuote("original", quoteFromAsideReply({ role: "assistant", type: "text", content: "aside says", timestamp: "2026-01-01T12:00:00.000Z" }, "aside-0")!);
  });
  fireEvent.click(askButton());
  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  expect(forkBodies()[0]).toMatchObject({ timestamp: A1, quotes: [{ timestamp: A1, role: "assistant", text: "first" }] });
  await waitFor(() => expect(getQuotes("original").map((q) => q.text)).toEqual(["aside says"]));
});

it("says why when the tray holds only passages inserted from an aside", async () => {
  render(tree());
  await screen.findByText("first answer");
  act(() => {
    addQuote("original", quoteFromAsideReply({ role: "assistant", type: "text", content: "aside says", timestamp: "2026-01-01T12:00:00.000Z" }, "aside-0")!);
  });
  type("Why?");
  fireEvent.click(askButton());
  expect((await screen.findByRole("alert")).textContent).toMatch(/inserted from an aside/);
  expect(forkBodies()).toHaveLength(0);
});

it("sends which repeat of a passage was selected, so the highlight lands on it", async () => {
  const usual = vi.mocked(getMessages).getMockImplementation()!;
  onTestFinished(() => {
    vi.mocked(getMessages).mockImplementation(usual);
  });
  vi.mocked(getMessages).mockImplementation(async (id: string) =>
    id === "original"
      ? [
          { role: "user", type: "text", content: "first question", timestamp: Q1 },
          { role: "assistant", type: "text", content: "again and again", timestamp: A1 },
        ]
      : [],
  );
  render(tree());
  await screen.findByText("again and again");
  // The second "again".
  const node = firstText(screen.getByText("again and again"));
  selectRange(node, 10, node, 15);
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
  await screen.findByTestId("quote-chip");
  type("Why twice?");
  fireEvent.click(askButton());
  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  expect(forkBodies()[0].quotes).toEqual([{ timestamp: A1, role: "assistant", text: "again", occurrence: 1 }]);
});

it("counts the occurrence across one turn's blocks: the LGTM in block B is the turn's second", async () => {
  const usual = vi.mocked(getMessages).getMockImplementation()!;
  onTestFinished(() => {
    vi.mocked(getMessages).mockImplementation(usual);
  });
  vi.mocked(getMessages).mockImplementation(async (id: string) =>
    id === "original"
      ? [
          { role: "user", type: "text", content: "first question", timestamp: Q1 },
          { role: "assistant", type: "text", content: "LGTM, one nit", timestamp: A1 },
          { role: "assistant", type: "text", content: "Then LGTM", timestamp: A1 },
        ]
      : [],
  );
  render(tree());
  const blockB = await screen.findByText("Then LGTM");
  const node = firstText(blockB);
  selectRange(node, 5, node, 9);
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
  await screen.findByTestId("quote-chip");
  type("Which one?");
  fireEvent.click(askButton());
  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  expect(forkBodies()[0].quotes).toEqual([{ timestamp: A1, role: "assistant", text: "LGTM", occurrence: 1 }]);
});

// ── Send as aside from the composer's send menu ─────────────────────────────

const sendAsAside = () => screen.getAllByRole("button", { name: "send as aside" })[0];

it("sends as aside from the composer with no quotes: forks at the latest message, with the attachments", async () => {
  const file = new File(["x"], "shot.png", { type: "image/png" });
  composerState.files = [file];
  render(tree());
  await screen.findByText("first answer");
  type("What next?");
  fireEvent.click(sendAsAside());

  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/original?aside=aside-1"));
  expect(uploads()).toHaveLength(1);
  const [body] = forkBodies();
  // No quotes and no timestamp: the daemon picks the fork point.
  expect(body).toEqual({
    kind: "aside",
    forkAtLatest: true,
    prompt: "What next?",
    imageIds: ["img-0"],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  expect(composer().value).toBe("");
  expect(composerState.files).toEqual([]);
});

it("uses the remembered Read only, and the tray's quotes when there are some", async () => {
  saveAsideReadOnly(true);
  await quoteAndType("Why?");
  fireEvent.click(sendAsAside());
  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  const [body] = forkBodies();
  expect(body.quotes).toEqual([{ timestamp: A1, role: "assistant", text: "first" }]);
  expect(body.timestamp).toBe(A1);
  expect(body.forkAtLatest).toBeUndefined();
  expect(body.readOnly).toBe(true);
  expect(getQuotes("original")).toHaveLength(0);
});

it("keeps the question and the attachments when a composer aside is refused", async () => {
  forkReplies = ["refuse"];
  const file = new File(["x"], "shot.png", { type: "image/png" });
  composerState.files = [file];
  render(tree());
  await screen.findByText("first answer");
  type("What next?");
  fireEvent.click(sendAsAside());
  await screen.findByText(/quotes\[0\] is after the fork point/);
  expect(composer().value).toBe("What next?");
  expect(composerState.files).toEqual([file]);
});

it("keeps the attachments, and clears the question, when an older daemon dropped them", async () => {
  forkReplies = ["oldNoImages"];
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  const file = new File(["x"], "shot.png", { type: "image/png" });
  composerState.files = [file];
  render(tree());
  await screen.findByText("first answer");
  type("What next?");
  fireEvent.click(sendAsAside());
  await waitFor(() => expect(alert).toHaveBeenCalled());
  await waitFor(() => expect(composer().value).toBe(""));
  expect(composerState.files).toEqual([file]);
});

it("offers Send as aside disabled, with the reason, while a slash command leads the composer", async () => {
  render(tree());
  await screen.findByText("first answer");
  expect((sendAsAside() as HTMLButtonElement).disabled).toBe(false);
  type("/compact now");
  await waitFor(() => expect((sendAsAside() as HTMLButtonElement).disabled).toBe(true));
  expect(sendAsAside().getAttribute("title")).toMatch(/slash command runs in this chat/);
});

it("does not offer Send as aside on a chat with no messages yet", async () => {
  vi.mocked(getMessages).mockResolvedValueOnce([]);
  render(tree());
  await waitFor(() => expect(vi.mocked(getMessages)).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "send as aside" })).toBeNull();
});

it("clears the sending chat's stored draft, not the composer, when the user has moved on", async () => {
  let release!: () => void;
  forkReplies = [new Promise<"ok">((resolve) => (release = () => resolve("ok")))];
  render(tree());
  await screen.findByText("first answer");
  type("What next?");
  fireEvent.click(sendAsAside());
  await waitFor(() => expect(forkBodies()).toHaveLength(1));
  saveComposerDraft("original", "What next?");
  fireEvent.click(screen.getByRole("button", { name: "go elsewhere" }));
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/chat/other"));
  await act(async () => release());
  await waitFor(() => expect(getComposerDraft("original")).toBe(""));
  // Not pulled back to it.
  expect(screen.getByTestId("location").textContent).toBe("/chat/other");
});
