/**
 * The row's layout contract — the half `cardFace.parity.test.tsx` deliberately
 * leaves alone, because it is the half the two faces are *supposed* to differ
 * on.
 *
 * jsdom lays nothing out, so these assert the rules that produce the layout
 * rather than the pixels: the shared column template (the reason a list beats
 * a squashed tile), the folders column being dropped rather than blanked, and
 * the mobile fallback's touch target.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CardMemberChat, CardMemberRun, CardSummary } from "../../api";
import CardRow from "./CardRow";

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
    chatCount: 2,
    unread: false,
    memberChats: [],
    memberRuns: [],
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z",
    ...overrides,
  };
}

const FOLDER: CardMemberChat = {
  chatId: "card-1",
  folder: "/home/cybil/callboard",
  title: null,
  status: "stopped",
  hasSummon: false,
  unread: false,
  isTriggered: false,
  createdAt: "2026-08-07T10:00:00.000Z",
  updatedAt: "2026-08-07T10:00:00.000Z",
};

function member(overrides: Partial<CardMemberChat> & Pick<CardMemberChat, "chatId" | "folder">): CardMemberChat {
  return { ...FOLDER, ...overrides };
}

/** `count` distinct folders under one prefix, the root first — the shape of the real fan-out cards. */
function fanout(count: number): CardMemberChat[] {
  return Array.from({ length: count }, (_, i) =>
    member({ chatId: i === 0 ? "card-1" : `chat-${i}`, folder: i === 0 ? "/home/cybil/callboard" : `/home/cybil/callboard.feat-${i}` }),
  );
}

const RUN: CardMemberRun = {
  runId: "run-1",
  jobId: "job-1",
  jobName: "nightly-rebase",
  status: "running",
  createdAt: "2026-08-07T10:00:00.000Z",
  updatedAt: "2026-08-07T10:30:00.000Z",
};

function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
}

/**
 * The row's own button. Filtered past the expansion: a folder entry names the
 * card it belongs to, so several buttons match the title once a row is open.
 */
function surface() {
  return screen.getAllByRole("button", { name: /Ship the thing/ }).find((el) => el.closest('[role="group"]') === null)!;
}

/**
 * The desktop template's tracks, one per cell.
 *
 * Whitespace-normalised on the way out, deliberately: `minmax(0, 2fr)` and
 * `minmax(0,2fr)` are the same template, and an assertion that tells them
 * apart is testing how the string was typed rather than what the row lays out.
 * What is worth pinning is the contract — a track per cell, in a known order.
 */
function tracks() {
  return surface()
    .style.gridTemplateColumns.replace(/,\s+/g, ",")
    .split(/\s+/)
    .filter(Boolean);
}

/** The `minmax(...)` tracks — the ones that share out the leftover width. */
const flexible = (cols: string[]) => cols.filter((t) => t.startsWith("minmax("));

afterEach(cleanup);

describe("the desktop template", () => {
  it("drops the folders column outright when paths are off", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} onOpenFolder={vi.fn()} />);
    const cols = tracks();

    // Six columns, not seven with an empty one: with paths off the title and
    // status get that width back instead of a blank stripe down the list.
    expect(cols).toHaveLength(6);
    // One track per cell is the invariant the whole list view rests on — a
    // template and a cell count that disagree misalign every row below.
    expect(surface().children).toHaveLength(cols.length);
    expect(cols[0]).toBe("18px"); // the fixed emoji box the checkbox swaps into
    expect(flexible(cols)).toHaveLength(2); // title and status share the slack
    expect(cols.slice(-3)).toEqual(["auto", "auto", "auto"]); // rollup, count, time
  });

  it("adds the folders column, in the middle, when paths are on", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath onOpenFolder={vi.fn()} />);
    const cols = tracks();

    expect(cols).toHaveLength(7);
    expect(surface().children).toHaveLength(cols.length);
    // Fourth, between status and the three trailing cells — in the middle is
    // the point, since a path column at the end would sit past the time.
    expect(flexible(cols)).toHaveLength(3);
    expect(cols[3].startsWith("minmax(")).toBe(true);
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
  });

  it("keeps the folders column when a card has no folders to put in it", () => {
    setWidth(1024);
    // A root on a retired provider: a real card with no member rows, and 8.8%
    // of the board rather than an edge case. The column stays, or every path
    // below it would step sideways.
    render(<CardRow card={card()} onClick={vi.fn()} showPath onOpenFolder={vi.fn()} />);

    expect(surface().children).toHaveLength(7);
    expect(document.querySelector("[title^='/']")).toBeNull();
    // Held open by an empty placeholder, not by the folder cell: there is no
    // path to align, so the 12px chevron slot has nothing to align it to.
    expect(surface().children[3].children).toHaveLength(0);
  });
});

