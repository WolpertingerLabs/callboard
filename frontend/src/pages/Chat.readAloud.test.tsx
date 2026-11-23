// @vitest-environment jsdom
/**
 * The chat page's side of read aloud: once system-info has answered, every
 * text bubble gets the speaker — disabled, naming the missing OpenRouter key,
 * when the server cannot synthesize — and a playback shows its controls in
 * the bar docked directly above the composer. Harness as Chat.voice.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { READ_ALOUD_NOT_CONFIGURED_MESSAGE } from "shared/types/readAloud.js";
import { installMediaStubs } from "../testing/mediaStubs";
import { getSnapshot, resetReadAloudPlayerForTesting } from "../utils/readAloudPlayer";
import Chat from "./Chat";

const state = vi.hoisted(() => ({ systemInfo: {} as Record<string, unknown>, synth: vi.fn() }));

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
  synthesizeSpeech: (...args: unknown[]) => state.synth(...args),
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
  state.synth.mockReset().mockResolvedValue({ blob: new Blob(["mp3"]), model: "m", voice: null, truncated: false });
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
  act(() => resetReadAloudPlayerForTesting());
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** A stand-in for the sidebar: switches chats without remounting the page. */
function SwitchChat() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/chat/other")}>switch chat</button>;
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/original" }]}>
      <SwitchChat />
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

describe("the docked read-aloud bar", () => {
  const bar = () => screen.queryByRole("group", { name: "Read aloud player" });
  const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

  beforeEach(() => {
    installMediaStubs();
    state.systemInfo = { readAloudAvailable: true };
  });

  async function startReading() {
    const speaker = await speakerOnReply();
    fireEvent.click(speaker);
    await flush();
    return speaker;
  }

  it("is absent while nothing is being read", async () => {
    renderChat();
    await speakerOnReply();
    expect(bar()).toBeNull();
  });

  it("mounts directly above the composer, outside both the composer's root and the message list", async () => {
    const { container } = renderChat();
    await startReading();
    const el = bar()!;
    expect(el).toBeTruthy();
    const composer = container.querySelector("[data-composer]")!;
    expect(el.nextElementSibling).toBe(composer);
    expect(composer.contains(el)).toBe(false);
    expect(el.closest(".msg-bubble")).toBeNull();
    // Not in the scrolling transcript: the bubble's ancestor list holds no bar.
    const bubble = container.querySelector(".msg-bubble")!;
    let scroller: Element | null = bubble.parentElement;
    while (scroller && (scroller as HTMLElement).style.overflow !== "auto") scroller = scroller.parentElement;
    expect(scroller).toBeTruthy();
    expect(scroller!.contains(el)).toBe(false);
    expect(screen.getByText("an answer", { selector: ".read-aloud-label-text" })).toBeTruthy();
  });

  it("keeps playing, and stays, while the transcript scrolls", async () => {
    const { container } = renderChat();
    const speaker = await startReading();
    const bubble = container.querySelector(".msg-bubble")!;
    let scroller: HTMLElement | null = bubble.parentElement;
    while (scroller && scroller.style.overflow !== "auto") scroller = scroller.parentElement;
    act(() => {
      scroller!.scrollTop = 500;
      fireEvent.scroll(scroller!);
      fireEvent.wheel(scroller!, { deltaY: -400 });
    });
    expect(getSnapshot().status).toBe("playing");
    expect(bar()).toBeTruthy();
    expect(speaker.classList.contains("is-active")).toBe(true);
  });

  it("X closes it and hands focus back to the bubble's speaker", async () => {
    renderChat();
    const speaker = await startReading();
    const close = screen.getByRole("button", { name: "Close audio player" });
    close.focus();
    act(() => fireEvent.click(close));
    expect(bar()).toBeNull();
    expect(getSnapshot().status).toBe("idle");
    expect(document.activeElement).toBe(speaker);
  });

  it("is gone after a chat switch, with playback stopped", async () => {
    renderChat();
    await startReading();
    expect(bar()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "switch chat" }));
    await flush();
    expect(getSnapshot().status).toBe("idle");
    expect(bar()).toBeNull();
  });
});
