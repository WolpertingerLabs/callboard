// @vitest-environment jsdom
/**
 * The page's side of per-chat composer drafts (the composer's side is
 * PromptInput.localDraft.test.tsx): the new-chat composer keeps its text under
 * its own key and gives it up on send, and a saved server draft opened from
 * Staging wins over whatever the browser had kept for that composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Chat from "./Chat";
import { getComposerDraft, NEW_CHAT_DRAFT_KEY, saveComposerDraft } from "../utils/localStorage";

const FOLDER = "/tmp/project";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

let sends: unknown[] = [];

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && url.includes("/chats/new/message")) {
    sends.push(JSON.parse(init!.body as string));
    const stream = new ReadableStream({ start: (controller) => controller.close() });
    return Promise.resolve({ ok: true, status: 200, body: stream, json: async () => ({}) } as unknown as Response);
  }
  if (url.includes("/chats/new/info")) return Promise.resolve(jsonResponse({ folder: FOLDER, slash_commands: [], plugins: [] }));
  if (url.includes("/system-info")) return Promise.resolve(jsonResponse({}));
  if (url.includes("/keywords")) return Promise.resolve(jsonResponse({ keywords: [] }));
  if (url.includes("/mcp-tools")) return Promise.resolve(jsonResponse({ tools: [], servers: [] }));
  // Everything else the page asks for at mount (favorites, plugins, …) can
  // fail: none of it decides what the composer holds.
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" } as unknown as Response);
}

function renderCompose(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/new", search: `?folder=${encodeURIComponent(FOLDER)}`, state }]}>
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

const textarea = () => screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
  sends = [];
  vi.stubGlobal("fetch", vi.fn(fakeServer));
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
  localStorage.clear();
});

describe("composer drafts on the page", () => {
  it("restores the new-chat composer's text after a reload", async () => {
    saveComposerDraft(NEW_CHAT_DRAFT_KEY, "an idea for a new chat");
    renderCompose();
    await waitFor(() => expect(textarea().value).toBe("an idea for a new chat"));
  });

  it("an opened server draft takes precedence over the locally kept text", async () => {
    saveComposerDraft(NEW_CHAT_DRAFT_KEY, "local scribble");
    renderCompose({ draft: { id: "draft-1", user_message: "from the saved draft" } });
    await waitFor(() => expect(textarea().value).toBe("from the saved draft"));
    await waitFor(() => expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe("from the saved draft"));
  });

  it("sending from the new-chat composer leaves no draft behind", async () => {
    saveComposerDraft(NEW_CHAT_DRAFT_KEY, "start the chat");
    renderCompose();
    await waitFor(() => expect(textarea().value).toBe("start the chat"));
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: "Enter" });
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ prompt: "start the chat" });
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe("");
  });
});
