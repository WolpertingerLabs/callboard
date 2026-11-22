/**
 * Enqueue Send on the real chat page: while the chat has a live web run, the
 * composer's enqueue variant holds the message on the daemon
 * (POST /chats/:id/held) — tray quotes folded in, attachments uploaded, the
 * composer and tray cleared by the page once it is held — and the held list
 * shows at the end of the transcript. A run that already ended falls back to
 * a normal send; an older daemon is named and nothing is touched. Send now,
 * Edit and Remove act on the daemon's list; a message already sent is said
 * so. The list follows `metadataVersion` bumps. Harness as
 * Chat.askAside.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import type { HeldMessage } from "shared/types/index.js";
import Chat from "./Chat";
import { addQuote, getQuotes, resetQuoteTraysForTests } from "../hooks/useQuoteTray";
import { getActivity } from "../api";

const Q1 = "2026-01-01T10:00:00.000Z";
const A1 = "2026-01-01T10:00:01.000Z";

const state = vi.hoisted(() => ({
  files: [] as File[],
  running: true,
  metadataVersion: 0,
  held: [] as HeldMessage[],
}));

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Work", folder: "/tmp", is_git_repo: true, metadata: "{}", slash_commands: ["compact"] })),
  getChatTree: vi.fn(async (id: string) => ({
    targetChatId: id,
    rootChatId: id,
    ancestors: [],
    tree: { chatId: id, title: "Work", provider: "claude-code", status: "ongoing", folder: "/tmp", createdAt: "", updatedAt: "", children: [] },
  })),
  getMessages: vi.fn(async () => [
    { role: "user", type: "text", content: "first question", timestamp: Q1 },
    { role: "assistant", type: "text", content: "first answer", timestamp: A1 },
  ]),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0, heldMessages: state.held })),
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
  useIsSessionActive: (id?: string) => (id && state.running ? { type: "web", startedAt: 1 } : null),
  useMetadataVersion: () => state.metadataVersion,
}));
vi.mock("../components/PromptInput", async (importOriginal) => {
  const { useEffect, useRef, useState } = await import("react");
  type Update = string | ((current: string) => string);
  type Variants = { enqueue?: { enabled: boolean }; aside?: { enabled: boolean } };
  function PromptInputStub({
    onSend,
    accessory,
    onSetValue,
    onAddImages,
    onRemoveImages,
    sendVariants,
    onSendVariant,
  }: {
    onSend: (prompt: string, images?: File[]) => void;
    sendVariants?: Variants;
    onSendVariant?: (variant: "enqueue" | "aside", prompt: string, files: File[]) => Promise<void>;
    accessory?: ReactNode;
    onSetValue?: (setter: (value: Update) => void) => void;
    onAddImages?: (add: (files: File[]) => void) => void;
    onRemoveImages?: (remove: (files: File[]) => void) => void;
  }) {
    const [text, setTextState] = useState("");
    const liveRef = useRef("");
    const setText = (next: string) => {
      liveRef.current = next;
      setTextState(next);
    };
    useEffect(() => {
      onSetValue?.(() => (value: Update) => setText(typeof value === "function" ? value(liveRef.current) : value));
    }, [onSetValue]);
    useEffect(() => {
      onAddImages?.(() => (files: File[]) => {
        state.files = [...state.files, ...files];
      });
    }, [onAddImages]);
    useEffect(() => {
      onRemoveImages?.(() => (files: File[]) => {
        state.files = state.files.filter((file) => !files.includes(file));
      });
    }, [onRemoveImages]);
    return (
      <div>
        {accessory}
        <textarea aria-label="Composer" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" onClick={() => (onSend(text), setText(""))}>
          send
        </button>
        {/* The send menu's Enqueue Send row, as the real composer runs it. */}
        {sendVariants?.enqueue && (
          <button type="button" onClick={() => void onSendVariant!("enqueue", liveRef.current.trim(), [...state.files])}>
            enqueue send
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

const held = (id: string, extra: Partial<HeldMessage> = {}): HeldMessage => ({
  id,
  chatId: "original",
  text: `held ${id}`,
  createdAt: "2026-11-22T10:00:00.000Z",
  state: "queued",
  ...extra,
});

/** `reject`: the request never gets an answer (a network error). */
type Reply = { status: number; body?: unknown; text?: string; reject?: boolean };
/** Per-route queued replies; an empty queue answers with the route's default. */
let replies: Record<string, Reply[]> = {};
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const calls = (path: string, method = "POST") =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? "GET") === method)
    .map(([, init]) => (init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body));

