// @vitest-environment jsdom
/**
 * UI tests for the sidebar chat row:
 *
 *  - the kebab menu is the single home for card (ticket) actions, so which
 *    entries it offers is decided by whether the chat is already filed and
 *    whether its card record has loaded;
 *  - the folder pill shows the last path segment, and clicking it reveals the
 *    full path WITHOUT triggering the parent card's onClick (so tapping the
 *    pill on mobile never opens the chat).
 *
 * The `../api` module is mocked so dismissSummon resolves without network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Chat } from "../api";
import ChatListItem from "./ChatListItem";

vi.mock("../api", () => ({
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FULL_PATH = "/home/cybil/projects/my-cool-repo";

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    folder: FULL_PATH,
    displayFolder: FULL_PATH,
    session_id: "sess-1",
    session_log_path: null,
    metadata: JSON.stringify({ title: "My Chat" }),
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-21T00:00:00.000Z",
    git_branch: "main",
    ...overrides,
  };
}

/**
 * A job-step row as the list route serves one: triggered, and flagged
 * `jobRunNeedsYou` only if it is the run's elected representative. The route
 * attaches no run status to a chat row, so neither does this.
 */
function jobChat({ id = "chat-1", needsYou }: { id?: string; needsYou: boolean }): Chat {
  return makeChat({
    id,
    metadata: JSON.stringify({
      title: "My Chat",
      triggered: true,
      jobRunId: "run-1",
      jobStepId: "deploy",
      ...(needsYou && { jobRunNeedsYou: true }),
    }),
  });
}

/**
 * Open the row's kebab menu (the only place card actions live). The kebab is
 * hover-gated on desktop widths, which is what jsdom reports, so hover first.
 */
function openRowMenu(container: HTMLElement) {
  fireEvent.mouseEnter(container.firstElementChild!);
  fireEvent.click(screen.getByTitle("Chat actions"));
}

