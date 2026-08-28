// @vitest-environment jsdom
/**
 * `chat_created` is a redirect, and a redirect is only welcome if the user is
 * still standing where they asked for it.
 *
 * Sending the first prompt of a new chat opens an SSE stream that outlives the
 * screen that opened it: nothing aborts the POST when the user leaves, so the
 * reader keeps running after `Chat` unmounts and `navigate` still works from
 * that dead closure. The frame used to redirect unconditionally, dropping the
 * user into the new chat on top of whatever they had moved on to.
 *
 * The two reachable ways to walk off need different signals, so there is a test
 * for each: leaving the Chat pane (only `mountedRef` sees it) and opening a
 * second compose screen for the same folder (identical URL — only
 * `location.key` sees it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import Chat from "./Chat";

// The composer is a rich contenteditable with its own suspense of behaviour;
// none of it is what these tests are about. A button that fires `onSend` is —
// plus its `disabled` state, which is how the page says "a send is in flight".
vi.mock("../components/PromptInput", () => ({
  default: ({ onSend, disabled }: { onSend: (prompt: string, images?: File[]) => void; disabled?: boolean }) => (
    <>
      <button type="button" disabled={disabled} onClick={() => onSend("do the thing")}>
        send prompt
      </button>
      <button type="button" disabled={disabled} onClick={() => onSend("do the thing", [new File(["x"], "shot.png", { type: "image/png" })])}>
        send prompt with image
      </button>
    </>
  ),
}));

const FOLDER = "/tmp/project";
const NEW_CHAT_ID = "chat-created-123";

/** Pushes SSE frames into the in-flight new-chat stream. */
let emit: (frame: unknown) => void;
/** Resolves when the client's POST has been answered with a stream body. */
let streamOpened: Promise<void>;
let openStream: () => void;
/** Set by the one test that needs to navigate mid-upload; resolves the POST. */
let slowImageUpload = false;
let finishImageUpload: (() => void) | null = null;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Enough of the server to get a compose screen on screen and a new-chat stream
 * open. Unmocked routes throw rather than resolving to `{}`: a silent empty
 * body is how a stale path (or a real endpoint nobody noticed the page calls)
 * turns into a passing test that exercises the wrong thing.
 */
function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "POST" && url.includes("/images/upload")) {
    const result = jsonResponse({ success: true, images: [{ id: "img-1" }] });
    // Slow uploads are the point of one test: a multi-megabyte screenshot over
    // a tunnel takes long enough to walk away during.
    if (!slowImageUpload) return Promise.resolve(result);
    return new Promise<Response>((resolve) => {
      finishImageUpload = () => resolve(result);
    });
  }

  if (method === "POST" && url.includes("/chats/new/message")) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        emit = (frame: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        // A real fetch tears the body down when its signal fires, and abort is
        // load-bearing on this path (switching folders mid-send aborts the
        // stream). Without this the tests would be kinder to the component
        // than the browser is.
        init?.signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            // Already closed — the reader got there first.
          }
        });
      },
    });
    openStream();
    return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
  }

  // Compose screen.
  if (url.includes("/chats/new/info")) return Promise.resolve(jsonResponse({ folder: FOLDER, slash_commands: [], plugins: [] }));
  if (url.includes("/system-info")) return Promise.resolve(jsonResponse({}));
  if (url.includes("/keywords")) return Promise.resolve(jsonResponse({ keywords: [] }));
  if (url.includes("/mcp-tools")) return Promise.resolve(jsonResponse({ tools: [], servers: [] }));

  // What the page loads once it lands on a chat.
  if (url.includes("/tree")) return Promise.resolve(jsonResponse({ tree: { chatId: NEW_CHAT_ID, children: [] }, ancestors: [] }));
  if (url.includes("/messages")) return Promise.resolve(jsonResponse([]));
  if (url.includes("/pending")) return Promise.resolve(jsonResponse({ pending: null }));
  if (url.includes("/activity")) return Promise.resolve(jsonResponse({ activities: [], conditionWatch: null, awaitingChildren: 0 }));
  if (url.includes("/read") && method === "PATCH") return Promise.resolve(jsonResponse({}));
  if (method === "GET" && /\/chats\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse({ id: NEW_CHAT_ID, folder: FOLDER, metadata: "{}" }));

  return Promise.reject(new Error(`unmocked request: ${method} ${url}`));
}

/** Reads the current path out of the router, and offers ways to leave. */
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="path">{location.pathname}</div>
      <button type="button" onClick={() => navigate("/")}>
        back to list
      </button>
      <button type="button" onClick={() => navigate("/chat/some-other-chat")}>
        open another chat
      </button>
      {/* What the New Chat panel does: same folder, same URL, fresh compose. */}
      <button type="button" onClick={() => navigate(`/chat/new?folder=${encodeURIComponent(FOLDER)}`, { state: { provider: "codex" } })}>
        start another new chat
      </button>
    </>
  );
}

