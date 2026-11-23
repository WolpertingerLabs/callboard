// @vitest-environment jsdom
/**
 * The chat page's side of read aloud: once system-info has answered, every
 * text bubble gets the speaker — disabled, naming the missing OpenRouter key,
 * when the server cannot synthesize. Harness as Chat.voice.test.tsx.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { READ_ALOUD_NOT_CONFIGURED_MESSAGE } from "shared/types/readAloud.js";
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

function renderChat() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/original" }]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function speakerOnReply() {
  await screen.findByText("an answer");
  return screen.findByRole("button", { name: "Read aloud" });
}

describe("read aloud on the chat page", () => {
  it("gives a reply a disabled speaker naming the OpenRouter key when the server cannot synthesize", async () => {
    state.systemInfo = { readAloudAvailable: false };
    renderChat();
    const speaker = await speakerOnReply();
    expect(speaker.getAttribute("aria-disabled")).toBe("true");
    expect(speaker.getAttribute("title")).toBe(READ_ALOUD_NOT_CONFIGURED_MESSAGE);
  });

  it("treats an older daemon (no field) as unavailable", async () => {
    state.systemInfo = {};
    renderChat();
    const speaker = await speakerOnReply();
    expect(speaker.getAttribute("aria-disabled")).toBe("true");
  });

  it("gives an enabled speaker when it can", async () => {
    state.systemInfo = { readAloudAvailable: true };
    renderChat();
    const speaker = await speakerOnReply();
    expect(speaker.getAttribute("aria-disabled")).toBeNull();
    expect(speaker.getAttribute("title")).toBe("Read aloud");
  });
});
