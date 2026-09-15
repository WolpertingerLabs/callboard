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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, CardSummary, ChatTreeNode, ChatTreeResponse } from "../api";
import { dismissSummon, getChatTree } from "../api";
import { isChatDimmed } from "../utils/chatDimming";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import ChatTreeList, { buildRows } from "./ChatTreeList";

vi.mock("../api", () => ({
  getChatTree: vi.fn(),
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

const mockGetChatTree = vi.mocked(getChatTree);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  resetChatSectionExpansion();
});

const FOLDER = "/home/cybil/projects/callboard";

/**
 * `updatedAt` defaults to one shared instant, so most fixtures here encode
 * recency purely as array order — which is what `buildRows` reads for POSITION
 * and therefore faithful. Pass it wherever a test is about a timestamp or
 * about which member is "most recent" by the clock rather than by the server's
 * ordering: with one instant for everything, a row showing the wrong chat's
 * date is indistinguishable from a row showing the right one's.
 */
function makeChat(id: string, meta: Record<string, unknown> = {}, updatedAt = "2026-07-28T10:00:00Z"): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    created_at: "2026-07-28T10:00:00Z",
    updated_at: updatedAt,
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
        onTogglePin={() => {}}
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
          onTogglePin={() => {}}
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
          onTogglePin={() => {}}
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
          onTogglePin={() => {}}
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
  const CARDS: ReadonlyMap<string, Pick<CardSummary, "lifecycle" | "hidden">> = new Map([
    // The group's root is the archived row on the header-row render path.
    ["root", { lifecycle: "closed" }],
    ["open-card", { lifecycle: "open" }],
    ["closed-card", { lifecycle: "closed" }],
    // Hidden is the other half of "archived": the server withholds a hidden
    // card's tree from cardLifecycle=unarchived, so the dim has to fade it too.
    ["hidden-card", { lifecycle: "open", hidden: true }],
  ]);

  // A group (root + child, so the header row is a ChatListItem) plus four lone
  // rows: one on an open card, one on a closed card, one on a hidden card, one
  // filed nowhere.
  const MIXED = [
    makeChat("root"),
    makeChat("child-1", { parentChatId: "root", rootChatId: "root" }),
    makeChat("solo-open", { rootChatId: "open-card" }),
    makeChat("solo-closed", { rootChatId: "closed-card" }),
    makeChat("solo-hidden", { rootChatId: "hidden-card" }),
    makeChat("solo-none"),
  ];

  function renderMixed(ctx: { cardsLoaded: boolean }, cards = CARDS) {
    return render(
      <MemoryRouter>
        <ChatTreeList
          chats={MIXED}
          refreshToken={0}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          onTogglePin={() => {}}
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
    const { container } = renderMixed({ cardsLoaded: false }, new Map());
    expect(dimmedRows(container)).toEqual([]);
    // Control for the assertion itself: the very same rows, once loaded, are
    // not all undimmed — so an empty result above is the flag, not the matcher.
    cleanup();
    expect(dimmedRows(renderMixed({ cardsLoaded: true }).container).length).toBeGreaterThan(0);
  });

  /**
   * The change of rule, at the render layer: "no card" used to fade, and now
   * only "archived card" does.
   *
   * `solo-none` is the row that swapped sides. It is what a triggered chat, a
   * job step or an unrecorded session looks like from here — nothing eligible
   * to be a card, so nothing that can be archived — and the sidebar shows it
   * undimmed and in scope by default.
   */
  it("dims the archived-card rows in both render paths, and leaves the open-card and card-less rows alone", () => {
    const { container } = renderMixed({ cardsLoaded: true });
    // "chat root" is the group header row (ChatListItem inside a group);
    // "chat solo-*" are lone rows. Both paths appear here.
    expect(dimmedRows(container)).toEqual(["chat root", "chat solo-closed", "chat solo-hidden"]);
  });

  /**
   * The archived half of the predicate, on its own and with no option gating
   * it. The test above dims three rows for two different reasons at once; here
   * every card in the fixture is present and open EXCEPT the archived one, so
   * the single faded row can only be faded for the reason this test names.
   * Stated separately because the removed switch used to be the answer to "why
   * is nothing faded?", and now there is no answer but this rule.
   */
  it("dims an archived-card row once loaded, with no option to turn it off", () => {
    const allPresentOneArchived: ReadonlyMap<string, Pick<CardSummary, "lifecycle" | "hidden">> = new Map([
      ["root", { lifecycle: "open" }],
      ["open-card", { lifecycle: "open" }],
      ["solo-none", { lifecycle: "open" }],
      ["hidden-card", { lifecycle: "open" }],
      ["closed-card", { lifecycle: "closed" }],
    ]);
    const { container } = renderMixed({ cardsLoaded: true }, allPresentOneArchived);
    expect(dimmedRows(container)).toEqual(["chat solo-closed"]);
  });
});

/**
 * The list renders rows in the order it is given them, with no bucketing of
 * any kind.
 *
 * Worth pinning because it used to do the opposite: an "Open chats first"
 * option split these same rows under Open/Archived headers. The archived rows
 * a user sees now arrive dimmed and in recency order among the open ones — the
 * sidebar asks the server not to send them at all while browsing with "Show
 * archived" off, and asks for them regardless during a content search — so a
 * header reappearing here would be a second answer to a question the dim
 * already answers.
 */