const composer = () => screen.getByLabelText("Composer") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(composer(), { target: { value } });
const file = (name: string) => new File(["x"], name, { type: "image/png" });
const heldCards = () => screen.queryAllByRole("article", { name: /^Held message \d+ of \d+$/ });

beforeEach(() => {
  state.files = [];
  state.running = true;
  state.metadataVersion = 0;
  state.held = [];
  replies = {};
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
      const method = init?.method ?? "GET";
      const queued = replies[`${method} ${url}`]?.shift();
      if (queued) {
        if (queued.reject) throw new TypeError("Failed to fetch");
        if (queued.text !== undefined) return { ok: false, status: queued.status, json: async () => JSON.parse(queued.text!), text: async () => queued.text };
        return json(queued.status, queued.body);
      }
      if (url === "/api/chats/original/stream" || (url === "/api/chats/original/message" && method === "POST")) {
        // A run that is still going: a stream that stays open.
        return { ok: true, status: 200, body: new ReadableStream({ start() {} }), json: async () => ({}) };
      }
      if (url === "/api/chats/original/held" && method === "POST") {
        const body = JSON.parse(String(init!.body));
        const item = held("h-new", { text: body.text, ...(body.images && { images: body.images }) });
        state.held = [...state.held, item];
        return json(201, { heldMessage: item, heldMessages: state.held });
      }
      if (url === "/api/images/upload" && method === "POST") {
        const files = (init!.body as FormData).getAll("images") as File[];
        return json(200, { success: true, images: files.map((f, i) => ({ id: `img-${i}`, originalName: f.name })) });
      }
      const take = /^\/api\/chats\/original\/held\/([^/]+)\/take$/.exec(url);
      if (take && method === "POST") {
        const item = state.held.find((h) => h.id === take[1]);
        if (!item) return json(404, { error: "Held message not found", code: "not_found" });
        state.held = state.held.filter((h) => h !== item);
        return json(200, { heldMessage: item });
      }
      const del = /^\/api\/chats\/original\/held\/([^/]+)$/.exec(url);
      if (del && method === "DELETE") {
        state.held = state.held.filter((h) => h.id !== del[1]);
        return json(200, { heldMessages: state.held });
      }
      if (url === "/api/images/img-1") return { ok: true, status: 200, blob: async () => new Blob(["x"], { type: "image/png" }) };
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const tree = () => (
  <MemoryRouter initialEntries={["/chat/original"]}>
    <Routes>
      <Route path="/chat/:id" element={<Chat />} />
    </Routes>
  </MemoryRouter>
);

async function open() {
  const view = render(tree());
  await screen.findByText("first answer");
  return view;
}

it("holds the message while the run is going: quotes folded, attachments uploaded, composer and tray cleared, list shown", async () => {
  await open();
  addQuote("original", { id: "q1", messageIndex: 1, timestamp: A1, role: "assistant", text: "first" });
  const attached = file("a.png");
  state.files = [attached];
  type("and then this");
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "enqueue send" }));
  });

  await waitFor(() => expect(calls("/api/chats/original/held")).toHaveLength(1));
  const body = calls("/api/chats/original/held")[0];
  expect(body.text).toContain("> first");
  expect(body.text).toContain("and then this");
  expect(body).toMatchObject({ images: [{ id: "img-0", originalName: "a.png" }], maxTurns: expect.any(Number) });
  // It waits: nothing went to the running chat.
  expect(calls("/api/chats/original/message")).toHaveLength(0);
  await waitFor(() => expect(composer().value).toBe(""));
  expect(state.files).toEqual([]);
  expect(getQuotes("original")).toHaveLength(0);
  const [card] = heldCards();
  expect(card.querySelector("[data-held-line]")!.textContent).toBe("Queued · sends when this turn ends");
});

