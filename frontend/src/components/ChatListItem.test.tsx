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
 * Open the row's kebab menu (the only place card actions live). The kebab is
 * hover-gated on desktop widths, which is what jsdom reports, so hover first.
 */
function openRowMenu(container: HTMLElement) {
  fireEvent.mouseEnter(container.firstElementChild!);
  fireEvent.click(screen.getByTitle("Chat actions"));
}

describe("ChatListItem card menu", () => {
  const CARD_MENU = {
    onCreate: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onToggleLifecycle: vi.fn(),
  };

  it("offers create/add for a card-less chat and nothing else", () => {
    const { container } = render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} cardMenu={CARD_MENU} />);
    openRowMenu(container);

    expect(screen.getByText("Create card")).toBeTruthy();
    expect(screen.getByText("Add to card…")).toBeTruthy();
    expect(screen.queryByText("Remove from card")).toBeNull();
    expect(screen.queryByText("Close card")).toBeNull();
  });

  it("offers close + remove for a chat on an open card", () => {
    const chat = makeChat({ metadata: JSON.stringify({ title: "My Chat", cardId: "card-1" }) });
    const { container } = render(
      <ChatListItem chat={chat} onClick={() => {}} onDelete={() => {}} cardMenu={{ ...CARD_MENU, card: { title: "Ship it", lifecycle: "open" } }} />,
    );
    openRowMenu(container);

    expect(screen.getByText("Close card")).toBeTruthy();
    expect(screen.getByText("Remove from card")).toBeTruthy();
    expect(screen.queryByText("Create card")).toBeNull();
    expect(screen.queryByText("Add to card…")).toBeNull();

    fireEvent.click(screen.getByText("Close card"));
    expect(CARD_MENU.onToggleLifecycle).toHaveBeenCalledTimes(1);
  });

  it("flips the label to Reopen for a chat on a closed card", () => {
    const chat = makeChat({ metadata: JSON.stringify({ cardId: "card-1" }) });
    const { container } = render(
      <ChatListItem chat={chat} onClick={() => {}} onDelete={() => {}} cardMenu={{ ...CARD_MENU, card: { title: "Shipped", lifecycle: "closed" } }} />,
    );
    openRowMenu(container);

    expect(screen.getByText("Reopen card")).toBeTruthy();
    expect(screen.queryByText("Close card")).toBeNull();
  });

  it("omits the lifecycle entry when the card record has not loaded", () => {
    // A dangling cardId (deleted card) or a still-in-flight fetch must never
    // render a guessed direction — remove stays available.
    const chat = makeChat({ metadata: JSON.stringify({ cardId: "card-gone" }) });
    const { container } = render(<ChatListItem chat={chat} onClick={() => {}} onDelete={() => {}} cardMenu={CARD_MENU} />);
    openRowMenu(container);

    expect(screen.queryByText("Close card")).toBeNull();
    expect(screen.queryByText("Reopen card")).toBeNull();
    expect(screen.getByText("Remove from card")).toBeTruthy();
  });

  it("treats an unassigned `cardId: null` as card-less", () => {
    const chat = makeChat({ metadata: JSON.stringify({ cardId: null }) });
    const { container } = render(<ChatListItem chat={chat} onClick={() => {}} onDelete={() => {}} cardMenu={CARD_MENU} />);
    openRowMenu(container);

    expect(screen.getByText("Create card")).toBeTruthy();
    expect(screen.queryByText("Remove from card")).toBeNull();
  });

  it("renders no card entries at all without a cardMenu", () => {
    const { container } = render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} />);
    openRowMenu(container);

    expect(screen.queryByText("Create card")).toBeNull();
    expect(screen.queryByText("Add to card…")).toBeNull();
    expect(screen.getByText("Delete")).toBeTruthy();
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
});