describe("ChatTreeList order", () => {
  // Lowercase-only id class, because textContent runs a row's preview straight
  // into its timestamp ("chat solo-noneJul 28…") with no separator.
  const outline = (container: HTMLElement) => container.textContent?.match(/Archived|Open|chat [a-z0-9-]+/g) ?? [];

  // A lineage group between two lone rows. Any bucketing by card state would
  // move at least one of them, since the group's root is on no card at all.
  const MIXED = [makeChat("solo-open", { rootChatId: "open-card" }), makeChat("root"), makeChat("child-1", { parentChatId: "root", rootChatId: "root" })];

  function renderRows(chats: Chat[], cards: ReadonlyMap<string, Pick<CardSummary, "lifecycle">>) {
    return render(
      <MemoryRouter>
        <ChatTreeList
          chats={chats}
          refreshToken={0}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          onTogglePin={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
          isDimmed={(chat) => isChatDimmed(chat, cards, { cardsLoaded: true })}
        />
      </MemoryRouter>,
    );
  }

  it("keeps the given order and grows no headers, whatever each row's card is doing", () => {
    // "chat child-1" is absent throughout: it is folded into its group's one
    // row, which stays where its most recent member put it.
    const { container } = renderRows(MIXED, new Map([["open-card", { lifecycle: "open" }]]));
    expect(outline(container)).toEqual(["chat solo-open", "chat root"]);
  });

  it("places a root-fronted group at its most recently updated member's position", () => {
    // The two halves of the rule pull in opposite directions here, which is
    // the point: `child-1` fixes WHERE the group sits (second, where the
    // server put it), `root` fixes WHAT the row says (last in the array, and
    // never mind that). Ordering groups by root recency instead would sink
    // this row below "chat solo-older" — an actively worked thread falling to
    // wherever its opening message left it.
    const chats = [makeChat("solo-newest"), makeChat("child-1", { parentChatId: "root", rootChatId: "root" }), makeChat("solo-older"), makeChat("root")];
    const { container } = renderRows(chats, new Map());
    expect(outline(container)).toEqual(["chat solo-newest", "chat root", "chat solo-older"]);
  });

  it("does not float the open-card row above the archived one", () => {
    const cards: ReadonlyMap<string, Pick<CardSummary, "lifecycle">> = new Map([
      ["closed-card", { lifecycle: "closed" }],
      ["open-card", { lifecycle: "open" }],
    ]);
    const { container } = renderRows([makeChat("solo-closed", { rootChatId: "closed-card" }), makeChat("solo-open", { rootChatId: "open-card" })], cards);
    // Archived first, because that is the order it was handed them in. The
    // fade is the only thing marking the difference.
    expect(outline(container)).toEqual(["chat solo-closed", "chat solo-open"]);
    expect([...container.querySelectorAll(".chatlist-item-dimmed")].length).toBe(1);
  });
});

/**
 * WHICH chat fronts a group row — the one it is labelled with and the one its
 * click opens.
 *
 * The row used to be the group's most recently updated loaded member, so
 * clicking a thread dropped you into whatever subagent had run last, several
 * levels down a tree you had not asked to enter. It is now the lineage root:
 * the same chat the expanded body renders at depth 0.
 *
 * Label and click are asserted together on purpose. Redirecting the click
 * while leaving the most-recent member's title on the row would fix the
 * navigation and leave the row lying about where it goes, so one fronting
 * chat has to answer both.
 */
describe("ChatTreeList group identity", () => {
  // Server recency order: the subagent ran last, its parent thread before
  // that, the thread's root longest ago. Under the old rule the row was
  // "chat child-2".
  const ROOT_LAST = [
    makeChat("child-2", { parentChatId: "child-1", rootChatId: "root" }),
    makeChat("child-1", { parentChatId: "root", rootChatId: "root" }),
    makeChat("root"),
  ];

  // The same tree with its root outside the loaded page — a stamped
  // `rootChatId` naming a chat this list does not hold. `lineageOf` still
  // groups both members under "root", but no row can be that chat.
  const ROOT_ABSENT = [
    makeChat("child-2", { parentChatId: "child-1", rootChatId: "root" }),
    makeChat("child-1", { parentChatId: "root", rootChatId: "root" }),
  ];

  function renderGroup(chats: Chat[], onChatClick: (chat: Chat) => void = () => {}) {
    return render(
      <MemoryRouter>
        <ChatTreeList
          chats={chats}
          refreshToken={0}
          onChatClick={onChatClick}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          onTogglePin={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
        />
      </MemoryRouter>,
    );
  }

  /** Click the row displaying `text` — the same div `openRowMenu` reaches for. */
  const clickRow = (text: string) => fireEvent.click(screen.getByText(text).closest('div[style*="border-bottom"]')!);

  it("labels a group with its root, not with its most recently updated member", () => {
    const { container } = renderGroup(ROOT_LAST);
    expect(screen.getByText("chat root")).toBeTruthy();
    expect(screen.queryByText("chat child-2")).toBeNull();
    expect(screen.queryByText("chat child-1")).toBeNull();
    // One row for the three chats — folding is unchanged, only its front is.
    expect(container.textContent?.match(/chat [a-z0-9-]+/g)).toEqual(["chat root"]);
  });

  it("opens the root when the group row is clicked", () => {
    const onChatClick = vi.fn();
    renderGroup(ROOT_LAST, onChatClick);
    clickRow("chat root");
    expect(onChatClick).toHaveBeenCalledTimes(1);
    expect(onChatClick.mock.calls[0][0]).toMatchObject({ id: "root" });
  });

  it("falls back to the most recently updated member when the root is not loaded", () => {
    const { container } = renderGroup(ROOT_ABSENT);
    // Exactly the old behaviour, and the only thing it can be: a row has to be
    // a chat the list holds, and "root" is not one of them.
    expect(screen.getByText("chat child-2")).toBeTruthy();
    expect(container.textContent?.match(/chat [a-z0-9-]+/g)).toEqual(["chat child-2"]);
  });

  it("clicks through to that fallback member rather than to a chat that does not exist", () => {
    const onChatClick = vi.fn();
    renderGroup(ROOT_ABSENT, onChatClick);
    clickRow("chat child-2");
    expect(onChatClick.mock.calls[0][0]).toMatchObject({ id: "child-2" });
  });

  it("leaves a lone chat fronting itself", () => {
    // The control: nothing about a row with no lineage changes. This chat has
    // no metadata at all, so it is not a group and takes the other branch of
    // `renderRow` entirely — the group-keyed-by-itself case is below.
    const onChatClick = vi.fn();
    renderGroup([makeChat("solo")], onChatClick);
    clickRow("chat solo");
    expect(onChatClick.mock.calls[0][0]).toMatchObject({ id: "solo" });
    expect(screen.queryByTitle("Expand chat tree")).toBeNull();
  });

  it("fronts a one-member group with itself when the chat IS its own group key", () => {
    // The degenerate case the fronting expression has to survive: a chat
    // stamped with its own id as `rootChatId` (what a card's root looks like
    // before anything is spawned off it) is a GROUP of one, so it goes down
    // the branch that looks the root up and checks membership — and finds
    // itself on both counts.
    const [row] = buildRows([makeChat("s", { rootChatId: "s" })]);
    expect(row.isGroup).toBe(true);
    expect(row.size).toBe(1);
    expect(row.chat.id).toBe("s");
    expect(row.members.map((c) => c.id)).toEqual(["s"]);

    // And it renders as a group — chevron and all — fronted by that same chat.
    const onChatClick = vi.fn();
    renderGroup([makeChat("s", { rootChatId: "s" })], onChatClick);
    expect(screen.getByTitle("Expand chat tree")).toBeTruthy();
    clickRow("chat s");
    expect(onChatClick.mock.calls[0][0]).toMatchObject({ id: "s" });
  });
});

/**
 * The membership half of the fronting rule: a row is fronted by the root only
 * when the root is filed in THIS row's group.
 *
 * `lineageOf` keys a group by walking parent pointers, and a chat whose id
 * happens to be a group's key need not be a member of that group — corrupt or
 * half-written pointers make that routine, not theoretical. Dropping the
 * membership check leaves each row labelled with a chat it does not stand for,
 * and in the mis-stamped case a loaded chat stops having a row at all.
 *
 * Every assertion here is on `buildRows` rather than on the rendered list,
 * because the failure is precisely "which chat is in which row" — the thing
 * `ChatList`'s selection and the section counts both read off these rows.
 */
describe("buildRows fronting is restricted to members", () => {
  /** Every row's front chat must be one of the chats filed under that row. */
  const frontsAreMembers = (rows: ReturnType<typeof buildRows>) => rows.every((row) => row.members.some((m) => m.id === row.chat.id));

  it("keeps each row fronted by its own member when parent pointers form a cycle", () => {
    // A → B → A. `lineageOf` stops at the revisit, so A is filed under key "B"
    // and B under key "A": each chat keys a group it is not a member of, and
    // each group's key names a loaded chat. Fronting on the id lookup alone
    // would swap the two rows' labels — every row displaying a chat that is
    // counted, selected and clicked as part of the other row.
    const rows = buildRows([makeChat("A", { parentChatId: "B" }), makeChat("B", { parentChatId: "A" })]);
    expect(rows.map((row) => row.rootKey)).toEqual(["B", "A"]);
    expect(rows.map((row) => row.chat.id)).toEqual(["A", "B"]);
    expect(frontsAreMembers(rows)).toBe(true);
  });

  it("loses no chat when a stamped rootChatId names a chat filed in another group", () => {
    // A is stamped with root B, but B's own parent pointer puts B under C. So
    // key "B" holds only A, and B is a member of C's group.
    //
    // Without the membership check, key "B"'s row fronts with B — a chat that
    // is also folded into C's row — and A, the row's only actual member,
    // appears nowhere in the sidebar. A loaded chat with no row is not a
    // cosmetic bug: there is nothing to click, nothing to select, and no
    // indication anything is missing.
    const chats = [makeChat("A", { rootChatId: "B" }), makeChat("B", { parentChatId: "C" }), makeChat("C")];
    const rows = buildRows(chats);
    expect(rows.map((row) => row.chat.id)).toEqual(["A", "C"]);
    expect(frontsAreMembers(rows)).toBe(true);
    // B fronts nothing, and is folded into C's group where it belongs.
    expect(rows.find((row) => row.rootKey === "C")!.members.map((c) => c.id)).toEqual(["B", "C"]);
    // No chat dropped out of the list: every loaded chat is in exactly one row.
    expect(rows.flatMap((row) => row.members.map((c) => c.id)).sort()).toEqual(["A", "B", "C"]);
  });
});

/**
 * WHAT a group row reports, as against what it is labelled with.
 *
 * Fronting the row with the lineage root fixed the title and the click target
 * and broke everything else the row says, because `ChatListItem` reads the
 * live-work signals off the one chat it is handed: in Callboard's spawn model
 * the root is the idle parent by construction, so a subagent's summon, a job
 * step's approval, a running session and a child's fresh output all stopped
 * reaching the row that stands for them. Identity is the root's; activity is
 * the tree's — see `RowActivity`.
 *
 * Distinct `updated_at` values throughout, because the default fixtures share
 * one instant and a row showing the wrong chat's date is invisible under it.
 */
describe("buildRows activity roll-up", () => {
  const ROOT_AT = "2026-07-28T10:00:00Z";
  const CHILD_AT = "2026-08-02T16:30:00Z";
  const child = (id: string, meta: Record<string, unknown> = {}, updatedAt = CHILD_AT) =>
    makeChat(id, { parentChatId: "root", rootChatId: "root", ...meta }, updatedAt);
  /** The one row a root+children fixture folds into. */
  const groupRow = (chats: Chat[]) => buildRows(chats)[0];

  it("reports the group's latest update while staying labelled with the root", () => {
    const row = groupRow([child("child-1"), makeChat("root", {}, ROOT_AT)]);
    expect(row.chat.id).toBe("root");
    expect(row.activity.updatedAt).toBe(CHILD_AT);
  });

  it("derives a lone row's activity exactly as the row derives it from the chat alone", () => {
    // The equivalence that lets one component serve both branches: for a
    // one-member row every rule below has to collapse to the reading
    // `ChatListItem` does from `chat` when no roll-up is passed at all.
    const summon = { message: "look at this", urgency: "normal", createdAt: "2026-08-02T16:00:00Z" };
    const meta = { lastReadAt: "2026-07-01T00:00:00Z", summon, chatStatus: "writing tests", chatStatusEmoji: "🧪", jobRunId: "run-1", jobStepId: "verify", jobRunNeedsYou: true };
    expect(groupRow([makeChat("solo", meta, CHILD_AT)]).activity).toEqual({
      updatedAt: CHILD_AT,
      hasUnread: true,
      summon,
      summonChatId: "solo",
      jobAwaitingApproval: true,
      jobRunId: "run-1",
      jobStepId: "verify",
      chatStatus: "writing tests",
      chatStatusEmoji: "🧪",
    });
  });

  it("leaves a bare lone row reporting nothing at all", () => {
    // The other half of that equivalence, and the one that says the roll-up
    // cannot INVENT a signal: no read mark is not unread, exactly as the row
    // has always read it.
    expect(groupRow([makeChat("solo", {}, ROOT_AT)]).activity).toEqual({
      updatedAt: ROOT_AT,
      hasUnread: false,
      summon: undefined,
      summonChatId: undefined,
      jobAwaitingApproval: false,
      jobRunId: undefined,
      jobStepId: undefined,
      chatStatus: undefined,
      chatStatusEmoji: undefined,
    });
  });

  it("marks the group unread when a child is past its OWN read mark and the root is not", () => {
    const row = groupRow([child("child-1", { lastReadAt: "2026-08-01T00:00:00Z" }), makeChat("root", { lastReadAt: "2026-07-29T00:00:00Z" }, ROOT_AT)]);
    expect(row.activity.hasUnread).toBe(true);
  });

  it("does not mark a member with no read mark of its own unread against a sibling's", () => {
    // The rule is per member, not "any update later than any read mark": this
    // child has never been opened, which is not the same as having unread
    // output, and the root's mark says nothing about it.
    const row = groupRow([child("child-1"), makeChat("root", { lastReadAt: "2026-07-29T00:00:00Z" }, ROOT_AT)]);
    expect(row.activity.hasUnread).toBe(false);
  });

  it("prefers an urgent summon over a more recently raised ordinary one", () => {
    const urgent = { message: "blocked", urgency: "urgent", createdAt: "2026-08-01T09:00:00Z" };
    const ordinary = { message: "fyi", urgency: "normal", createdAt: "2026-08-02T09:00:00Z" };
    const row = groupRow([child("child-2", { summon: ordinary }), child("child-1", { summon: urgent }, "2026-08-01T16:30:00Z"), makeChat("root", {}, ROOT_AT)]);
    expect(row.activity.summon).toEqual(urgent);
    expect(row.activity.summonChatId).toBe("child-1");
  });

  it("takes the most recent summon when none of them is urgent", () => {
    const older = { message: "older", urgency: "normal", createdAt: "2026-08-01T09:00:00Z" };
    const newer = { message: "newer", urgency: "normal", createdAt: "2026-08-02T09:00:00Z" };
    const row = groupRow([child("child-2", { summon: older }), child("child-1", { summon: newer }, "2026-08-01T16:30:00Z"), makeChat("root", {}, ROOT_AT)]);
    expect(row.activity.summon).toEqual(newer);
    expect(row.activity.summonChatId).toBe("child-1");
  });

  it("raises the approval flag for any member, and names that member's run and step", () => {
    const row = groupRow([child("child-1", { jobRunId: "run-7", jobStepId: "review", jobRunNeedsYou: true }), makeChat("root", {}, ROOT_AT)]);
    expect(row.activity).toMatchObject({ jobAwaitingApproval: true, jobRunId: "run-7", jobStepId: "review" });
  });

  it("rolls up a job step that is merely running, without raising the approval flag", () => {
    // The badge and the flag are separate questions. The run has to reach the
    // row or the group goes silent about a job a lone row would have badged;
    // the flag has to stay down or a running step gets the pulsing "needs you"
    // treatment and the `faded` exemption it has not earned.
    const row = groupRow([child("child-1", { jobRunId: "run-7", jobStepId: "review" }), makeChat("root", {}, ROOT_AT)]);
    expect(row.activity).toMatchObject({ jobAwaitingApproval: false, jobRunId: "run-7", jobStepId: "review" });
  });

  it("prefers the awaiting member's run over a merely running one, whichever comes first", () => {
    const running = { jobRunId: "run-running", jobStepId: "build" };
    const awaiting = { jobRunId: "run-waiting", jobStepId: "approve", jobRunNeedsYou: true };
    const expected = { jobAwaitingApproval: true, jobRunId: "run-waiting", jobStepId: "approve" };
    // Running member first: the awaiting one displaces it.
    expect(groupRow([child("child-2", running), child("child-1", awaiting, "2026-08-01T16:30:00Z"), makeChat("root", {}, ROOT_AT)]).activity).toMatchObject(expected);
    // Awaiting member first: a later running one does not take the pill back.
    expect(groupRow([child("child-2", awaiting), child("child-1", running, "2026-08-01T16:30:00Z"), makeChat("root", {}, ROOT_AT)]).activity).toMatchObject(expected);
  });

  it("gives the pill to the earlier member when two are merely running", () => {
    const row = groupRow([
      child("child-2", { jobRunId: "run-a", jobStepId: "first" }),
      child("child-1", { jobRunId: "run-b", jobStepId: "second" }, "2026-08-01T16:30:00Z"),
      makeChat("root", {}, ROOT_AT),
    ]);
    expect(row.activity).toMatchObject({ jobAwaitingApproval: false, jobRunId: "run-a", jobStepId: "first" });
  });

  it("names one of two members awaiting approval — the front chat's own step is replaceable", () => {
    // The third single-valued signal, alongside the summon and the status: one
    // pill, so the earlier member's run wins and the root's own waiting step
    // is the one displaced.
    const row = groupRow([
      child("child-1", { jobRunId: "run-child", jobStepId: "child-step", jobRunNeedsYou: true }),
      makeChat("root", { jobRunId: "run-root", jobStepId: "root-step", jobRunNeedsYou: true }, ROOT_AT),
    ]);
    expect(row.chat.id).toBe("root");
    expect(row.activity).toMatchObject({ jobAwaitingApproval: true, jobRunId: "run-child", jobStepId: "child-step" });
  });

  it("takes the chat status of the most recently updated member that has one", () => {
    // Array order and the clock disagree here on purpose: the root leads the
    // array, and the status still comes from the child that moved last.
    const row = groupRow([makeChat("root", { chatStatus: "idle", chatStatusEmoji: "💤" }, ROOT_AT), child("child-1", { chatStatus: "running tests", chatStatusEmoji: "🧪" })]);
    expect(row.activity).toMatchObject({ chatStatus: "running tests", chatStatusEmoji: "🧪" });
  });

  it("falls back to the only member that has a status when the busiest one has none", () => {
    const row = groupRow([child("child-1"), makeChat("root", { chatStatus: "waiting on review" }, ROOT_AT)]);
    expect(row.activity.chatStatus).toBe("waiting on review");
  });

  it("still reports a status whose member has an unparseable updated_at", () => {
    // A timestamp gate alone drops this: `memberAt` is NaN and every
    // comparison against NaN is false, so the status is never taken — the one
    // way the roll-up could SILENCE a signal a lone row shows, and reachable
    // on a one-member row, where the roll-up must equal `ChatListItem`'s own
    // reading exactly. `updated_at` is a required ISO string, but
    // `chat-file-service` already guards it with `Date.parse(...) || 0`.
    const lone = groupRow([makeChat("solo", { rootChatId: "solo", chatStatus: "stuck", chatStatusEmoji: "🧱" }, "not a date")]);
    expect(lone.activity).toMatchObject({ chatStatus: "stuck", chatStatusEmoji: "🧱" });
    // And in a group: an unparseable timestamp is incomparable rather than
    // old, so it neither wins nor loses on the clock and falls through to the
    // same earlier-member-wins tie-break every other field uses.
    const group = groupRow([child("child-1", { chatStatus: "broken clock" }, "not a date"), makeChat("root", { chatStatus: "running tests" }, ROOT_AT)]);
    expect(group.activity.chatStatus).toBe("broken clock");
  });

  it("files every loaded member on the row, in the order the list had them", () => {
    const rows = buildRows([child("child-2"), child("child-1", {}, "2026-08-01T16:30:00Z"), makeChat("root", {}, ROOT_AT), makeChat("solo", {}, ROOT_AT)]);
    expect(rows[0].members.map((c) => c.id)).toEqual(["child-2", "child-1", "root"]);
    // `size` is that list's length now, not a counter kept beside it.
    expect(rows[0].size).toBe(rows[0].members.length);
    expect(rows[1].members.map((c) => c.id)).toEqual(["solo"]);
  });
});

/**
 * The same roll-up, through the rendered row — the signals a user can actually
 * see, on the collapsed group row that is all the sidebar shows of a tree.
 */
describe("ChatTreeList group activity rendering", () => {
  const ROOT_AT = "2026-07-28T10:00:00Z";
  const CHILD_AT = "2026-08-02T16:30:00Z";

  /** The row's timestamp, formatted the way the row formats it. */
  const stamp = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function renderList(chats: Chat[], props: Partial<React.ComponentProps<typeof ChatTreeList>> = {}) {
    return render(
      <MemoryRouter>
        <ChatTreeList
          chats={chats}
          refreshToken={0}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          onTogglePin={() => {}}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
          {...props}
        />
      </MemoryRouter>,
    );
  }

  const SUMMON = { message: "needs a decision", urgency: "urgent", createdAt: "2026-08-02T16:00:00Z" };
  // A root that has done nothing since July and a subagent that has: the summon,
  // the unread output, the waiting approval and the fresh timestamp are all the
  // child's, and the row is labelled "chat root".
  const BUSY_CHILD = [
    makeChat(
      "child-1",
      { parentChatId: "root", rootChatId: "root", summon: SUMMON, lastReadAt: "2026-08-01T00:00:00Z", jobRunId: "run-7", jobStepId: "review", jobRunNeedsYou: true },
      CHILD_AT,
    ),
    makeChat("root", { lastReadAt: "2026-07-29T00:00:00Z" }, ROOT_AT),
  ];

  it("shows the child's summon, unread dot, approval pill and timestamp on the root-fronted row", () => {
    const { container } = renderList(BUSY_CHILD);
    expect(screen.getByText("chat root")).toBeTruthy();
    expect(screen.getByTitle(`Summon: ${SUMMON.message}`)).toBeTruthy();
    expect(screen.getByTitle("Unread messages")).toBeTruthy();
    expect(screen.getByText("needs you")).toBeTruthy();
    expect(screen.getByTitle(/Waiting for your approval — job step: review \(run run-7\)/)).toBeTruthy();
    expect(container.textContent).toContain(stamp(CHILD_AT));
    expect(container.textContent).not.toContain(stamp(ROOT_AT));
  });

  it("shows a child's RUNNING job step on the row, as the ordinary pill rather than 'needs you'", () => {
    // Nothing is waiting on the user here — just a step in flight in a child.
    // Rolling up only the approval case leaves this row with no pill at all,
    // where before roots fronted anything the same child fronted the row and
    // put its step on screen.
    const running = [makeChat("child-1", { parentChatId: "root", rootChatId: "root", jobRunId: "run-7", jobStepId: "review" }, CHILD_AT), makeChat("root", {}, ROOT_AT)];
    renderList(running);
    expect(screen.getByText("chat root")).toBeTruthy();
    expect(screen.getByText("review")).toBeTruthy();
    expect(screen.getByTitle("Job step: review (run run-7)")).toBeTruthy();
    expect(screen.queryByText("needs you")).toBeNull();
    // The control: the identical chat as a lone row has always shown it.
    cleanup();
    renderList([makeChat("solo", { jobRunId: "run-7", jobStepId: "review" }, CHILD_AT)]);
    expect(screen.getByTitle("Job step: review (run run-7)")).toBeTruthy();
  });

  it("reports none of it when the child is idle", () => {
    // The control for every assertion above: same shape of fixture, nothing
    // live in it, so the badges are the signals and not the markup.
    const { container } = renderList([makeChat("child-1", { parentChatId: "root", rootChatId: "root" }, CHILD_AT), makeChat("root", {}, ROOT_AT)]);
    expect(screen.queryByTitle(/^Summon: /)).toBeNull();
    expect(screen.queryByTitle("Unread messages")).toBeNull();
    expect(screen.queryByText("needs you")).toBeNull();
    // Neither pill: the roll-up cannot INVENT a run any more than it can a
    // read mark.
    expect(screen.queryByTitle(/^Job step/)).toBeNull();
    expect(container.querySelector("svg.lucide-globe")).toBeNull();
  });

  it("dismisses the summon on the member that raised it, not on the chat the row names", () => {
    renderList(BUSY_CHILD);
    fireEvent.click(screen.getByTitle(`Summon: ${SUMMON.message}`));
    expect(vi.mocked(dismissSummon)).toHaveBeenCalledWith("child-1");
  });

  it("badges the row as running when any member has a live session", () => {
    // The root has no session — it is the parent that spawned the work and
    // stopped. Reading only the front chat leaves a tree with an agent working
    // in it looking idle.
    const { container } = renderList(BUSY_CHILD, { sessionStatusFor: (id: string) => (id === "child-1" ? { active: true, type: "web" } : undefined) });
    expect(container.querySelector("svg.lucide-globe")).toBeTruthy();
  });

  it("keeps a lone row reading its own signals when a livelier chat sits beside it", () => {
    // The lone branch passes no roll-up at all, and nothing about it changed:
    // the neighbouring group's summon does not leak onto it.
    renderList([...BUSY_CHILD, makeChat("solo", {}, ROOT_AT)]);
    const solo = screen.getByText("chat solo").closest('div[style*="border-bottom"]')!;
    expect(solo.querySelector('[title^="Summon: "]')).toBeNull();
    expect(solo.textContent).toContain(stamp(ROOT_AT));
  });

  it("highlights the group row while a CHILD is the open chat", () => {
    // The row is labelled with the root, so keying the highlight off the front
    // chat alone leaves the sidebar with nothing marked at all for every chat
    // one level down — the state you are in whenever you open a thread from a
    // tree row.
    const { container } = renderList(BUSY_CHILD, { activeChatId: "child-1" });
    const row = screen.getByText("chat root").closest('div[style*="border-bottom"]')! as HTMLElement;
    expect(row.getAttribute("style")).toContain("chatlist-item-active-bg");
    // The control: a chat outside this group does not light the row up.
    cleanup();
    const other = renderList(BUSY_CHILD, { activeChatId: "elsewhere" }).container;
    expect(other.querySelector('[style*="chatlist-item-active-bg"]')).toBeNull();
    expect(container).toBeTruthy();
  });

  it("does not fade an archived-card group row whose child is open, or one holding a live summon", () => {
    // Both `faded` exemptions the roll-up feeds: `isActive` (Fix 2's knock-on)
    // and `summon`. An archived card's tree is exactly where a subagent's
    // summon would otherwise be faded out of sight.
    const faded = (container: HTMLElement) => container.querySelectorAll(".chatlist-item-dimmed").length;
    expect(faded(renderList(BUSY_CHILD, { isDimmed: () => true, activeChatId: "child-1" }).container)).toBe(0);
    cleanup();
    expect(faded(renderList(BUSY_CHILD, { isDimmed: () => true }).container)).toBe(0);
    cleanup();
    // The control: the same archived row with nothing live in the tree fades.
    const quiet = [makeChat("child-1", { parentChatId: "root", rootChatId: "root" }, CHILD_AT), makeChat("root", {}, ROOT_AT)];
    expect(faded(renderList(quiet, { isDimmed: () => true }).container)).toBe(1);
  });
});

it("labels a native child unknown and read-only rather than completed", async () => {
  mockGetChatTree.mockResolvedValue(
    makeTree(
      makeNode("root", "Root", {
        children: [
          makeNode("child-1", "Pasteur", {
            provider: "codex",
            nativeAgent: { parentThreadId: "root", management: "read-only", lifecycle: "unknown", controlNote: "Ask parent to manage this child" },
          }),
        ],
      }),
    ),
  );
  renderTree({ refreshToken: 0 });
  await expandGroup();
  expect(await screen.findByText(/unknown · read-only/)).toBeTruthy();
  expect(screen.getByTitle("Ask parent to manage this child")).toBeTruthy();
});

/**
 * Pinning through a row, which is the ONLY way anything gets pinned: the pin
 * has one call site, the sidebar kebab, and `TreeNodeRow` (the expanded
 * members of a group) has no kebab at all.
 *
 * The bug this suite exists for: `renderRow` has two branches, and only the
 * lone-chat one passed `onTogglePin`. Since `isGroup` is true for anything
 * with lineage — every forked, spawned or job-step chat, and anything with
 * children — a chat pinned while standalone became UNPINNABLE the moment
 * someone spawned a subagent off it, with no way back short of editing the
 * chat's JSON by hand. Nothing caught it because the group branch's props were
 * only ever type-checked, never exercised.
 */
describe("pinning a row", () => {
  const spy = () => vi.fn();

  function renderWithPin(chats: Chat[], onTogglePin: (chats: Chat[], pinned: boolean) => void) {
    return render(
      <MemoryRouter>
        <ChatTreeList
          chats={chats}
          refreshToken={0}
          onChatClick={() => {}}
          onDelete={() => {}}
          onToggleBookmark={() => {}}
          onTogglePin={onTogglePin}
          cardMenuFor={() => ({})}
          sessionStatusFor={() => undefined}
        />
      </MemoryRouter>,
    );
  }

  /** Open the kebab on the row displaying `text`. It only exists while hovered. */
  function openRowMenu(text: string) {
    const row = screen.getByText(text).closest('div[style*="border-bottom"]')!;
    fireEvent.mouseEnter(row);
    fireEvent.click(row.querySelector('[title="Chat actions"]')!);
  }

  const headers = () =>
    screen
      .queryAllByRole("button")
      .map((el) => el.textContent ?? "")
      .filter((text) => /^(Pinned|Recent) \(\d+\)$/.test(text));

  it("offers Pin on a GROUP row, not just a lone one", () => {
    // The regression case. GROUP_CHATS is parent + child, so this row goes
    // through the branch that used to drop the handler on the floor.
    const onTogglePin = spy();
    renderWithPin(GROUP_CHATS, onTogglePin);

    openRowMenu("chat root");
    fireEvent.click(screen.getByText("Pin"));

    // Pinning a group pins the chat it is labelled with.
    expect(onTogglePin).toHaveBeenCalledWith([expect.objectContaining({ id: "root" })], true);
  });

  it("offers Pin on a lone row", () => {
    // The control: both branches share one `pinProps`, and this is what says
    // the shared expression did not regress the branch that always worked.
    const onTogglePin = spy();
    renderWithPin([makeChat("solo")], onTogglePin);

    openRowMenu("chat solo");
    fireEvent.click(screen.getByText("Pin"));

    expect(onTogglePin).toHaveBeenCalledWith([expect.objectContaining({ id: "solo" })], true);
  });

  it("files a group into Pinned when a NON-header member carries the pin, whatever the recency order", () => {
    // The stated decision: a group is pinned if ANY member is. Fronting the
    // row with the root rather than the busiest member does not soften the
    // need for it. With the root loaded — as it is here, and as it usually is
    // — a pin set on a child is never the header row's own in ANY order, so a
    // header-only rule would leave this pin permanently inert with nothing on
    // screen showing it. (The old rule broke on a different set, not a subset:
    // it dropped a pin whenever the pinned member was not the most recently
    // updated one. See `Row.pinnedMembers`.)
    //
    // `child-1` leads the array (it is the most recent), so this is also the
    // case where the header row changed: the row is "chat root" now and was
    // "chat child-1" before.
    const onTogglePin = spy();
    renderWithPin([makeChat("child-1", { parentChatId: "root", rootChatId: "root", pinned: true }), makeChat("root")], onTogglePin);

    expect(headers()).toEqual(["Pinned (2)"]);
    expect(screen.getByText("chat root")).toBeTruthy();

    // And the kebab on that root-fronted row still reaches the child's pin.
    openRowMenu("chat root");
    expect(screen.queryByText("Pin")).toBeNull();
    fireEvent.click(screen.getByText("Unpin"));
    expect(onTogglePin).toHaveBeenCalledWith([expect.objectContaining({ id: "child-1" })], false);
  });

  it("files a group into Pinned when a NON-header member carries the pin", () => {
    // The stated decision: a group is pinned if ANY member is. The header row
    // is the group's root, so a pin on any other member is never its own — a
    // header-only rule would let a pin stop working the moment its chat got a
    // parent, with nothing on screen showing it and no way to clear it.
    const onTogglePin = spy();
    renderWithPin([makeChat("root"), makeChat("child-1", { parentChatId: "root", rootChatId: "root", pinned: true })], onTogglePin);

    expect(headers()).toEqual(["Pinned (2)"]);
    // Counted whole — both chats, not just the pinned one — because the
    // section holds the whole group as one row.
    expect(screen.getByText("chat root")).toBeTruthy();
  });

  it("lets that group's kebab clear the pin it is displaying", () => {
    // The other half of the same decision. The row shows a pin it does not own,
    // so "Unpin" has to reach the member that does — otherwise the menu offers
    // an action that visibly does nothing.
    const onTogglePin = spy();
    renderWithPin([makeChat("root"), makeChat("child-1", { parentChatId: "root", rootChatId: "root", pinned: true })], onTogglePin);

    openRowMenu("chat root");
    // Not "Pin": the row is displaying the group's verdict, and the entry must
    // agree with it.
    expect(screen.queryByText("Pin")).toBeNull();
    fireEvent.click(screen.getByText("Unpin"));

    expect(onTogglePin).toHaveBeenCalledWith([expect.objectContaining({ id: "child-1" })], false);
  });

  it("clears every pinned member at once, not just the first", () => {
    const onTogglePin = spy();
    renderWithPin(
      [
        makeChat("root", { pinned: true }),
        makeChat("child-1", { parentChatId: "root", rootChatId: "root", pinned: true }),
        makeChat("child-2", { parentChatId: "root", rootChatId: "root" }),
      ],
      onTogglePin,
    );

    openRowMenu("chat root");
    fireEvent.click(screen.getByText("Unpin"));

    const [targets, pinned] = onTogglePin.mock.calls[0];
    expect(targets.map((c: Chat) => c.id)).toEqual(["root", "child-1"]);
    expect(pinned).toBe(false);
  });

  it("renders no headers when a group holds no pin at all", () => {
    renderWithPin(GROUP_CHATS, spy());
    expect(headers()).toEqual([]);
  });
});
