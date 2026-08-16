// @vitest-environment jsdom
/**
 * A fetched subtree is a snapshot. Chats spawned into an already-expanded
 * group — and status changes inside it — only reach the sidebar if the
 * expanded group refetches when the chat list refreshes. Before this, the
 * expanded body stayed frozen until a full page reload.
 *
 * `../api` is mocked so getChatTree resolves without network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, CardSummary, ChatTreeNode, ChatTreeResponse } from "../api";
import { getChatTree } from "../api";
import { isChatDimmed } from "../utils/chatDimming";
import ChatTreeList from "./ChatTreeList";

vi.mock("../api", () => ({
  getChatTree: vi.fn(),
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

const mockGetChatTree = vi.mocked(getChatTree);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FOLDER = "/home/cybil/projects/callboard";

function makeChat(id: string, meta: Record<string, unknown> = {}): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    created_at: "2026-07-28T10:00:00Z",
    updated_at: "2026-07-28T10:00:00Z",
    metadata: JSON.stringify({ preview: `chat ${id}`, ...meta }),
  } as Chat;
}

function makeNode(chatId: string, title: string, overrides: Partial<ChatTreeNode> = {}): ChatTreeNode {
  return {
    chatId,
    title,
    provider: "claude-code",
    status: "stopped",
    folder: FOLDER,
    createdAt: "2026-07-28T10:00:00Z",
    updatedAt: "2026-07-28T10:00:00Z",
    children: [],
    ...overrides,
  };
}

function makeTree(root: ChatTreeNode): ChatTreeResponse {
  return { targetChatId: root.chatId, rootChatId: root.chatId, ancestors: [], tree: root };
}

/** Parent + child => one group row with an expand chevron. */
const GROUP_CHATS = [makeChat("root"), makeChat("child-1", { parentChatId: "root", rootChatId: "root" })];

function renderTree(props: { chats?: Chat[]; refreshToken: number }) {
  return render(
    <MemoryRouter>
      <ChatTreeList
        chats={props.chats ?? GROUP_CHATS}
        refreshToken={props.refreshToken}
        onChatClick={() => {}}
        onDelete={() => {}}
        onToggleBookmark={() => {}}
        cardMenuFor={() => ({})}
        sessionStatusFor={() => undefined}
      />
    </MemoryRouter>,
  );
}

async function expandGroup() {
  const chevron = await screen.findByTitle("Expand chat tree");
  chevron.click();
}

describe("ChatTreeList refresh", () => {
  it("refetches an expanded group when the chat list refreshes, showing chats spawned since", async () => {
    mockGetChatTree.mockResolvedValueOnce(makeTree(makeNode("root", "Root chat", { children: [makeNode("child-1", "Implementer")] })));

    const { rerender } = renderTree({ refreshToken: 0 });
    await expandGroup();
    await screen.findByText("Implementer");
    expect(screen.queryByText("Reviewer")).toBeNull();

    // A new child chat was spawned into the expanded group.
    mockGetChatTree.mockResolvedValueOnce(
      makeTree(makeNode("root", "Root chat", { children: [makeNode("child-1", "Implementer"), makeNode("child-2", "Reviewer", { status: "ongoing" })] })),
    );
    rerender(
      <MemoryRouter>
        <ChatTreeList
          chats={[...GROUP_CHATS, makeChat("child-2", { parentChatId: "root", rootChatId: "root" })]}
          refreshToken={1}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
        />
      </MemoryRouter>,
    );

    await screen.findByText("Reviewer");
    expect(mockGetChatTree).toHaveBeenCalledTimes(2);
  });

  it("does not fetch anything on refresh while every group is collapsed", async () => {
    const { rerender } = renderTree({ refreshToken: 0 });
    rerender(
      <MemoryRouter>
        <ChatTreeList
          chats={GROUP_CHATS}
          refreshToken={1}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockGetChatTree).not.toHaveBeenCalled());
  });

  it("drops the cached tree of a collapsed group so re-expanding refetches", async () => {
    mockGetChatTree.mockResolvedValue(makeTree(makeNode("root", "Root chat", { children: [makeNode("child-1", "Implementer")] })));

    const { rerender } = renderTree({ refreshToken: 0 });
    await expandGroup();
    await screen.findByText("Implementer");

    (await screen.findByTitle("Collapse chat tree")).click();
    await waitFor(() => expect(screen.queryByText("Implementer")).toBeNull());

    rerender(
      <MemoryRouter>
        <ChatTreeList
          chats={GROUP_CHATS}
          refreshToken={1}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
        />
      </MemoryRouter>,
    );

    await expandGroup();
    await waitFor(() => expect(mockGetChatTree).toHaveBeenCalledTimes(2));
  });
});

/**
 * The tree layout renders `ChatListItem` from two places — a lone chat and a
 * group's header row — and a dim wired into only one of them is invisible
 * until you happen to look at a folder that has both.
 *
 * Driven by the real `isChatDimmed` rather than a hand-written predicate, so
 * the first-paint case is the genuine one: `cards` is empty *and* the fetch has
 * not returned, which is the state the sidebar is in on every mount.
 */
describe("ChatTreeList dimming", () => {
  const CARDS: ReadonlyMap<string, Pick<CardSummary, "lifecycle">> = new Map([
    ["open-card", { lifecycle: "open" }],
    ["closed-card", { lifecycle: "closed" }],
  ]);

  // A group (root + child, so the header row is a ChatListItem) plus three lone
  // rows: one on an open card, one on a closed card, one filed nowhere.
  const MIXED = [
    makeChat("root"),
    makeChat("child-1", { parentChatId: "root", rootChatId: "root" }),
    makeChat("solo-open", { cardId: "open-card" }),
    makeChat("solo-closed", { cardId: "closed-card" }),
    makeChat("solo-none"),
  ];

  function renderMixed(ctx: { dimCardless: boolean; cardsLoaded: boolean }, cards = CARDS) {
    return render(
      <MemoryRouter>
        <ChatTreeList
          chats={MIXED}
          refreshToken={0}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
          isDimmed={(chat) => isChatDimmed(chat, cards, ctx)}
        />
      </MemoryRouter>,
    );
  }

  /** Which rows came out faded, named by the preview text each row renders. */
  const dimmedRows = (container: HTMLElement) =>
    [...container.querySelectorAll(".chatlist-item-dimmed")].map((el) => el.textContent?.match(/chat [\w-]+/)?.[0]).sort();

  it("dims no row before the first listCards returns", () => {
    const { container } = renderMixed({ dimCardless: true, cardsLoaded: false }, new Map());
    expect(dimmedRows(container)).toEqual([]);
    // Control for the assertion itself: the very same rows, once loaded, are
    // not all undimmed — so an empty result above is the flag, not the matcher.
    cleanup();
    expect(dimmedRows(renderMixed({ dimCardless: true, cardsLoaded: true }).container).length).toBeGreaterThan(0);
  });

  it("dims the card-less and closed-card rows in both render paths, and leaves the open-card row alone", () => {
    const { container } = renderMixed({ dimCardless: true, cardsLoaded: true });
    // "chat root" is the group header row (ChatListItem inside a group);
    // "chat solo-*" are lone rows. Both paths appear here.
    expect(dimmedRows(container)).toEqual(["chat root", "chat solo-closed", "chat solo-none"]);
  });

  it("dims nothing while the option is off", () => {
    const { container } = renderMixed({ dimCardless: false, cardsLoaded: true });
    expect(dimmedRows(container)).toEqual([]);
  });
});