describe("a card with no folders at all", () => {
  // 72 of 818 cards, 8.8%: a lineage entirely on the retired provider, so
  // `memberChats` comes back empty. Both layouts draw the same nothing; only
  // what they do with the space differs, and that difference is the grid.
  it("draws no folder line on either layout", () => {
    setWidth(1024);
    const desktop = render(<CardRow card={card()} onClick={vi.fn()} showPath onOpenFolder={vi.fn()} />);
    expect(desktop.container.querySelector("[title^='/']")).toBeNull();
    // No chevron slot either — nothing to hold a column open for.
    expect([...desktop.container.querySelectorAll<HTMLElement>("span")].filter((el) => el.style.width === "12px")).toHaveLength(0);
    cleanup();

    setWidth(500);
    const mobile = render(<CardRow card={card()} onClick={vi.fn()} showPath onOpenFolder={vi.fn()} />);
    expect(mobile.container.querySelector("[title^='/']")).toBeNull();
  });
});

describe("the status cell carries the running job", () => {
  it("appends it after the status without spending an eighth column", () => {
    setWidth(1024);
    render(<CardRow card={card({ status: "rebasing onto main", memberRuns: [RUN] })} onClick={vi.fn()} onOpenFolder={vi.fn()} />);

    // Still the six-column template: the job shares the status cell rather
    // than narrowing every other column on the board for one optional string.
    expect(tracks()).toHaveLength(6);
    // The title is the escape hatch for whatever the cell's ellipsis eats.
    const cell = screen.getByTitle("rebasing onto main · nightly-rebase");
    expect(cell.textContent).toBe("rebasing onto main · nightly-rebase");
  });

  it("lets the job stand alone when the card has no status text", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberRuns: [RUN] })} onClick={vi.fn()} onOpenFolder={vi.fn()} />);

    // No leading separator dangling off nothing.
    expect(screen.getByTitle("nightly-rebase").textContent).toBe("nightly-rebase");
  });

  it("keeps it on the mobile second line, which is where the status lives there", () => {
    setWidth(500);
    render(<CardRow card={card({ memberRuns: [RUN] })} onClick={vi.fn()} onOpenFolder={vi.fn()} />);
    // The second line is mounted on the strength of the job alone — gating it
    // on card.status would drop the job on a card that has never set one.
    expect(screen.getByText("nightly-rebase")).toBeDefined();
  });
});

describe("the expansion chevron", () => {
  // Not /folders$/: the +N badge beside it is titled "N other folders".
  const chevron = () => screen.queryByTitle(/^(Show all|Hide) /);

  it("stays away from the 97.1% of cards with at most one path", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
    // An affordance that does nothing on 794 of 818 rows is noise on all of them.
    expect(chevron()).toBeNull();
  });

  it("appears once there is a second folder to open onto", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
    expect(screen.getByTitle("Show all 3 folders")).toBeDefined();
  });

  it("toggles the row without opening the drawer under it", () => {
    setWidth(1024);
    const onClick = vi.fn();
    const onToggleExpand = vi.fn();
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={onClick} showPath onToggleExpand={onToggleExpand} onOpenFolder={vi.fn()} />);

    fireEvent.click(screen.getByTitle("Show all 3 folders"));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
    // It sits inside the row's main button, so a click that did not stop
    // there would open the drawer on its way past.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is a span, not a button, because it lives inside one", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
    // A nested <button> is invalid markup the parser splits apart, and no
    // screen reader or keyboard can drive the result.
    expect(screen.getByTitle("Show all 3 folders").tagName).toBe("SPAN");
    expect(surface().querySelectorAll("button")).toHaveLength(0);
  });

  it("holds its 12px slot open on every row so the paths share a left edge", () => {
    setWidth(1024);
    const { container } = render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath onOpenFolder={vi.fn()} />);
    const slot = [...container.querySelectorAll<HTMLElement>("span")].find((el) => el.style.width === "12px");
    expect(slot).toBeDefined();
  });
});

