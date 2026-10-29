// @vitest-environment jsdom
/**
 * The page's side of composer auto-focus (the composer's side is
 * PromptInput.autoFocus.test.tsx): the new-chat composer NewChatPanel
 * navigates to takes focus on a desktop, and leaves the keyboard down on a
 * phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Chat from "./Chat";
import { NEW_CHAT_DRAFT_KEY, saveComposerDraft } from "../utils/localStorage";

const FOLDER = "/tmp/project";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function fakeServer(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes("/chats/new/info")) return Promise.resolve(jsonResponse({ folder: FOLDER, slash_commands: [], plugins: [] }));
  if (url.includes("/system-info")) return Promise.resolve(jsonResponse({}));
  if (url.includes("/keywords")) return Promise.resolve(jsonResponse({ keywords: [] }));
  if (url.includes("/mcp-tools")) return Promise.resolve(jsonResponse({ tools: [], servers: [] }));
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" } as unknown as Response);
}

/** A desktop answers `(pointer: fine)`; a phone answers neither that nor the width query. */
function stubDevice(desktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: desktop ? query.includes("pointer: fine") : query.includes("not all and (min-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

function renderCompose() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/new", search: `?folder=${encodeURIComponent(FOLDER)}` }]}>
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

const textarea = () => screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
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

describe("new-chat composer auto-focus", () => {
  it("focuses the composer on desktop, caret after the kept text", async () => {
    stubDevice(true);
    saveComposerDraft(NEW_CHAT_DRAFT_KEY, "an idea");
    renderCompose();
    await waitFor(() => expect(document.activeElement).toBe(textarea()));
    expect(textarea().value).toBe("an idea");
    expect(textarea().selectionStart).toBe("an idea".length);
  });

  it("does not focus the composer on a phone", async () => {
    stubDevice(false);
    renderCompose();
    await waitFor(() => expect(textarea()).toBeTruthy());
    // Let the mount effects run their course before asserting the absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).not.toBe(textarea());
  });
});