describe("ChatListItem card menu", () => {
  const CARD_MENU = {
    onToggleLifecycle: vi.fn(),
  };

  it("offers close for a chat on an open card", () => {
    const chat = makeChat({ metadata: JSON.stringify({ title: "My Chat", rootChatId: "card-1" }) });
    const { container } = render(
      <ChatListItem chat={chat} onClick={() => {}} onDelete={() => {}} cardMenu={{ ...CARD_MENU, card: { title: "Ship it", lifecycle: "open" } }} />,
    );
    openRowMenu(container);

    expect(screen.getByText("Close card")).toBeTruthy();

    fireEvent.click(screen.getByText("Close card"));
    expect(CARD_MENU.onToggleLifecycle).toHaveBeenCalledTimes(1);
  });

  it("flips the label to Reopen for a chat on a closed card", () => {
    const chat = makeChat({ metadata: JSON.stringify({ rootChatId: "card-1" }) });
    const { container } = render(
      <ChatListItem chat={chat} onClick={() => {}} onDelete={() => {}} cardMenu={{ ...CARD_MENU, card: { title: "Shipped", lifecycle: "closed" } }} />,
    );
    openRowMenu(container);

    expect(screen.getByText("Reopen card")).toBeTruthy();
    expect(screen.queryByText("Close card")).toBeNull();
  });

  it("omits the lifecycle entry when the card record has not loaded", () => {
    // A root whose card has not been fetched (or a triggered chat, which is
    // no card at all) must never render a guessed direction.
    const chat = makeChat({ metadata: JSON.stringify({ rootChatId: "card-gone" }) });
    const { container } = render(<ChatListItem chat={chat} onClick={() => {}} onDelete={() => {}} cardMenu={CARD_MENU} />);
    openRowMenu(container);

    expect(screen.queryByText("Close card")).toBeNull();
    expect(screen.queryByText("Reopen card")).toBeNull();
  });

  it("renders no card entries at all without a cardMenu", () => {
    const { container } = render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} />);
    openRowMenu(container);

    expect(screen.queryByText("Close card")).toBeNull();
    expect(screen.queryByText("Reopen card")).toBeNull();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  /**
   * The menu is portaled to the body, so its two stopPropagation calls look
   * vestigial — the popup is visibly outside the row. They are not: React
   * bubbles synthetic events through the fiber tree, which the portal leaves
   * intact, so without them every menu click would also open the chat. These
   * two cases are what makes deleting either guard fail.
   */
  it("does not open the chat when a menu entry is clicked", () => {
    const onClick = vi.fn();
    const { container } = render(
      <ChatListItem chat={makeChat()} onClick={onClick} onDelete={() => {}} cardMenu={{ ...CARD_MENU, card: { title: "Ship it", lifecycle: "open" } }} />,
    );
    openRowMenu(container);

    fireEvent.click(screen.getByText("Close card"));

    expect(CARD_MENU.onToggleLifecycle).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("closes on a click-away without opening the chat", () => {
    const onClick = vi.fn();
    const { container } = render(<ChatListItem chat={makeChat()} onClick={onClick} onDelete={() => {}} />);
    openRowMenu(container);

    // The click-away overlay covers the viewport and carries no text; z-index
    // 50 is what distinguishes it from the menu shell above it at 51.
    const overlay = Array.from(document.body.querySelectorAll("div")).find((d) => d.style.zIndex === "50");
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay!);

    expect(screen.queryByText("Delete")).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });
});

/**
 * `dimmed` arrives already decided (utils/chatDimming has that half); what is
 * tested here is the veto — the row states that must stay at full opacity
 * however card-less they are, because a faded row you are being asked to look
 * at is the exact inverse of the option's purpose.
 *
 * Every case renders an undimmed control alongside, so an assertion that
 * silently matched every row could not pass.
 */
describe("ChatListItem dimming", () => {
  const DIM_CLASS = "chatlist-item-dimmed";
  const row = (el: HTMLElement) => el.firstElementChild!;

  it("fades a dimmed row and leaves an undimmed one alone", () => {
    const { container: dim } = render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} dimmed />);
    const { container: control } = render(<ChatListItem chat={makeChat({ id: "chat-2" })} onClick={() => {}} onDelete={() => {}} dimmed={false} />);

    expect(row(dim).className).toContain(DIM_CLASS);
    expect(row(control).className).not.toContain(DIM_CLASS);
  });

  it("never fades the active row", () => {
    const { container: active } = render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} dimmed isActive />);
    const { container: control } = render(<ChatListItem chat={makeChat({ id: "chat-2" })} onClick={() => {}} onDelete={() => {}} dimmed />);

    expect(row(active).className).not.toContain(DIM_CLASS);
    // The control proves `dimmed` was doing something in the first place.
    expect(row(control).className).toContain(DIM_CLASS);
  });

  it("never fades a row holding a summon", () => {
    const summoned = makeChat({
      metadata: JSON.stringify({ title: "My Chat", summon: { message: "need a decision", urgency: "normal", createdAt: "2026-06-21T00:00:00.000Z" } }),
    });
    const { container: withSummon } = render(<ChatListItem chat={summoned} onClick={() => {}} onDelete={() => {}} dimmed />);
    const { container: control } = render(<ChatListItem chat={makeChat({ id: "chat-2" })} onClick={() => {}} onDelete={() => {}} dimmed />);

    expect(row(withSummon).className).not.toContain(DIM_CLASS);
    expect(row(control).className).toContain(DIM_CLASS);
  });

  it("never fades a row with unread output", () => {
    // hasUnread is updated_at > lastReadAt; the control chat below was read
    // after its last update, so only the first row is unread.
    const unread = makeChat({ metadata: JSON.stringify({ title: "My Chat", lastReadAt: "2026-06-20T00:00:00.000Z" }) });
    const read = makeChat({ id: "chat-2", metadata: JSON.stringify({ title: "Other", lastReadAt: "2026-06-22T00:00:00.000Z" }) });
    const { container: withUnread } = render(<ChatListItem chat={unread} onClick={() => {}} onDelete={() => {}} dimmed />);
    const { container: control } = render(<ChatListItem chat={read} onClick={() => {}} onDelete={() => {}} dimmed />);

    expect(row(withUnread).className).not.toContain(DIM_CLASS);
    expect(row(control).className).toContain(DIM_CLASS);
  });

  it("never fades the row a job run is waiting on for approval", () => {
    // The control is another step chat of the same run: it carries the runId
    // and the status, but not the representative's flag, so it still fades.
    const { container: parked } = render(<ChatListItem chat={jobChat({ needsYou: true })} onClick={() => {}} onDelete={() => {}} dimmed />);
    const { container: control } = render(
      <ChatListItem chat={jobChat({ id: "chat-2", needsYou: false })} onClick={() => {}} onDelete={() => {}} dimmed />,
    );

    expect(row(parked).className).not.toContain(DIM_CLASS);
    expect(row(control).className).toContain(DIM_CLASS);
  });

  it("opens the kebab menu outside the faded row", () => {
    // `opacity` applies to every descendant and `position: fixed` does not opt
    // out of it, so a menu rendered inside the row would inherit the fade and
    // be see-through. Containment, not a style assertion: jsdom computes no
    // inherited alpha, so only the DOM position can catch the regression.
    const { container } = render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} dimmed />);
    openRowMenu(container);

    expect(row(container).className).toContain(DIM_CLASS);
    // The title is this case's control: it proves row() still resolves to the
    // node carrying the fade, so the menu's absence below means "portaled out"
    // rather than "asserted against the wrong element".
    expect(row(container).contains(screen.getByText("My Chat"))).toBe(true);
    expect(row(container).contains(screen.getByText("Delete"))).toBe(false);
  });
});