it("sends normally when the run ended before the hold arrived", async () => {
  replies["POST /api/chats/original/held"] = [{ status: 409, body: { error: "The chat is not running", code: "not_running" } }];
  await open();
  addQuote("original", { id: "q1", messageIndex: 1, timestamp: A1, role: "assistant", text: "first" });
  type("now then");
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "enqueue send" }));
  });
  await waitFor(() => expect(calls("/api/chats/original/message")).toHaveLength(1));
  // The composer's own send: the tray's quotes go with it.
  expect(calls("/api/chats/original/message")[0].prompt).toMatch(/> first[\s\S]*now then/);
  expect(composer().value).toBe("");
  expect(heldCards()).toHaveLength(0);
});

it("names an older daemon and leaves the composer, the files and the tray alone", async () => {
  replies["POST /api/chats/original/held"] = [{ status: 404, text: "<html>Cannot POST</html>" }];
  await open();
  addQuote("original", { id: "q1", messageIndex: 1, timestamp: A1, role: "assistant", text: "first" });
  const attached = file("a.png");
  state.files = [attached];
  type("keep me");
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "enqueue send" }));
  });
  expect((await screen.findByRole("alert")).textContent).toMatch(/too old for “Enqueue Send”/);
  expect(composer().value).toBe("keep me");
  expect(state.files).toEqual([attached]);
  expect(getQuotes("original")).toHaveLength(1);
  expect(calls("/api/chats/original/message")).toHaveLength(0);
});

it("is not offered without a live web run", async () => {
  state.running = false;
  await open();
  expect(screen.queryByRole("button", { name: "enqueue send" })).toBeNull();
});

it("Edit takes the message back into the composer, below what is typed there, with its attachments", async () => {
  state.held = [held("h1", { text: "held words", images: [{ id: "img-1", originalName: "pic.png" }] })];
  await open();
  type("already typed");
  const [card] = await waitFor(() => {
    const found = heldCards();
    expect(found).toHaveLength(1);
    return found;
  });
  await act(async () => {
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
  });
  await waitFor(() => expect(composer().value).toBe("already typed\n\nheld words"));
  expect(calls("/api/chats/original/held/h1/take")).toHaveLength(1);
  expect(state.files.map((f) => f.name)).toEqual(["pic.png"]);
  expect(heldCards()).toHaveLength(0);
});

it("Send now takes the message and sends it at once, interrupting", async () => {
  state.held = [held("h1", { text: "go now" })];
  await open();
  const card = await waitFor(() => heldCards()[0]!);
  await act(async () => {
    fireEvent.click(within(card).getByRole("button", { name: "Send now" }));
  });
  await waitFor(() => expect(calls("/api/chats/original/message")).toHaveLength(1));
  expect(calls("/api/chats/original/message")[0].prompt).toBe("go now");
  expect(calls("/api/chats/original/held/h1/take")).toHaveLength(1);
});

it("says a message is already sent when the take finds it gone, and sends nothing", async () => {
  state.held = [held("h1", { text: "gone" })];
  await open();
  const card = await waitFor(() => heldCards()[0]!);
  // The daemon sent it meanwhile.
  state.held = [];
  await act(async () => {
    fireEvent.click(within(card).getByRole("button", { name: "Send now" }));
  });
  expect((await screen.findByRole("alert")).textContent).toBe("It's no longer held (sent or removed elsewhere).");
  expect(calls("/api/chats/original/message")).toHaveLength(0);
  expect(composer().value).toBe("");
  await waitFor(() => expect(heldCards()).toHaveLength(0));
});

it("Remove deletes the message from the daemon's list", async () => {
  state.held = [held("h1"), held("h2")];
  await open();
  await waitFor(() => expect(heldCards()).toHaveLength(2));
  await act(async () => {
    fireEvent.click(within(heldCards()[0]).getByRole("button", { name: "Remove" }));
  });
  await waitFor(() => expect(heldCards()).toHaveLength(1));
  expect(calls("/api/chats/original/held/h1", "DELETE")).toHaveLength(1);
  expect(heldCards()[0].textContent).toContain("held h2");
});

