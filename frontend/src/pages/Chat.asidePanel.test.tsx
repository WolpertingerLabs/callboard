/**
 * The aside panel on the real chat page: `?aside=<id>` opens the aside's own
 * Chat, embedded beside the main one, which stays mounted (its composer keeps
 * what was typed). The marker chip and the header list open it; forks still
 * navigate. Close and Escape close it (popping the entry the open pushed); a
 * reply in it can be inserted into the main chat's quote tray. The embedded
 * chat carries no page header and no Ask as aside of its own, and nothing
 * complains about two chat views at once. Harness as Chat.askAside.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import Chat from "./Chat";
import { getQuotes, resetQuoteTraysForTests } from "../hooks/useQuoteTray";

const Q1 = "2026-01-01T10:00:00.000Z";
const A1 = "2026-01-01T10:00:01.000Z";

const node = (chatId: string, extra: Record<string, unknown> = {}) => ({
  chatId,
  title: chatId,
  provider: "claude-code",
  status: "stopped",
  folder: "/tmp",
  createdAt: "2026-01-01T11:00:00.000Z",
  updatedAt: "",
  children: [],
  ...extra,
});
let treeChildren: ReturnType<typeof node>[] = [];

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: id, folder: "/tmp", is_git_repo: true, metadata: "{}", slash_commands: ["compact"] })),
  getChatTree: vi.fn(async (id: string) => {
    if (session.treeFails) throw new Error("tree unavailable");
    return {
      targetChatId: id,
      rootChatId: "original",
      ancestors: [],
      tree: id === "original" ? node("original", { children: treeChildren }) : node(id),
    };
  }),
  getMessages: vi.fn(async (id: string) =>
    id === "aside-boom"
      ? [{ role: "assistant", type: "text", content: "explode", timestamp: "2026-01-01T11:00:01.000Z" }]
      : id === "original"
        ? [
            { role: "user", type: "text", content: "first question", timestamp: Q1 },
            { role: "assistant", type: "text", content: "first answer", timestamp: A1 },
          ]
        : [
            { role: "user", type: "text", content: "why so?", timestamp: "2026-01-01T11:00:00.000Z" },
            { role: "assistant", type: "text", content: "because of reasons", timestamp: "2026-01-01T11:00:01.000Z" },
          ],
  ),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  stopChat: vi.fn(async () => ({ stopped: true })),
  deleteDraft: vi.fn(async () => ({})),
}));
const session = vi.hoisted(() => ({ metadataVersion: 0, treeFails: false }));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => session.metadataVersion }));
vi.mock("../components/PromptInput", async (importOriginal) => {
  const { useState } = await import("react");
  const { useEffect, useRef } = await import("react");
  type Update = string | ((current: string) => string);
  function PromptInputStub({
    accessory,
    chatId,
    onSend,
    onSetValue,
    onSnapshotRequest,
  }: {
    accessory?: ReactNode;
    chatId?: string;
    onSend?: (prompt: string) => void;
    onSetValue?: (setter: (value: Update) => void) => void;
    onSnapshotRequest?: (get: (() => { prompt: string; attachments: number }) | null) => void;
  }) {
    const [text, setText] = useState("");
    const live = useRef("");
    live.current = text;
    useEffect(() => {
      onSnapshotRequest?.(() => ({ prompt: live.current, attachments: 0 }));
      return () => onSnapshotRequest?.(null);
    }, [onSnapshotRequest]);
    useEffect(() => {
      onSetValue?.(() => (value: Update) => setText((current) => (typeof value === "function" ? value(current) : value)));
    }, [onSetValue]);
    return (
      <div data-testid={`composer-${chatId}`}>
        {accessory}
        <input aria-label="Composer" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" onClick={() => onSend?.(text)}>
          send {chatId}
        </button>
      </div>
    );
  }
  const real = await importOriginal<typeof import("../components/PromptInput")>();
  return { default: PromptInputStub, parseLeadingCommand: real.parseLeadingCommand };
});
// A bubble that crashes, for the error-boundary test: only a message reading "explode".
vi.mock("../components/MessageBubble", async (importOriginal) => {
  const real = await importOriginal<typeof import("../components/MessageBubble")>();
  const Real = real.default;
  function MaybeExplode(props: React.ComponentProps<typeof Real>) {
    if (props.message.content === "explode") throw new Error("aside bubble exploded");
    return <Real {...props} />;
  }
  return { ...real, default: MaybeExplode };
});
vi.mock("../components/GitDiffView", () => ({ default: () => <div /> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div /> }));

function LocationProbe() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="location">{pathname + search}</div>
      <button onClick={() => navigate(-1)}>history back</button>
      <button onClick={() => navigate(1)}>history forward</button>
      <button onClick={() => navigate("/chat/original")}>sidebar: this chat</button>
      <button onClick={() => navigate("/chat/other")}>sidebar: other chat</button>
    </>
  );
}

const page = (entry: string | { pathname: string; state?: unknown } = "/chat/original", before: string[] = []) => (
  <MemoryRouter initialEntries={[...before, entry]} initialIndex={before.length}>
    <Routes>
      <Route
        path="/chat/:id"
        element={
          <>
            <Chat />
            <LocationProbe />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
);
const location = () => screen.getByTestId("location").textContent;
const panel = () => screen.getByTestId("aside-panel");

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  session.metadataVersion = 0;
  session.treeFails = false;
  treeChildren = [
    node("aside-1", { role: "aside", title: "Aside: why so?", forkedAt: A1, asideQuotes: [{ timestamp: A1, role: "assistant", text: "first" }] }),
  ];
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
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("opens the aside from the URL beside the main chat, with a compact bar and no second page header", async () => {
  render(page("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  expect(screen.getByText("first answer")).toBeTruthy();
  expect(within(panel()).getByText("Aside: why so?")).toBeTruthy();
  expect(within(panel()).getByRole("button", { name: "Close aside" })).toBeTruthy();
  // One page header's worth of chrome, the main chat's.
  expect(screen.getAllByTitle("Chat permissions")).toHaveLength(1);
  expect(screen.getAllByRole("radiogroup", { name: "View mode" })).toHaveLength(1);
  // A stop button in each, for each chat's own run.
  expect(screen.getAllByTitle("No active generation")).toHaveLength(2);
  expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("already published"), expect.anything());
});

it("opens from the marker chip, keeps the main chat mounted, and closes back to where it was", async () => {
  render(page());
  await screen.findByText("first answer");
  const [mainComposer] = screen.getAllByLabelText("Composer") as HTMLInputElement[];
  fireEvent.change(mainComposer!, { target: { value: "half-typed" } });

  fireEvent.click(await screen.findByRole("button", { name: "1 aside" }));
  await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  // Not remounted: the composer still holds what was typed.
  expect((screen.getAllByLabelText("Composer")[0] as HTMLInputElement).value).toBe("half-typed");

  fireEvent.click(within(panel()).getByRole("button", { name: "Close aside" }));
  await waitFor(() => expect(location()).toBe("/chat/original"));
  expect(screen.queryByTestId("aside-panel")).toBeNull();
  expect((screen.getAllByLabelText("Composer")[0] as HTMLInputElement).value).toBe("half-typed");
});

it("closes on Escape from inside the panel", async () => {
  render(page("/chat/original?aside=aside-1"));
  const reply = await within(panel()).findByText("because of reasons");
  fireEvent.keyDown(reply, { key: "Escape" });
  await waitFor(() => expect(location()).toBe("/chat/original"));
});

it("opens asides from a mixed marker's menu, while a fork there still navigates", async () => {
  treeChildren = [...treeChildren, node("fork-1", { role: "fork", title: "A fork", forkedAt: A1 })];
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Aside: why so\?/ }));
  await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));

  fireEvent.click(screen.getByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /A fork/ }));
  await waitFor(() => expect(location()).toBe("/chat/fork-1"));
});

it("lists the chat's asides in the header, and opens the one picked", async () => {
  render(page());
  await screen.findByText("first answer");
  fireEvent.click(await screen.findByRole("button", { name: "1 aside in this chat" }));
  const menu = await screen.findByRole("menu", { name: "Asides of this chat" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Aside: why so\?/ }));
  await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
});

it("inserts an aside's reply into the main chat's tray, labelled as the aside's", async () => {
  render(page("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  // Only replies offer it, and only in the panel.
  expect(within(panel()).getAllByRole("button", { name: /Insert into main chat/ })).toHaveLength(1);
  fireEvent.click(within(panel()).getByRole("button", { name: /Insert into main chat/ }));
  expect(getQuotes("original")).toMatchObject([{ text: "because of reasons", fromChatId: "aside-1", label: "Aside reply", messageIndex: -1 }]);
  expect(getQuotes("aside-1")).toHaveLength(0);
  // The main composer's tray shows it; a second click adds nothing.
  await within(screen.getByTestId("composer-original")).findByTestId("quote-chip");
  fireEvent.click(within(panel()).getByRole("button", { name: /Inserted into main chat/ }));
  await within(panel()).findByText("Already in main chat");
  expect(getQuotes("original")).toHaveLength(1);
});

it("offers no Ask as aside inside the panel", async () => {
  render(page("/chat/original?aside=aside-1"));
  await within(panel()).findByText("because of reasons");
  // A quote in the aside's own tray shows its chip but no aside controls.
  const reply = within(panel()).getByText("because of reasons");
  const text = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT).nextNode()!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 7);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
  await within(screen.getByTestId("composer-aside-1")).findByTestId("quote-chip");
  expect(within(panel()).queryByRole("button", { name: /Ask as aside/ })).toBeNull();
  window.getSelection()!.removeAllRanges();
});

describe("panel lifecycle", () => {
  const openFromChip = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "1 aside" }));
    await within(panel()).findByText("because of reasons");
  };

  it("closes on Back and reopens on Forward", async () => {
    render(page());
    await openFromChip();
    fireEvent.click(screen.getByText("history back"));
    await waitFor(() => expect(location()).toBe("/chat/original"));
    expect(screen.queryByTestId("aside-panel")).toBeNull();
    fireEvent.click(screen.getByText("history forward"));
    await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
    await within(panel()).findByText("because of reasons");
  });

  it("switches by replacing, so one close (even clicked twice) leaves the panel", async () => {
    treeChildren = [...treeChildren, node("aside-2", { role: "aside", title: "Aside: second", forkedAt: Q1 })];
    render(page());
    await screen.findByText("first answer");
    fireEvent.click(await screen.findByRole("button", { name: /^2 asides in this chat/ }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Asides of this chat" })).getByRole("menuitem", { name: /why so/ }));
    await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
    fireEvent.click(screen.getByRole("button", { name: /^2 asides in this chat/ }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Asides of this chat" })).getByRole("menuitem", { name: /Aside: second/ }));
    await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-2"));
    const close = within(panel()).getByRole("button", { name: "Close aside" });
    fireEvent.click(close);
    fireEvent.click(close);
    await waitFor(() => expect(location()).toBe("/chat/original"));
    // Popped once: there is no further entry of this page to go back to.
    expect(screen.getByText("first answer")).toBeTruthy();
    fireEvent.click(screen.getByText("history forward"));
    await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-2"));
  });

  it("closes, in place, an aside id that is this chat", async () => {
    render(page("/chat/original?aside=original"));
    await screen.findByText("first answer");
    await waitFor(() => expect(location()).toBe("/chat/original"));
    expect(screen.queryByTestId("aside-panel")).toBeNull();
  });

  it("closes a chat the tree does not list as this chat's aside, and never labels its replies an aside's", async () => {
    render(page("/chat/original?aside=stranger"));
    await waitFor(() => expect(location()).toBe("/chat/original"));
    expect(screen.queryByTestId("aside-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: /Insert into main chat/ })).toBeNull();
  });

  it("closes an aside archived while it is open, once a tree says so", async () => {
    const { rerender } = render(page("/chat/original?aside=aside-1"));
    await within(panel()).findByText("because of reasons");
    treeChildren = treeChildren.map((c) => ({ ...c, childArchived: true }));
    // Past the tree's refresh throttle (one fetch per 10s), so the metadata
    // event's refetch goes out after the 1s floor rather than 10s.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 20_000);
    session.metadataVersion = 1;
    rerender(page("/chat/original?aside=aside-1"));
    await waitFor(() => expect(location()).toBe("/chat/original"), { timeout: 4000 });
    expect(screen.queryByTestId("aside-panel")).toBeNull();
  });

  it("goes with its chat: switching to another chat leaves no panel", async () => {
    render(page());
    await openFromChip();
    fireEvent.click(screen.getByText("sidebar: other chat"));
    await waitFor(() => expect(location()).toBe("/chat/other"));
    expect(screen.queryByTestId("aside-panel")).toBeNull();
  });

  it("keeps an opened Staging draft open across the panel opening and closing", async () => {
    const { deleteDraft } = await import("../api");
    render(page({ pathname: "/chat/original", state: { draft: { id: "draft-1", user_message: "from staging" } } }));
    await waitFor(() => expect((screen.getAllByLabelText("Composer")[0] as HTMLInputElement).value).toBe("from staging"));
    await openFromChip();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close aside" }));
    await waitFor(() => expect(location()).toBe("/chat/original"));
    // Still the draft's view: sending it retires the Staging draft.
    fireEvent.click(screen.getByText("send original"));
    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("draft-1"));
  });

  it("lets go of the Staging draft on a sidebar click to the same chat, panel open or not", async () => {
    const { deleteDraft } = await import("../api");
    render(page({ pathname: "/chat/original", state: { draft: { id: "draft-1", user_message: "from staging" } } }));
    await waitFor(() => expect((screen.getAllByLabelText("Composer")[0] as HTMLInputElement).value).toBe("from staging"));
    await openFromChip();
    fireEvent.click(screen.getByText("sidebar: this chat"));
    await waitFor(() => expect(location()).toBe("/chat/original"));
    fireEvent.click(screen.getByText("send original"));
    await act(async () => {});
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("saves what is typed in the panel before opening the aside as a full chat", async () => {
    render(page("/chat/original?aside=aside-1"));
    await within(panel()).findByText("because of reasons");
    // Typed, and (in this stub) never saved by a composer debounce of its own.
    fireEvent.change(within(panel()).getByLabelText("Composer"), { target: { value: "half a follow-up" } });
    const { getComposerDraft } = await import("../utils/localStorage");
    expect(getComposerDraft("aside-1")).toBe("");
    fireEvent.click(within(panel()).getByRole("button", { name: "Open as full chat" }));
    await waitFor(() => expect(location()).toBe("/chat/aside-1"));
    expect(getComposerDraft("aside-1")).toBe("half a follow-up");
  });
});

describe("clicking a highlight", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { highlights: new Map() });
    vi.stubGlobal(
      "Highlight",
      class {
        ranges: Range[];
        priority = 0;
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      },
    );
    // jsdom has no layout: every range sits in one box.
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [{ left: 10, right: 100, top: 10, bottom: 20 }],
    });
  });
  afterEach(() => {
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  });

  const setup = async () => {
    render(page());
    const answer = await screen.findByText("first answer");
    // The quote is painted (one frame).
    await waitFor(() => expect((globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights.has("aside-quote")).toBe(true));
    return answer;
  };
  const press = (el: Element, init: { x?: number; y?: number; detail?: number; downX?: number } = {}) => {
    fireEvent.mouseDown(el, { clientX: init.downX ?? init.x ?? 20, clientY: 15, button: 0 });
    fireEvent.click(el, { clientX: init.x ?? 20, clientY: 15, button: 0, detail: init.detail ?? 1 });
  };

  it("opens the aside on a plain click", async () => {
    press(await setup());
    await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
  });

  // Past the wait a single click gets, so a later assertion sees whatever it was going to do.
  const pastClickDelay = () => act(() => new Promise((resolve) => setTimeout(resolve, 450)));

  it("does not on a real double click — a detail-1 click, then a detail-2 one", async () => {
    const answer = await setup();
    // What a browser sends for a double click: two presses, two clicks.
    press(answer, { detail: 1 });
    press(answer, { detail: 2 });
    fireEvent.dblClick(answer, { clientX: 20, clientY: 15, button: 0, detail: 2 });
    await pastClickDelay();
    expect(location()).toBe("/chat/original");
  });

  it("does not on a drag, nor on the click that clears a selection", async () => {
    const answer = await setup();
    press(answer, { downX: 60, x: 20 });
    await pastClickDelay();
    expect(location()).toBe("/chat/original");
    const range = document.createRange();
    range.selectNodeContents(answer);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseDown(answer, { clientX: 20, clientY: 15, button: 0 });
    window.getSelection()!.removeAllRanges(); // the press collapsed it
    fireEvent.click(answer, { clientX: 20, clientY: 15, button: 0, detail: 1 });
    await pastClickDelay();
    expect(location()).toBe("/chat/original");
  });
});

describe("panel containment", () => {
  it("keeps the main chat when the aside crashes", async () => {
    treeChildren = [...treeChildren, node("aside-boom", { role: "aside", title: "Aside: boom", forkedAt: A1 })];
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(page("/chat/original?aside=aside-boom"));
    expect(await within(panel()).findByText(/This aside/)).toBeTruthy();
    expect(screen.getByText("first answer")).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("makes the main chat inert under the mobile sheet, and only while it is open", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    render(page("/chat/original?aside=aside-1"));
    await within(panel()).findByText("because of reasons");
    const sheet = screen.getByRole("dialog", { name: "Aside: why so?" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    const main = document.querySelector(".chat-page > .chat-layout")!;
    expect(main.hasAttribute("inert")).toBe(true);
    fireEvent.click(within(panel()).getByRole("button", { name: "Close aside" }));
    await waitFor(() => expect(main.hasAttribute("inert")).toBe(false));
  });

  it("scrolls the aside, not the main chat, for keys aimed at the panel itself", async () => {
    render(page("/chat/original?aside=aside-1"));
    await within(panel()).findByText("because of reasons");
    fireEvent.keyDown(panel(), { key: "PageUp" });
    expect(await within(panel()).findByTitle("Scroll to bottom and resume auto-scroll")).toBeTruthy();
    const main = document.querySelector(".chat-page > .chat-layout")!;
    expect(within(main as HTMLElement).queryByTitle("Scroll to bottom and resume auto-scroll")).toBeNull();
  });
});

describe("judging the open aside (round 2)", () => {
  /** A metadata event, past the tree's 10s throttle, so the refetch goes out after its 1s floor. */
  const treeChangedOnServer = (rerender: (ui: React.ReactElement) => void, ui: () => React.ReactElement) => {
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 20_000 * (session.metadataVersion + 1));
    session.metadataVersion += 1;
    // A fresh element: the same one again would be skipped, and never read the version.
    rerender(ui());
  };

  it("closes an aside opened from the URL whose tree, asked for after, fails — it does not stay pending", async () => {
    session.treeFails = true;
    render(page("/chat/original?aside=aside-1"));
    await waitFor(() => expect(location()).toBe("/chat/original"));
    expect(screen.queryByTestId("aside-panel")).toBeNull();
  });

  it("judges a Forward back to an aside by a fresh tree, not the one it was first opened with", async () => {
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: "1 aside" }));
    await within(panel()).findByText("because of reasons");
    fireEvent.click(screen.getByText("history back"));
    await waitFor(() => expect(location()).toBe("/chat/original"));
    // Archived while the panel was closed; this page has not heard yet.
    treeChildren = treeChildren.map((c) => ({ ...c, childArchived: true }));
    fireEvent.click(screen.getByText("history forward"));
    // Popped back off once the fresh tree says it is no aside of this chat's any more.
    await waitFor(() => expect(location()).toBe("/chat/original"), { timeout: 3000 });
    expect(screen.queryByTestId("aside-panel")).toBeNull();
  });

  it("pops the entry it pushed when the opened aside turns out invalid, leaving no duplicate behind", async () => {
    const ui = () => page("/chat/original", ["/chat/start"]);
    const { rerender } = render(ui());
    fireEvent.click(await screen.findByRole("button", { name: "1 aside" }));
    await waitFor(() => expect(location()).toBe("/chat/original?aside=aside-1"));
    // Split off on the server while open.
    treeChildren = [];
    treeChangedOnServer(rerender, ui);
    await waitFor(() => expect(location()).toBe("/chat/original"), { timeout: 4000 });
    // One Back goes to where the user came from — not to a second /chat/original.
    fireEvent.click(screen.getByText("history back"));
    await waitFor(() => expect(location()).toBe("/chat/start"));
  });
});