/**
 * "Needs you" is a property of the run, but a run owns every chat it ever
 * opened — a step per attempt, a chat per parallel branch, plus the approval
 * notifier's. The list route therefore elects one representative row and marks
 * only that one with `jobRunNeedsYou`; every other row of the same run is
 * indistinguishable from it in metadata and must stay an ordinary job badge.
 * These tests pin that the component keys off that flag alone.
 */
describe("ChatListItem job badge", () => {
  it("shows the step id for an ordinary job row", () => {
    render(<ChatListItem chat={jobChat({ needsYou: false })} onClick={() => {}} onDelete={() => {}} />);

    expect(screen.getByText("deploy")).toBeTruthy();
    expect(screen.queryByText("needs you")).toBeNull();
  });

  it("swaps the label and says why in the tooltip on the representative row", () => {
    render(<ChatListItem chat={jobChat({ needsYou: true })} onClick={() => {}} onDelete={() => {}} />);

    expect(screen.getByText("needs you")).toBeTruthy();
    expect(screen.queryByText("deploy")).toBeNull();
    // The step id and run id are still reachable, just demoted to the tooltip.
    expect(screen.getByTitle(/Waiting for your approval.*deploy.*run-1/)).toBeTruthy();
  });

  it("keeps a waiting_approval row that is not the representative ordinary", () => {
    // The whole point of the second key: same run, same status, different row.
    render(<ChatListItem chat={jobChat({ needsYou: false })} onClick={() => {}} onDelete={() => {}} />);

    expect(screen.queryByText("needs you")).toBeNull();
    expect(screen.getByTitle("Job step: deploy (run run-1)")).toBeTruthy();
  });
});

describe("ChatListItem folder pill", () => {
  it("renders the last path segment", () => {
    render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} />);
    expect(screen.getByText("my-cool-repo")).toBeTruthy();
  });

  it("clicking the pill reveals the full path and does not fire the card onClick", () => {
    const onClick = vi.fn();
    render(<ChatListItem chat={makeChat()} onClick={onClick} onDelete={() => {}} />);

    // Full path bubble is not shown initially.
    expect(screen.queryByText(FULL_PATH)).toBeNull();

    fireEvent.click(screen.getByText("my-cool-repo"));

    // Bubble now shows the full path...
    expect(screen.getByText(FULL_PATH)).toBeTruthy();
    // ...and the parent card's onClick was NOT called.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("opens the path bubble outside a faded row", () => {
    // Same trap as the kebab menu: the bubble is `fixed`, but a dimmed row's
    // `opacity` fades every descendant regardless of positioning, so a bubble
    // left inside the row renders see-through.
    const { container } = render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} dimmed />);
    const rowEl = container.firstElementChild!;

    fireEvent.click(screen.getByText("my-cool-repo"));

    expect(rowEl.className).toContain("chatlist-item-dimmed");
    // Control: the pill itself stays in the faded row, so the bubble's absence
    // is the portal and not a mis-targeted assertion.
    expect(rowEl.contains(screen.getByText("my-cool-repo"))).toBe(true);
    expect(rowEl.contains(screen.getByText(FULL_PATH))).toBe(false);
  });

  it("keeps the bubble open when the path itself is clicked", () => {
    // The click-away listener is native, so it tests real DOM containment —
    // which the portal breaks. Selecting the path must not dismiss it.
    render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} />);
    fireEvent.click(screen.getByText("my-cool-repo"));

    fireEvent.click(screen.getByText(FULL_PATH));
    expect(screen.queryByText(FULL_PATH)).toBeTruthy();

    // Control: a click genuinely outside still closes it.
    fireEvent.click(document.body);
    expect(screen.queryByText(FULL_PATH)).toBeNull();
  });
});