it("re-reads the list when metadata moves, and keeps it through a failed read", async () => {
  const view = await open();
  await waitFor(() => expect(vi.mocked(getActivity)).toHaveBeenCalled());
  expect(heldCards()).toHaveLength(0);

  // Another tab held one: the daemon bumps metadata.
  state.held = [held("h1", { text: "from elsewhere" })];
  state.metadataVersion = 1;
  view.rerender(tree());
  await waitFor(() => expect(heldCards()).toHaveLength(1));

  // A failed read leaves the list on screen.
  vi.mocked(getActivity).mockRejectedValueOnce(new Error("rate limited"));
  const before = vi.mocked(getActivity).mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  state.metadataVersion = 2;
  view.rerender(tree());
  await waitFor(() => expect(vi.mocked(getActivity).mock.calls.length).toBeGreaterThan(before));
  await act(async () => {});
  expect(heldCards()).toHaveLength(1);
});

/** Hold a failed message with an attachment, open the chat, and press its Send now. */
async function sendNowFailedItem() {
  state.held = [held("h1", { text: "retry me", state: "failed", reason: "The branch changed.", images: [{ id: "img-1", originalName: "pic.png" }] })];
  await open();
  const card = await waitFor(() => heldCards()[0]!);
  await act(async () => {
    fireEvent.click(within(card).getByRole("button", { name: "Send now" }));
  });
  await waitFor(() => expect(calls("/api/chats/original/message")).toHaveLength(1));
  // Taken off the daemon: from here on the page is the only copy.
  expect(calls("/api/chats/original/held/h1/take")).toHaveLength(1);
}

it("Send now hands the message back to the composer when the branch-drift dialog is cancelled", async () => {
  replies["POST /api/chats/original/message"] = [{ status: 409, body: { error: "branch_drift", message: "The branch has changed." } }];
  await sendNowFailedItem();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(composer().value).toBe("retry me"));
  expect(state.files.map((f) => f.name)).toEqual(["pic.png"]);
});

it("Send now hands the message back to the composer on a network error", async () => {
  replies["POST /api/chats/original/message"] = [{ status: 0, reject: true }];
  await sendNowFailedItem();
  await waitFor(() => expect(composer().value).toBe("retry me"));
  expect(state.files.map((f) => f.name)).toEqual(["pic.png"]);
});

it("Send now hands the message back to the composer when the route refuses it", async () => {
  replies["POST /api/chats/original/message"] = [{ status: 500, body: { error: "engine down" } }];
  await sendNowFailedItem();
  await waitFor(() => expect(composer().value).toBe("retry me"));
});

/**
 * An `/activity` read that was already out when the user removed or took
 * an item must not put the item back when it lands.
 */
for (const action of ["Remove", "Edit"] as const) {
  it(`does not let an /activity read already out undo a ${action}`, async () => {
    state.held = [held("h1"), held("h2")];
    const view = await open();
    await waitFor(() => expect(heldCards()).toHaveLength(2));
    // A read goes out (the metadata moved) and is slow to answer — with the
    // list as it was before the action.
    let answer!: () => void;
    const stale = { activities: [], conditionWatch: null, awaitingChildren: 0, heldMessages: [held("h1"), held("h2")] };
    const before = vi.mocked(getActivity).mock.calls.length;
    vi.mocked(getActivity).mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve(stale))));
    state.metadataVersion = 1;
    view.rerender(tree());
    await waitFor(() => expect(vi.mocked(getActivity).mock.calls.length).toBeGreaterThan(before), { timeout: 3000 });

    await act(async () => {
      fireEvent.click(within(heldCards()[0]).getByRole("button", { name: action }));
    });
    await waitFor(() => expect(heldCards()).toHaveLength(1));
    await act(async () => answer());
    await act(async () => {});
    expect(heldCards()).toHaveLength(1);
    expect(heldCards()[0].textContent).toContain("held h2");
  });
}