describe("the folder expansion", () => {
  /** The entries, in DOM order, as "<path text>" — the buttons below the row. */
  function entries() {
    return screen
      .getAllByRole("button")
      .filter((el) => el !== surface())
      .map((el) => el.textContent);
  }

  it("hangs below the row's button rather than inside it", () => {
    setWidth(1024);
    const { container } = render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);

    const outer = container.firstElementChild as HTMLElement;
    // A folder entry is a button, so it cannot nest in the row's button. The
    // outer element became a column exactly so it could hold both.
    expect(outer.style.flexDirection).toBe("column");
    expect(outer.children).toHaveLength(2);
    expect(surface().querySelectorAll("button")).toHaveLength(0);
  });

  it("renders one entry per distinct folder, not per chat", () => {
    setWidth(1024);
    render(
      <CardRow
        // Four chats, two folders — the 20-folder card has 38 chats, and 38
        // inline rows on the board is a second drawer.
        card={card({
          memberChats: [
            member({ chatId: "card-1", folder: "/home/cybil/callboard" }),
            member({ chatId: "b", folder: "/home/cybil/callboard" }),
            member({ chatId: "c", folder: "/home/cybil/callboard.feat-a" }),
            member({ chatId: "d", folder: "/home/cybil/callboard.feat-a" }),
          ],
        })}
        onClick={vi.fn()}
        showPath
        expanded
        onToggleExpand={vi.fn()}
        onOpenFolder={vi.fn()}
      />,
    );
    expect(entries()).toHaveLength(2);
  });

  it("caps at eight entries and sends the rest to the drawer", () => {
    setWidth(1024);
    const onClick = vi.fn();
    render(<CardRow card={card({ memberChats: fanout(20) })} onClick={onClick} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);

    const rendered = entries();
    expect(rendered).toHaveLength(9); // 8 folders + the footer
    expect(rendered[8]).toBe("… 12 more");

    // Unfiltered: the footer's job is "go where all of these live".
    fireEvent.click(screen.getByText("… 12 more"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("says nothing about more when everything fits", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: fanout(8) })} onClick={vi.fn()} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("hoists the shared prefix once and leaves each entry its remainder", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);

    // Once in the header, not once per row — twelve copies of /home/cybil is
    // twelve copies of the substring that distinguishes nothing.
    expect(screen.getAllByText("/home/cybil")).toHaveLength(1);
    // And each entry shows only what is left of its own path.
    expect(screen.getByTitle("/home/cybil/callboard.feat-2").textContent).toBe("callboard.feat-2");
    expect(entries().every((text) => !text?.includes("/home/cybil"))).toBe(true);
  });

  it("labels the root folder, which is pinned first even when it is the quietest", () => {
    setWidth(1024);
    render(
      <CardRow
        card={card({
          memberChats: [
            member({ chatId: "card-1", folder: "/home/cybil/callboard", updatedAt: "2026-08-01T10:00:00.000Z" }),
            member({ chatId: "b", folder: "/home/cybil/callboard.feat-a", status: "waiting" }),
          ],
        })}
        onClick={vi.fn()}
        showPath
        expanded
        onToggleExpand={vi.fn()}
        onOpenFolder={vi.fn()}
      />,
    );
    expect(entries()[0]).toContain("root");
    expect(screen.getAllByText("root")).toHaveLength(1);
  });

  it("distinguishes a folder someone is blocked in from one that is merely busy", () => {
    setWidth(1024);
    const { container } = render(
      <CardRow
        card={card({
          memberChats: [
            member({ chatId: "card-1", folder: "/home/cybil/callboard", status: "waiting" }),
            member({ chatId: "b", folder: "/home/cybil/callboard.feat-a", status: "ongoing" }),
            member({ chatId: "c", folder: "/home/cybil/callboard.feat-b" }),
          ],
        })}
        onClick={vi.fn()}
        showPath
        expanded
        onToggleExpand={vi.fn()}
        onOpenFolder={vi.fn()}
      />,
    );

    // Scoped to the expansion — the row's own button leads with the emoji.
    const expansion = container.firstElementChild!.children[1];
    const dots = [...expansion.querySelectorAll<HTMLElement>("button > span:first-child")].map((el) => el.style.background);
    // "Blocked on you over there" is a different fact from "running over
    // there", and cardFolders already tells them apart.
    expect(dots).toEqual(["var(--board-rollup-needs-you)", "var(--board-rollup-active)", "transparent"]);
  });

  it("says nothing is live in a closed card's folders, whatever its member rows claim", () => {
    setWidth(1024);
    const { container } = render(
      <CardRow
        card={card({
          lifecycle: "closed",
          memberChats: [
            member({ chatId: "card-1", folder: "/home/cybil/callboard" }),
            member({ chatId: "b", folder: "/home/cybil/callboard.feat-a", status: "waiting" }),
          ],
        })}
        onClick={vi.fn()}
        showPath
        expanded
        onToggleExpand={vi.fn()}
        onOpenFolder={vi.fn()}
      />,
    );

    // A member session is still marked `waiting` — closing a card does not
    // recompute its rows. The row above already says "Closed", and the +N
    // beside it is grey; an amber dot one line below announcing "needs you"
    // contradicts both faces of the same card.
    const expansion = container.firstElementChild!.children[1];
    const dots = [...expansion.querySelectorAll<HTMLElement>("button > span:first-child")].map((el) => el.style.background);
    expect(dots).toEqual(["transparent", "transparent"]);
    // And in the name, not only the colour: the dot is the sighted half.
    expect(screen.queryByRole("button", { name: /needs you/ })).toBeNull();
  });

  it("opens the drawer filtered to the folder that was clicked", () => {
    setWidth(1024);
    const onOpenFolder = vi.fn();
    const onClick = vi.fn();
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={onClick} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={onOpenFolder} />);

    fireEvent.click(screen.getByTitle("/home/cybil/callboard.feat-2"));
    expect(onOpenFolder).toHaveBeenCalledWith("/home/cybil/callboard.feat-2");
    // The unfiltered open is a different gesture, and this is not it.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not let a held finger both select the card and work its own controls", () => {
    setWidth(1024);
    const onLongPress = vi.fn();
    render(
      <CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} onLongPress={onLongPress} />,
    );

    const hold = (el: HTMLElement) => {
      fireEvent.pointerDown(el, { pointerType: "touch", clientX: 10, clientY: 20 });
      act(() => void vi.advanceTimersByTime(600));
      fireEvent.pointerUp(el);
    };

    vi.useFakeTimers();
    try {
      // The long press lives on the outer element, which both the chevron and
      // the expansion sit inside. Left to bubble, one touch would enter
      // selection mode on the way down and toggle the row — or open a filtered
      // drawer — on the way back up.
      hold(screen.getByTitle("/home/cybil/callboard.feat-1"));
      hold(screen.getByTitle("Hide folders"));
      expect(onLongPress).not.toHaveBeenCalled();

      // The control, so this is not passing because nothing fires anywhere:
      // the same gesture on the row itself still enters selection.
      hold(surface());
      expect(onLongPress).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards the OTHER long-press trigger too, which is the one Android fires", () => {
    setWidth(1024);
    const onLongPress = vi.fn();
    render(
      <CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} onLongPress={onLongPress} />,
    );

    // `useLongPress` fires on a held pointer AND on contextmenu, and the two
    // bubble independently — stopping the pointer event does nothing to the
    // contextmenu that a long press on Android Chrome arrives as.
    fireEvent.contextMenu(screen.getByTitle("/home/cybil/callboard.feat-1"));
    fireEvent.contextMenu(screen.getByTitle("Hide folders"));
    expect(onLongPress).not.toHaveBeenCalled();

    // Same control as above: the gesture is not dead everywhere.
    fireEvent.contextMenu(surface());
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("leaves the row's own activation working after a contextmenu on a folder entry", () => {
    setWidth(1024);
    const onClick = vi.fn();
    render(
      <CardRow card={card({ memberChats: fanout(3) })} onClick={onClick} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} onLongPress={vi.fn()} />,
    );

    // The follow-on from the same root cause: a contextmenu that reached the
    // row set the hook's click-suppression flag, and the guard on the entry's
    // pointerdown meant no later pointerdown ever cleared it — so the row's
    // next activation (a keyboard Enter, which has no pointer event at all)
    // was swallowed with nothing to show for it.
    fireEvent.contextMenu(screen.getByTitle("/home/cybil/callboard.feat-1"));
    fireEvent.click(surface());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("goes dead with the rest of the row when the card is out of selection scope", () => {
    setWidth(1024);
    const onOpenFolder = vi.fn();
    const onClick = vi.fn();
    render(
      <CardRow
        card={card({ lifecycle: "closed", memberChats: fanout(20) })}
        onClick={onClick}
        showPath
        expanded
        selectionMode
        selectable={false}
        onToggleSelect={vi.fn()}
        onToggleExpand={vi.fn()}
        onOpenFolder={onOpenFolder}
      />,
    );

    // The expansion is a SIBLING of the row's button, so the `disabled` that
    // makes an out-of-scope row inert stops at that button. A dimmed, dead row
    // whose folder paths still open the drawer is the row lying about itself.
    fireEvent.click(screen.getByTitle("/home/cybil/callboard.feat-1"));
    fireEvent.click(screen.getByText("… 12 more"));
    expect(onOpenFolder).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    // Out of tab order too, not merely unresponsive to the mouse.
    expect(entries().length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button").filter((el) => el !== surface() && !(el as HTMLButtonElement).disabled)).toHaveLength(0);
  });

  it("toggles the selection instead of drilling in while a selection is in progress", () => {
    setWidth(1024);
    const onOpenFolder = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      <CardRow
        card={card({ memberChats: fanout(3) })}
        onClick={vi.fn()}
        showPath
        expanded
        selectionMode
        onToggleSelect={onToggleSelect}
        onToggleExpand={vi.fn()}
        onOpenFolder={onOpenFolder}
      />,
    );

    // Same contract as the row above it: while cards are being selected, a
    // click on the face is part of the selection, not a navigation away from
    // one half-built.
    fireEvent.click(screen.getByTitle("/home/cybil/callboard.feat-1"));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).not.toHaveBeenCalled();
  });

  it("does not let the click after a long press open the drawer from the footer", () => {
    setWidth(1024);
    const onClick = vi.fn();
    render(
      <CardRow
        card={card({ memberChats: fanout(20) })}
        onClick={onClick}
        showPath
        expanded
        onToggleExpand={vi.fn()}
        onOpenFolder={vi.fn()}
        onLongPress={vi.fn()}
      />,
    );

    // The footer went straight to the raw onClick prop, so it answered the
    // click a long press leaves behind — which the row itself has always
    // swallowed.
    fireEvent.contextMenu(surface());
    fireEvent.click(screen.getByText("… 12 more"));
    expect(onClick).not.toHaveBeenCalled();

    // Only that one click, though.
    fireEvent.click(screen.getByText("… 12 more"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stays shut when the board has not asked for it", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
    expect(screen.queryAllByRole("button").filter((el) => el !== surface())).toHaveLength(0);
  });
});

describe("keyboard and screen reader", () => {
  const open = (extra: Partial<React.ComponentProps<typeof CardRow>> = {}) =>
    render(
      <CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} {...extra} />,
    );

  it("opens and closes one row from the keyboard", () => {
    setWidth(1024);
    const onToggleExpand = vi.fn();
    const { rerender } = open({ onToggleExpand });

    // The chevron is a span inside a button and can never take focus, so
    // without this there is NO keyboard path to one row's expansion at all —
    // only the header's all-rows toggle. A literal WCAG 2.1.1 failure.
    fireEvent.keyDown(surface(), { key: "ArrowRight" });
    expect(onToggleExpand).toHaveBeenCalledTimes(1);

    rerender(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath expanded onToggleExpand={onToggleExpand} onOpenFolder={vi.fn()} />);
    fireEvent.keyDown(surface(), { key: "ArrowLeft" });
    expect(onToggleExpand).toHaveBeenCalledTimes(2);
  });

  it("leaves the arrow keys alone in the direction the row is already in", () => {
    setWidth(1024);
    const onToggleExpand = vi.fn();
    open({ onToggleExpand });
    // ArrowRight on an open row is not "close it": the disclosure convention
    // is directional, not a toggle, and the row scrolls under it otherwise.
    fireEvent.keyDown(surface(), { key: "ArrowLeft" });
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it("does not claim to be the expander, because Enter opens the drawer", () => {
    setWidth(1024);
    open({ expanded: true });
    // aria-expanded here would promise that activating this button toggles
    // the expansion. It opens the drawer.
    expect(surface().getAttribute("aria-expanded")).toBeNull();
  });

  it("keeps the decorative chevron out of the row's name", () => {
    setWidth(1024);
    open();
    expect(screen.getByTitle("Show all 3 folders").getAttribute("aria-hidden")).toBe("true");
  });

  it("names the two cells that are otherwise bare numbers in a column", () => {
    setWidth(1024);
    open();
    // "…callboard +2 Idle 2 2h" is not something a screen reader can parse,
    // and the icon and the column position that disambiguate them for a
    // sighted reader are exactly what is unavailable here.
    expect(surface().textContent).toContain("2");
    expect(screen.getByLabelText("2 chats")).toBeDefined();
    expect(screen.getByLabelText(/^last active .+ ago$/)).toBeDefined();
  });

  it("ties the expansion back to the card whose folders it lists", () => {
    setWidth(1024);
    open({ expanded: true });
    // Tab lands in here from the row above with no announcement that the
    // context changed.
    const group = screen.getByRole("group", { name: "Folders Ship the thing spans" });
    expect(group.querySelectorAll("button").length).toBe(3);
  });

  it("names each folder entry in full, card included", () => {
    setWidth(1024);
    open({ expanded: true });
    // The path label inside is middle-truncated and the count and time beside
    // it are bare numbers, so the visible text names nothing on its own.
    expect(screen.getByRole("button", { name: "/home/cybil/callboard, 1 chat, root folder, in Ship the thing" })).toBeDefined();
    expect(screen.getByRole("button", { name: "/home/cybil/callboard.feat-1, 1 chat, in Ship the thing" })).toBeDefined();
  });

  it("puts focus back on the row when a collapse takes the expansion away", () => {
    setWidth(1024);
    const { rerender } = open({ expanded: true });

    const entry = screen.getByRole("button", { name: /callboard\.feat-1/ });
    entry.focus();
    expect(document.activeElement).toBe(entry);

    // The header toggle, a chevron, or the 15s poll dropping a folder — all
    // unmount this while focus is inside it, and focus would otherwise fall
    // to <body>, back at the top of the document.
    rerender(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
    expect(document.activeElement).toBe(surface());
  });

  it("leaves focus where the user put it when the collapse did not steal it", () => {
    setWidth(1024);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      const { rerender } = open({ expanded: true });
      outside.focus();

      rerender(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});

describe("contrast", () => {
  it("makes no text in the row recede by opacity", () => {
    setWidth(1024);
    // Every site that used to: the running job, the hoisted prefix, the `root`
    // label and the footer, all in one render.
    const { container } = render(
      <CardRow
        card={card({ status: "rebasing", memberRuns: [RUN], memberChats: fanout(20) })}
        onClick={vi.fn()}
        showPath
        expanded
        onToggleExpand={vi.fn()}
        onOpenFolder={vi.fn()}
      />,
    );

    // --board-tile-meta-text is 5.62:1 dark / 6.09:1 light on the row; at 0.7
    // it composites to 3.43:1 / 3.16:1, under AA, on text as small as 10px.
    // A partial opacity anywhere in here is that bug coming back — 1 and 0 are
    // the row's own dim and the checkbox's reveal, which are not text colour.
    const faded = [...container.querySelectorAll<HTMLElement>("*")].filter(
      (el) => el.style.opacity !== "" && el.style.opacity !== "1" && el.style.opacity !== "0",
    );
    expect(faded.map((el) => el.textContent)).toEqual([]);
  });
});

describe("the selection checkbox", () => {
  it("sits on the emoji it replaces, not in the middle of whatever the row grew", () => {
    setWidth(1024);
    render(
      <CardRow card={card({ memberChats: fanout(8) })} onClick={vi.fn()} showPath expanded onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} onToggleSelect={vi.fn()} />,
    );

    // The checkbox is absolutely positioned against the OUTER element, which
    // is a column holding the row and its expansion. Centring it there put it
    // level with folder five while the blanked emoji slot stayed on line one.
    const box = screen.getByRole("checkbox");
    expect(box.style.top).toBe("7px");
    expect(box.style.transform).toBe("");
  });
});

describe("mobile", () => {
  it("collapses to two lines with a thumb-sized target", () => {
    setWidth(500);
    render(<CardRow card={card({ status: "rebasing", memberChats: [FOLDER] })} onClick={vi.fn()} showPath onOpenFolder={vi.fn()} />);

    // Not a grid at all: seven columns on a phone is a row of ellipses.
    expect(surface().style.display).toBe("flex");
    expect(surface().style.flexDirection).toBe("column");
    expect(surface().children).toHaveLength(2);
    // Two lines of 11-13px text do not reach the 44px a thumb can hit.
    expect(surface().style.minHeight).toBe("44px");
  });

  it("gives the chevron a target a thumb can hit, without reaching into the cell beside it", () => {
    setWidth(500);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);

    const chevron = screen.getByTitle("Show all 3 folders");
    expect(chevron.style.width).toBe("36px");
    expect(chevron.style.height).toBe("36px");
    // Sized rather than bled sideways: a horizontal negative margin would put
    // the target over the status text next to it, where a miss opens the
    // drawer.
    expect(chevron.style.marginInline).toBe("");
    expect(chevron.parentElement!.style.width).toBe("36px");
  });

  it("does not spend that target on making its row a third taller", () => {
    setWidth(360);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);

    // Measured at 360px: 77px with the chevron against 58px without, on the
    // ~3% of cards that fan out — a third taller than their neighbours, in
    // the view that exists so columns line up. The bleed hands the height
    // back to the line while the box keeps it; above and below is the row's
    // own padding, so unlike a sideways bleed nothing else is under it.
    const chevron = screen.getByTitle("Show all 3 folders");
    expect(chevron.style.marginBlock).toBe("-10px");
    // (36 - 16) / 2 either side, so a 36px box occupies the 16px a line of
    // this row's text does. A bleed that does not cancel the overflow leaves
    // the row taller than the one under it by whatever is left.
    expect(Number.parseInt(chevron.style.height, 10) + 2 * Number.parseInt(chevron.style.marginBlock, 10)).toBe(16);
  });

  it("does not reserve the target on rows that have no chevron to put in it", () => {
    setWidth(500);
    const { container } = render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} onOpenFolder={vi.fn()} />);
    // The desktop grid holds the slot open so paths share a left edge; line
    // two of a phone has no column to align, and 36px of dead space on a
    // 360px screen only costs the path its width.
    const slots = [...container.querySelectorAll<HTMLElement>("span")].filter((el) => el.style.width === "36px");
    expect(slots).toHaveLength(0);
  });
});