function renderNewChat(onChatListRefresh?: () => void) {
  return render(
    <MemoryRouter initialEntries={[`/chat/new?folder=${encodeURIComponent(FOLDER)}`]}>
      <Routes>
        <Route path="/chat/new" element={<Chat onChatListRefresh={onChatListRefresh} />} />
        <Route path="/chat/:id" element={<Chat onChatListRefresh={onChatListRefresh} />} />
        <Route path="/" element={<div>chat list</div>} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
}

/** Send the first prompt and wait until the stream is actually open. */
async function sendFirstPrompt() {
  await act(async () => {
    fireEvent.click(screen.getByText("send prompt"));
  });
  await act(async () => {
    await streamOpened;
  });
}

/** Push `chat_created` and let the reader drain it. */
async function emitChatCreated() {
  await act(async () => {
    emit({ type: "chat_created", chatId: NEW_CHAT_ID });
    // One macrotask turn, which drains every microtask the reader queues on
    // the way through — the whole chain from `reader.read()` to the navigate
    // is microtask-bound.
    await new Promise((r) => setTimeout(r, 0));
  });
}

const path = () => screen.getByTestId("path").textContent;

beforeEach(() => {
  streamOpened = new Promise<void>((resolve) => {
    openStream = resolve;
  });
  emit = () => {
    throw new Error("no new-chat stream is open");
  };
  slowImageUpload = false;
  finishImageUpload = null;
  vi.stubGlobal("fetch", vi.fn(fakeServer));
  // jsdom ships neither, and the transcript view sets both up the moment a
  // chat id exists — i.e. exactly in the case these tests want to reach.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat_created only redirects the user who is waiting for it", () => {
  it("navigates to the new chat, carrying the sent message, when the user stayed put", async () => {
    renderNewChat();
    await sendFirstPrompt();

    await emitChatCreated();

    expect(path()).toBe(`/chat/${NEW_CHAT_ID}`);
    // The in-flight bubble rides across on router state; losing it would blank
    // the transcript until the refetch lands.
    expect(screen.getByText("do the thing")).toBeTruthy();
  });

  it("leaves the user alone when they went back to the chat list", async () => {
    const refresh = vi.fn();
    renderNewChat(refresh);
    await sendFirstPrompt();

    await act(async () => {
      fireEvent.click(screen.getByText("back to list"));
    });
    expect(path()).toBe("/");

    await emitChatCreated();

    // Still on the list, and the new chat is announced by refreshing it rather
    // than by hijacking the page.
    expect(path()).toBe("/");
    expect(refresh).toHaveBeenCalled();
  });

  it("leaves the user alone in a second compose screen for the same folder", async () => {
    const refresh = vi.fn();
    renderNewChat(refresh);
    await sendFirstPrompt();

    // The New Chat panel's own navigate: identical URL, new compose context.
    // `Chat` stays mounted and `folder` never changes, so nothing else in the
    // page notices — only `location.key` distinguishes this from standing
    // still, which is why the redirect is keyed on it.
    await act(async () => {
      fireEvent.click(screen.getByText("start another new chat"));
    });

    await emitChatCreated();

    expect(path()).toBe("/chat/new");
    expect(refresh).toHaveBeenCalled();
    // The fresh composer is usable rather than stuck behind the previous
    // send's streaming state.
    expect(screen.getByText("send prompt")).not.toHaveProperty("disabled", true);
  });

  it("leaves the user alone when they walked off during an image upload", async () => {
    slowImageUpload = true;
    const refresh = vi.fn();
    renderNewChat(refresh);

    await act(async () => {
      fireEvent.click(screen.getByText("send prompt with image"));
    });

    // Still uploading — the POST that creates the chat has not been sent yet.
    // The compose screen the send was fired from must have been recorded
    // before this await, or the user's move gets folded into the origin and
    // the check compares the destination against itself.
    await act(async () => {
      fireEvent.click(screen.getByText("start another new chat"));
    });

    await act(async () => {
      finishImageUpload?.();
      await streamOpened;
    });
    await emitChatCreated();

    expect(path()).toBe("/chat/new");
    expect(refresh).toHaveBeenCalled();
  });

  it("leaves the user alone when they opened a different chat", async () => {
    renderNewChat();
    await sendFirstPrompt();

    await act(async () => {
      fireEvent.click(screen.getByText("open another chat"));
    });

    await emitChatCreated();

    // Note: this one passes without the redirect guard too — the read loop's
    // pre-existing staleness check (`currentIdRef.current !== streamChatId`)
    // cancels the reader before the frame is parsed. Kept as a regression
    // guard for that check, not as coverage of this fix.
    expect(path()).toBe("/chat/some-other-chat");
  });
});
