// @vitest-environment jsdom
/**
 * `chat_created` is a redirect, and a redirect is only welcome if the user is
 * still standing where they asked for it.
 *
 * Sending the first prompt of a new chat opens an SSE stream that outlives the
 * screen that opened it: on mobile, going back to the list unmounts `Chat`
 * while the POST keeps streaming; on desktop the component stays mounted at
 * whatever route the user moved to. Either way the `chat_created` frame lands
 * seconds later, and it used to navigate unconditionally — dropping the user
 * into the new chat on top of whatever they had moved on to.
 *
 * These tests pin both halves: redirect when the user is still on the compose
 * screen, stay put (and refresh the list instead) when they are not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import Chat from "./Chat";

// The composer is a rich contenteditable with its own suspense of behaviour;
// none of it is what this test is about. A button that fires `onSend` is.
vi.mock("../components/PromptInput", () => ({
  default: ({ onSend }: { onSend: (prompt: string) => void }) => (
    <button type="button" onClick={() => onSend("do the thing")}>
      send prompt
    </button>
  ),
}));

const FOLDER = "/tmp/project";
const NEW_CHAT_ID = "chat-created-123";

/** Pushes SSE frames into the in-flight new-chat stream. */
let emit: (frame: unknown) => void;
/** Resolves once the client has actually opened the new-chat stream. */
let streamOpened: Promise<void>;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "POST" && url.includes("/chats/new/message")) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        emit = (frame: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        openStream();
      },
    });
    return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
  }

  if (url.includes("/chats/new/info")) {
    return Promise.resolve(jsonResponse({ folder: FOLDER, slash_commands: [], plugins: [] }));
  }
  if (url.includes("/system-info")) {
    return Promise.resolve(jsonResponse({}));
  }
  if (url.includes("/keywords")) {
    return Promise.resolve(jsonResponse({ keywords: [] }));
  }
  if (url.includes("/mcp/tools")) {
    return Promise.resolve(jsonResponse({ servers: [] }));
  }
  // What the page loads once it lands on the created chat.
  if (url.includes("/tree")) {
    return Promise.resolve(jsonResponse({ tree: { chatId: NEW_CHAT_ID, children: [] }, ancestors: [] }));
  }
  if (url.includes("/messages")) {
    return Promise.resolve(jsonResponse([]));
  }
  if (url.includes("/pending")) {
    return Promise.resolve(jsonResponse({ pending: null }));
  }
  if (url.includes("/activity")) {
    return Promise.resolve(jsonResponse({ activities: [], conditionWatch: null, awaitingChildren: 0 }));
  }
  if (url.includes(`/chats/${NEW_CHAT_ID}`) && method === "GET") {
    return Promise.resolve(jsonResponse({ id: NEW_CHAT_ID, folder: FOLDER, metadata: "{}" }));
  }
  // Everything else this page touches is incidental to the redirect decision.
  return Promise.resolve(jsonResponse({}));
}

let openStream: () => void;

/** Reads the current path out of the router, and offers a way to leave. */
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
    // Two turns: one for the reader's pending read to resolve, one for the
    // state update it schedules.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  streamOpened = new Promise<void>((resolve) => {
    openStream = resolve;
  });
  vi.stubGlobal("fetch", vi.fn(fakeServer));
  // jsdom ships neither, and the transcript view sets both up the moment a
  // chat id exists — i.e. exactly in the case this test wants to reach.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat_created only redirects the user who is waiting for it", () => {
  it("navigates to the new chat when the user stayed on the compose screen", async () => {
    renderNewChat();
    await sendFirstPrompt();

    await emitChatCreated();

    expect(screen.getByTestId("path").textContent).toBe(`/chat/${NEW_CHAT_ID}`);
  });

  it("leaves the user alone when they went back to the chat list", async () => {
    const refresh = vi.fn();
    renderNewChat(refresh);
    await sendFirstPrompt();

    await act(async () => {
      fireEvent.click(screen.getByText("back to list"));
    });
    expect(screen.getByTestId("path").textContent).toBe("/");

    await emitChatCreated();

    // Still on the list, and the new chat is announced by refreshing it
    // rather than by hijacking the page.
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(refresh).toHaveBeenCalled();
  });

  it("leaves the user alone when they opened a different chat", async () => {
    renderNewChat();
    await sendFirstPrompt();

    await act(async () => {
      fireEvent.click(screen.getByText("open another chat"));
    });

    await emitChatCreated();

    expect(screen.getByTestId("path").textContent).toBe("/chat/some-other-chat");
  });
});
