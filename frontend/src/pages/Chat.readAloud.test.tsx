// @vitest-environment jsdom
/**
 * The chat page's side of read aloud: once system-info has answered, every
 * text bubble gets the speaker — disabled, naming the missing OpenRouter key,
 * when the server cannot synthesize — and a playback shows its controls in
 * the bar docked directly above the composer. Harness as Chat.voice.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { READ_ALOUD_NOT_CONFIGURED_MESSAGE } from "shared/types/readAloud.js";
import { installMediaStubs } from "../testing/mediaStubs";
import { getSnapshot, resetReadAloudPlayerForTesting } from "../utils/readAloudPlayer";
import Chat from "./Chat";

const state = vi.hoisted(() => ({ systemInfo: {} as Record<string, unknown>, synth: vi.fn(), withAside: false }));
const ASIDE_AT = "2026-01-01T10:00:01.000Z";

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Work", folder: "/tmp", is_git_repo: true, metadata: "{}", slash_commands: [] })),
  getChatTree: vi.fn(async (id: string) => {
    const node = (chatId: string, extra: Record<string, unknown> = {}) => ({
      chatId,
      title: chatId,
      provider: "claude-code",
      status: "ongoing",
      folder: "/tmp",
      createdAt: "2026-01-01T11:00:00.000Z",
      updatedAt: "",
      children: [],
      ...extra,
    });
    const aside = node("aside-1", {
      role: "aside",
      title: "Aside: why?",
      forkedAt: ASIDE_AT,
      asideQuotes: [{ timestamp: ASIDE_AT, role: "assistant", text: "an" }],
    });
    return {
      targetChatId: id,
      rootChatId: "original",
      ancestors: [],
      tree: id === "original" ? node("original", { children: state.withAside ? [aside] : [] }) : node(id),
    };
  }),
  getMessages: vi.fn(async (id: string) =>
    id === "aside-1"
      ? [{ role: "assistant", type: "text", content: "an aside reply", timestamp: "2026-01-01T11:00:01.000Z" }]
      : [{ role: "assistant", type: "text", content: "an answer", timestamp: "2026-01-01T10:00:01.000Z" }],
  ),
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
  state.withAside = false;
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

function renderChat(search = "") {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/original", search }]}>
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

  describe("with the aside panel open", () => {
    const panel = () => screen.getByTestId("aside-panel");
    const bars = () => screen.queryAllByRole("group", { name: "Read aloud player" });

    beforeEach(() => {
      state.withAside = true;
    });

    async function openBoth() {
      renderChat("?aside=aside-1");
      await within(panel()).findByText("an aside reply");
      await screen.findByText("an answer");
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Read aloud" })).toHaveLength(2));
    }
    const mainSpeaker = () =>
      screen
        .getAllByText("an answer")
        .map((el) => el.closest(".msg-bubble"))
        .find(Boolean)!
        .querySelector<HTMLButtonElement>(":scope > .read-aloud-affordance")!;
    const asideSpeaker = () => within(panel()).getByRole("button", { name: /Read aloud|Stop reading aloud/ });

    it("reading in the main chat: one bar, in the main chat's view; closing the aside leaves it playing", async () => {
      await openBoth();
      fireEvent.click(mainSpeaker());
      await flush();
      expect(bars()).toHaveLength(1);
      expect(panel().contains(bars()[0])).toBe(false);

      fireEvent.click(within(panel()).getByRole("button", { name: "Close aside" }));
      await waitFor(() => expect(screen.queryByTestId("aside-panel")).toBeNull());
      await flush();
      expect(getSnapshot().status).toBe("playing");
      expect(bars()).toHaveLength(1);
      expect(mainSpeaker().classList.contains("is-active")).toBe(true);
    });

    it("reading in the aside: one bar, in the aside's view; closing the aside stops it and leaves no bar", async () => {
      await openBoth();
      fireEvent.click(asideSpeaker());
      await flush();
      expect(bars()).toHaveLength(1);
      expect(panel().contains(bars()[0])).toBe(true);
      expect(within(bars()[0]).getByText("an aside reply")).toBeTruthy();
      expect(mainSpeaker().classList.contains("is-active")).toBe(false);

      fireEvent.click(within(panel()).getByRole("button", { name: "Close aside" }));
      await waitFor(() => expect(screen.queryByTestId("aside-panel")).toBeNull());
      await flush();
      expect(getSnapshot().status).toBe("idle");
      expect(bars()).toHaveLength(0);
    });

    it("starting in one view moves the single bar to the other", async () => {
      await openBoth();
      fireEvent.click(asideSpeaker());
      await flush();
      fireEvent.click(mainSpeaker());
      await flush();
      expect(bars()).toHaveLength(1);
      expect(panel().contains(bars()[0])).toBe(false);
      expect(asideSpeaker().classList.contains("is-active")).toBe(false);
    });
  });
});
