import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Scroll test", folder: "/tmp", is_git_repo: false, metadata: "{}" })),
  getMessages: vi.fn(async () => []),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", () => ({ default: () => <textarea aria-label="Composer" /> }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => null }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => null }));

const JUMP_BUTTON = "Scroll to bottom and resume auto-scroll";

// jsdom has no layout: scrollTop stores whatever it is assigned and
// scrollHeight/clientHeight are 0. Give the chat scroller browser-like
// geometry — a clamped scrollTop over a settable content height — so the
// pin loop's `scrollTop = huge` lands on the real bottom like it does live.
function mockGeometry(el: HTMLElement, opts: { scrollHeight: number; clientHeight: number }) {
  const geo = { ...opts, scrollTop: 0 };
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => geo.clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => geo.scrollHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => geo.scrollTop,
    set: (v: number) => {
      geo.scrollTop = Math.max(0, Math.min(v, geo.scrollHeight - geo.clientHeight));
    },
  });
  return {
    get maxScrollTop() {
      return geo.scrollHeight - geo.clientHeight;
    },
    get fromBottom() {
      return geo.scrollHeight - geo.scrollTop - geo.clientHeight;
    },
    grow(px: number) {
      geo.scrollHeight += px;
    },
    // User scrolls to `top` (a wheel already told the latch logic the direction)
    scrollTo(top: number) {
      geo.scrollTop = top;
      fireEvent.scroll(el);
    },
  };
}

const frames = (n: number) => act(() => vi.advanceTimersByTime(16 * n));

async function mountLatched() {
  render(
    <MemoryRouter initialEntries={["/chat/c1"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  const composer = await screen.findByLabelText("Composer");
  const scroller = composer.closest(".chat-layout")!.querySelector<HTMLElement>("div[style*='overflow: auto']")!;
  expect(scroller).toBeTruthy();
  const geo = mockGeometry(scroller, { scrollHeight: 2000, clientHeight: 500 });
  await frames(2);
  expect(scroller.scrollTop).toBe(geo.maxScrollTop); // opening a chat starts pinned
  return { scroller, geo };
}

function wheel(el: HTMLElement, deltaY: number) {
  fireEvent.wheel(el, { deltaY, deltaX: 0 });
}

// Unlatch by reading upward, then read back down to `fromBottom` px above
// the bottom — inside the latch zone when fromBottom <= 100.
async function readDownTo(scroller: HTMLElement, geo: ReturnType<typeof mockGeometry>, fromBottom: number) {
  wheel(scroller, -100);
  geo.scrollTo(900);
  await frames(2);
  expect(screen.getByTitle(JUMP_BUTTON)).toBeTruthy();
  wheel(scroller, 100);
  geo.scrollTo(1300);
  geo.scrollTo(geo.maxScrollTop - fromBottom);
  await frames(3);
}

beforeEach(() => {
  // Only the frame clock is faked: testing-library's findBy* polls on real
  // setTimeout, and the latch logic's own timers are not under test here.
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("auto-scroll re-latch while the user reads down", () => {
  it("re-latches inside the bottom zone without moving the view, and stays put while nothing arrives", async () => {
    const { scroller, geo } = await mountLatched();
    await readDownTo(scroller, geo, 80);
    expect(screen.queryByTitle(JUMP_BUTTON)).toBeNull(); // latched
    expect(scroller.scrollTop).toBe(1420); // not moved
    await frames(30);
    expect(scroller.scrollTop).toBe(1420);
  });

  it("follows streamed content by exactly the amount that arrived, keeping the reader's distance from the bottom", async () => {
    const { scroller, geo } = await mountLatched();
    await readDownTo(scroller, geo, 80);

    geo.grow(300); // a burst of tokens
    await frames(1);
    expect(geo.fromBottom).toBe(80);
    expect(scroller.scrollTop).toBe(1720);

    // The browser reports our own move as a scroll event: it must not
    // disturb the kept distance, nor re-pin.
    fireEvent.scroll(scroller);
    geo.grow(40);
    await frames(1);
    expect(geo.fromBottom).toBe(80);

    // Reading further down inside the zone moves the kept distance
    geo.scrollTo(scroller.scrollTop + 50);
    geo.grow(100);
    await frames(1);
    expect(geo.fromBottom).toBe(30);
  });

  it("converts to a hard pin once the reader reaches the bottom", async () => {
    const { scroller, geo } = await mountLatched();
    await readDownTo(scroller, geo, 80);
    geo.scrollTo(geo.maxScrollTop);
    await frames(1);
    expect(screen.queryByTitle(JUMP_BUTTON)).toBeNull();

    geo.grow(400);
    await frames(1);
    expect(scroller.scrollTop).toBe(geo.maxScrollTop);
    // A pin also survives the viewport shrinking (mobile keyboard), which
    // follow mode deliberately ignores
    geo.grow(0);
    await frames(1);
    expect(scroller.scrollTop).toBe(geo.maxScrollTop);
  });

  it("scrolling up again inside the zone after a follow-latch unlatches normally", async () => {
    const { scroller, geo } = await mountLatched();
    await readDownTo(scroller, geo, 80);
    expect(screen.queryByTitle(JUMP_BUTTON)).toBeNull();

    wheel(scroller, -100);
    geo.scrollTo(1300);
    await frames(2);
    expect(screen.getByTitle(JUMP_BUTTON)).toBeTruthy();
    geo.grow(300);
    await frames(2);
    expect(scroller.scrollTop).toBe(1300); // unlatched: growth does not pull the view
  });

  it("the jump-to-bottom button still goes to the bottom immediately", async () => {
    const { scroller, geo } = await mountLatched();
    wheel(scroller, -100);
    geo.scrollTo(900);
    await frames(1);

    fireEvent.click(screen.getByTitle(JUMP_BUTTON));
    await frames(1);
    expect(scroller.scrollTop).toBe(geo.maxScrollTop);
    expect(screen.queryByTitle(JUMP_BUTTON)).toBeNull();
  });

  it("a wheel-down while already pinned at the bottom does not switch the pin loop into follow mode", async () => {
    const { scroller, geo } = await mountLatched();
    wheel(scroller, 50);
    geo.scrollTo(geo.maxScrollTop);
    await frames(1);
    geo.grow(400);
    await frames(1);
    expect(scroller.scrollTop).toBe(geo.maxScrollTop);
  });
});
