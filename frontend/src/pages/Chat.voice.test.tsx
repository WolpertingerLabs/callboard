// @vitest-environment jsdom
/**
 * The chat page's side of the composer mic: one PromptInput serves both the
 * new-chat composer (`/chat/new`) and an existing chat (`/chat/:id`), and both
 * get the mic once system-info has answered — disabled, naming the missing
 * OpenRouter key, when the server cannot transcribe. Harness as
 * Chat.enqueueSend.test.tsx, with the real composer.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { VOICE_NOT_CONFIGURED_MESSAGE } from "shared/types/voice.js";
import Chat from "./Chat";

const state = vi.hoisted(() => ({ systemInfo: {} as Record<string, unknown> }));

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Work", folder: "/tmp", is_git_repo: true, metadata: "{}", slash_commands: [] })),
  getChatTree: vi.fn(async (id: string) => ({
    targetChatId: id,
    rootChatId: id,
    ancestors: [],
    tree: { chatId: id, title: "Work", provider: "claude-code", status: "ongoing", folder: "/tmp", createdAt: "", updatedAt: "", children: [] },
  })),
  getMessages: vi.fn(async () => [{ role: "assistant", type: "text", content: "an answer", timestamp: "2026-01-01T10:00:01.000Z" }]),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0, heldMessages: [] })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => state.systemInfo),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
}));
vi.mock("../contexts/SessionContext", () => ({
  useIsSessionActive: () => null,
  useMetadataVersion: () => 0,
}));
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

beforeEach(() => {
  state.systemInfo = {};
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn() }, configurable: true });
  vi.stubGlobal("MediaRecorder", class {});
  vi.stubGlobal("AudioContext", class {});
  vi.stubGlobal("OfflineAudioContext", class {});
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
    vi.fn(async (url: string) =>
      url.endsWith("/stream")
        ? { ok: true, status: 200, body: new ReadableStream({ start() {} }), json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({}), text: async () => "{}" },
    ),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const ROUTES = [
  ["new-chat", "/chat/new", "?folder=%2Ftmp"],
  ["existing-chat", "/chat/original", ""],
] as const;

function renderAt(pathname: string, search: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname, search }]}>
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe.each(ROUTES)("the %s composer", (_label, pathname, search) => {
  it("shows a disabled mic naming the OpenRouter key when the server cannot transcribe", async () => {
    state.systemInfo = { voiceInputAvailable: false };
    renderAt(pathname, search);
    const mic = await screen.findByTestId("voice-input-button");
    expect(mic.getAttribute("aria-disabled")).toBe("true");
    expect(mic.getAttribute("title")).toBe(VOICE_NOT_CONFIGURED_MESSAGE);
  });

  it("treats an older daemon (no field) as unavailable", async () => {
    state.systemInfo = {};
    renderAt(pathname, search);
    const mic = await screen.findByTestId("voice-input-button");
    expect(mic.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows an enabled mic when it can", async () => {
    state.systemInfo = { voiceInputAvailable: true };
    renderAt(pathname, search);
    const mic = await screen.findByTestId("voice-input-button");
    expect(mic.getAttribute("aria-disabled")).toBeNull();
    expect(mic.getAttribute("aria-label")).toBe("Start voice input");
  });
});
