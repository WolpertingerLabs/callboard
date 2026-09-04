/**
 * The drawer's one new prop.
 *
 * `initialFolderFilter` is how a list row's folder entry drills in, and the
 * two things that matter about it are that the filter is escapable — a filter
 * a user can neither see nor clear reads as a card that has lost its chats —
 * and that its absence leaves the drawer byte-for-byte the drawer it was.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardMemberChat, CardSummary } from "../../api";
import CardDrawer from "./CardDrawer";

const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

function member(overrides: Partial<CardMemberChat> & Pick<CardMemberChat, "chatId" | "folder">): CardMemberChat {
  return {
    title: `Chat ${overrides.chatId}`,
    status: "stopped",
    hasSummon: false,
    unread: false,
    isTriggered: false,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

const MEMBERS = [
  member({ chatId: "a", folder: "/home/cybil/callboard" }),
  member({ chatId: "b", folder: "/home/cybil/callboard.feat-x" }),
  member({ chatId: "c", folder: "/home/cybil/callboard.feat-x" }),
];

function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    id: "card-1",
    title: "Ship the thing",
    description: "",
    emoji: "🚀",
    lifecycle: "open",
    pinned: false,
    rollup: "idle",
    lastActivityAt: "2026-08-07T11:00:00.000Z",
    chatCount: 3,
    unread: false,
    memberChats: MEMBERS,
    memberRuns: [],
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z",
    ...overrides,
  };
}

function mount(props: Partial<React.ComponentProps<typeof CardDrawer>> = {}) {
  return render(
    <MemoryRouter>
      <CardDrawer card={card()} categories={[]} onPatch={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

/** The chat rows, by title — the list the filter acts on. */
function chatTitles() {
  return MEMBERS.map((m) => m.title!).filter((title) => screen.queryByText(title) !== null);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("without the prop", () => {
  it("is the drawer it has always been", () => {
    mount();
    expect(chatTitles()).toEqual(["Chat a", "Chat b", "Chat c"]);
    // No count arithmetic and no chip when nothing is filtered.
    expect(screen.getByText("Chats (3)")).toBeDefined();
    expect(screen.queryByLabelText("Clear folder filter")).toBeNull();
  });
});

describe("with a folder filter", () => {
  it("opens showing only that folder's chats", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    expect(chatTitles()).toEqual(["Chat b", "Chat c"]);
  });

  it("says what it is hiding rather than reporting a smaller card", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    // "2" alone reads as the card having lost a chat.
    expect(screen.getByText("Chats (2 of 3)")).toBeDefined();
  });

  it("shows the folder it is filtered to, full path on hover", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    expect(screen.getByTitle("/home/cybil/callboard.feat-x")).toBeDefined();
  });

  it("clears back to every chat on the card", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    fireEvent.click(screen.getByLabelText("Clear folder filter"));

    expect(chatTitles()).toEqual(["Chat a", "Chat b", "Chat c"]);
    expect(screen.getByText("Chats (3)")).toBeDefined();
    expect(screen.queryByLabelText("Clear folder filter")).toBeNull();
  });

  it("still opens the chat that was clicked", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    fireEvent.click(screen.getByText("Chat c"));
    expect(navigate).toHaveBeenCalledWith("/chat/c");
  });

  it("explains an empty folder instead of showing a filter over blank space", () => {
    // A folder can empty out under the board's 15s poll while the drawer is
    // open, and the way out has to stay on screen.
    mount({ initialFolderFilter: "/home/cybil/gone" });
    expect(chatTitles()).toEqual([]);
    expect(screen.getByText(/No chats in this folder/)).toBeDefined();
    expect(screen.getByLabelText("Clear folder filter")).toBeDefined();
  });

  it("starts a new chat in the folder the drawer is showing", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    fireEvent.click(screen.getByText("New chat on card"));

    // The chip above the list says feat-x. Reading the card's unfiltered
    // member list here would put the chat in the card's most recent folder
    // while the only context on screen claimed otherwise.
    expect(navigate).toHaveBeenCalledWith(`/chat/new?folder=${encodeURIComponent("/home/cybil/callboard.feat-x")}`, expect.anything());
  });

  it("goes back to the card's most recent folder once the filter is cleared", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    fireEvent.click(screen.getByLabelText("Clear folder filter"));
    fireEvent.click(screen.getByText("New chat on card"));

    expect(navigate).toHaveBeenCalledWith(`/chat/new?folder=${encodeURIComponent("/home/cybil/callboard")}`, expect.anything());
  });

  it("falls back rather than guessing when the filtered folder has emptied out", () => {
    // The 15s poll can empty a folder under an open drawer, and there is no
    // member chat left to read a folder off.
    mount({ initialFolderFilter: "/home/cybil/gone" });
    fireEvent.click(screen.getByText("New chat on card"));
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining("folder=%2Fhome%2Fcybil%2Fcallboard"), expect.anything());
  });

  it("leaves everything else about the drawer alone", () => {
    mount({ initialFolderFilter: "/home/cybil/callboard.feat-x" });
    // The card's identity and actions are not the chat list's business.
    expect(screen.getByText("Description")).toBeDefined();
    expect(screen.getByText("New chat on card")).toBeDefined();
    expect(screen.getByText("Close card")).toBeDefined();
  });
});
