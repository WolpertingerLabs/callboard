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

function surface() {
  return screen.getByRole("button", { name: /Ship the thing/ });
}

afterEach(cleanup);

describe("the desktop template", () => {
  it("drops the folders column outright when paths are off", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} />);
    const columns = surface().style.gridTemplateColumns;

    // Six columns, not seven with an empty one: with paths off the title and
    // status get that width back instead of a blank stripe down the list.
    expect(columns).toBe("18px minmax(0,2fr) minmax(0,3fr) auto auto auto");
    expect(surface().children).toHaveLength(6);
  });

  it("adds the folders column, in the middle, when paths are on", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath />);

    expect(surface().style.gridTemplateColumns).toBe("18px minmax(0,2fr) minmax(0,3fr) minmax(0,1.5fr) auto auto auto");
    expect(surface().children).toHaveLength(7);
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
  });

  it("keeps the folders column when a card has no folders to put in it", () => {
    setWidth(1024);
    // A root on a retired provider: a real card with no member rows. The
    // column stays, or every path below it would step sideways.
    render(<CardRow card={card()} onClick={vi.fn()} showPath />);

    expect(surface().children).toHaveLength(7);
    expect(document.querySelector("[title^='/']")).toBeNull();
  });
});

describe("the status cell carries the running job", () => {
  it("appends it after the status without spending an eighth column", () => {
    setWidth(1024);
    render(<CardRow card={card({ status: "rebasing onto main", memberRuns: [RUN] })} onClick={vi.fn()} />);

    // Still the six-column template: the job shares the status cell rather
    // than narrowing every other column on the board for one optional string.
    expect(surface().style.gridTemplateColumns).toBe("18px minmax(0,2fr) minmax(0,3fr) auto auto auto");
    // The title is the escape hatch for whatever the cell's ellipsis eats.
    const cell = screen.getByTitle("rebasing onto main · nightly-rebase");
    expect(cell.textContent).toBe("rebasing onto main · nightly-rebase");
  });

  it("lets the job stand alone when the card has no status text", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberRuns: [RUN] })} onClick={vi.fn()} />);

    // No leading separator dangling off nothing.
    expect(screen.getByTitle("nightly-rebase").textContent).toBe("nightly-rebase");
  });

  it("keeps it on the mobile second line, which is where the status lives there", () => {
    setWidth(500);
    render(<CardRow card={card({ memberRuns: [RUN] })} onClick={vi.fn()} />);
    // The second line is mounted on the strength of the job alone — gating it
    // on card.status would drop the job on a card that has never set one.
    expect(screen.getByText("nightly-rebase")).toBeDefined();
  });
});

describe("the expansion chevron", () => {
  // Not /folders$/: the +N badge beside it is titled "N other folders".
  const chevron = () => screen.queryByTitle(/^(Show all|Hide) /);

  it("stays away from the 97% of cards that live in one folder", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} />);
    // An affordance that does nothing on 794 of 818 rows is noise on all of them.
    expect(chevron()).toBeNull();
  });

  it("appears once there is a second folder to open onto", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} />);
    expect(chevron()).toBeDefined();
    expect(screen.getByTitle("Show all 3 folders")).toBeDefined();
  });

  it("toggles the row without opening the drawer under it", () => {
    setWidth(1024);
    const onClick = vi.fn();
    const onToggleExpand = vi.fn();
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={onClick} showPath onToggleExpand={onToggleExpand} />);

    fireEvent.click(screen.getByTitle("Show all 3 folders"));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
    // It sits inside the row's main button, so a click that did not stop
    // there would open the drawer on its way past.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is a span, not a button, because it lives inside one", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: fanout(3) })} onClick={vi.fn()} showPath onToggleExpand={vi.fn()} />);
    // A nested <button> is invalid markup the parser splits apart, and no
    // screen reader or keyboard can drive the result.
    expect(screen.getByTitle("Show all 3 folders").tagName).toBe("SPAN");
    expect(surface().querySelectorAll("button")).toHaveLength(0);
  });

  it("holds its 12px slot open on every row so the paths share a left edge", () => {
    setWidth(1024);
    const { container } = render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath />);
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
    render(<CardRow card={card({ status: "rebasing", memberChats: [FOLDER] })} onClick={vi.fn()} showPath />);

    // Not a grid at all: seven columns on a phone is a row of ellipses.
    expect(surface().style.display).toBe("flex");
    expect(surface().style.flexDirection).toBe("column");
    expect(surface().children).toHaveLength(2);
    // Two lines of 11-13px text do not reach the 44px a thumb can hit.
    expect(surface().style.minHeight).toBe("44px");
  });
});
