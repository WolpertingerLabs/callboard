// @vitest-environment jsdom
/**
 * A fetched subtree is a snapshot. Chats spawned into an already-expanded
 * group — and status changes inside it — only reach the sidebar if the
 * expanded group refetches when the chat list refreshes. Before this, the
 * expanded body stayed frozen until a full page reload.
 *
 * `../api` is mocked so getChatTree resolves without network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, CardSummary, ChatTreeNode, ChatTreeResponse } from "../api";
import { getChatTree } from "../api";
import { isChatCardActive, isChatDimmed } from "../utils/chatDimming";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
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
 * The list renders `ChatListItem` from two places — a lone chat and a group's
 * header row — and a dim wired into only one of them is invisible until you
 * happen to look at a folder that has both.
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
    makeChat("solo-open", { rootChatId: "open-card" }),
    makeChat("solo-closed", { rootChatId: "closed-card" }),
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

/**
 * "Active cards first" over grouped rows.
 *
 * The case this exists for: a lineage group collapses into ONE row but its
 * members can straddle both buckets. Handing this component a pre-partitioned
 * array of chats would split a group's members across two sections and file
 * the group by whichever one sorted first, so it takes the predicate and
 * sections its own rows — by the header row's chat, the one on screen.
 */
describe("ChatTreeList active-first sections", () => {
  // Cards are keyed by the lineage ROOT's chat id — in these fixtures the
  // roots are their own cards, so the keys are the root chat ids themselves.
  const CARDS: ReadonlyMap<string, Pick<CardSummary, "lifecycle">> = new Map([
    ["root", { lifecycle: "open" }],
    ["solo-open", { lifecycle: "open" }],
  ]);

  /**
   * Section headers and row previews in DOM order. Order is the whole
   * assertion here — a fixture that starts in bucket order would pass with the
   * partition deleted, so every fixture below starts inactive-first.
   */
  // Lowercase-only id class, because textContent runs a row's preview straight
  // into its timestamp ("chat solo-noneJul 28…") with no separator.
  const outline = (container: HTMLElement) => container.textContent?.match(/Inactive|Active|chat [a-z0-9-]+/g) ?? [];

  function renderSectioned(chats: Chat[], sectioned = true, cards: ReadonlyMap<string, Pick<CardSummary, "lifecycle">> = CARDS) {
    return render(
      <MemoryRouter>
        <ChatTreeList
          chats={chats}
          refreshToken={0}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
          isCardActive={sectioned ? (chat) => isChatCardActive(chat, cards) : undefined}
        />
      </MemoryRouter>,
    );
  }

  // A group whose root's card is open, plus a lone row on each side of the
  // split. Listed inactive-first so any reordering is visible.
  const STRADDLING = [
    makeChat("solo-none"),
    makeChat("root"),
    makeChat("child-1", { parentChatId: "root", rootChatId: "root" }),
    makeChat("solo-open"),
  ];

  it("files a group that straddles both buckets once, in its header row's section", () => {
    const { container } = renderSectioned(STRADDLING);
    // "chat child-1" is absent throughout: it is folded into the group's one
    // row, which sits under Active with its parent — not pulled out into
    // Inactive on its own account.
    expect(outline(container)).toEqual(["Active", "chat root", "chat solo-open", "Inactive", "chat solo-none"]);
  });

  it("follows the header row when the straddle points the other way", () => {
    // Same group with the root's card not loaded (a closed or dangling card
    // reads the same here): the group goes wherever its header row goes, so
    // the whole group is Inactive even though solo-open is Active.
    const soloOpenOnly = new Map([["solo-open", { lifecycle: "open" as const }]]);
    const { container } = renderSectioned(
      [
        makeChat("solo-open"),
        makeChat("root"),
        makeChat("child-1", { parentChatId: "root", rootChatId: "root" }),
      ],
      true,
      soloOpenOnly,
    );
    expect(outline(container)).toEqual(["Active", "chat solo-open", "Inactive", "chat root"]);
  });

  it("renders no headers and the original order without the predicate", () => {
    // What the sidebar passes while the option is off — and, load-bearingly,
    // while the first listCards is still in flight: every chat looks card-less
    // then, so sectioning would file the list under Inactive and then move the
    // rows when the fetch lands.
    const { container } = renderSectioned(STRADDLING, false);
    expect(outline(container)).toEqual(["chat solo-none", "chat root", "chat solo-open"]);
  });

  it("renders no headers when every row falls in one bucket", () => {
    // No cards loaded at all: every row is Inactive, and a one-bucket list
    // must not grow a section header for it.
    const { container } = renderSectioned(
      [makeChat("solo-none"), makeChat("root"), makeChat("child-1", { parentChatId: "root", rootChatId: "root" })],
      true,
      new Map(),
    );
    expect(outline(container)).toEqual(["chat solo-none", "chat root"]);
  });

  /**
   * The header's count and its collapse toggle.
   *
   * Both have a failure mode that only grouping introduces: a group is one ROW
   * standing for several chats, so a count taken from what is rendered
   * under-reports it.
   */
  describe("counts and collapse", () => {
    // The hook caches its snapshot module-side, so clearing storage alone
    // would leave the previous test's state in memory.
    beforeEach(() => {
      localStorage.clear();
      resetChatSectionExpansion();
    });
    afterEach(() => {
      localStorage.clear();
      resetChatSectionExpansion();
    });

    // STRADDLING is 4 chats in 3 rows: the root group (root + folded child-1)
    // and solo-open under Active, solo-none under Inactive.
    it("counts chats rather than rows, so a folded group's members are included", () => {
      renderSectioned(STRADDLING);
      // 3, not 2: the group row speaks for its child as well as its header.
      expect(screen.getByText(/^Active \(3\)$/)).toBeTruthy();
      expect(screen.getByText(/^Inactive \(1\)$/)).toBeTruthy();
    });

    it("collapses a section's rows while keeping its header and count", () => {
      const { container } = renderSectioned(STRADDLING);
      fireEvent.click(screen.getByText(/^Inactive \(1\)$/));
      // The hidden row is gone from the list, but the header still says how
      // many are behind it — that count is the only thing left pointing at them.
      expect(outline(container)).toEqual(["Active", "chat root", "chat solo-open", "Inactive"]);
      expect(screen.getByText(/^Inactive \(1\)$/)).toBeTruthy();
    });

    it("remembers a collapsed section across a remount", () => {
      renderSectioned(STRADDLING);
      fireEvent.click(screen.getByText(/^Active \(3\)$/));
      cleanup();

      // This component remounting. The neighbouring case — two consumers of
      // one preference, mounted at once — lives in
      // hooks/useChatSectionExpansion.test.tsx.
      const { container } = renderSectioned(STRADDLING);
      expect(outline(container)).toEqual(["Active", "Inactive", "chat solo-none"]);
    });
  });
});
