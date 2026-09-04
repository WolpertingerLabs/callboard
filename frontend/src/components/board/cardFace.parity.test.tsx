/**
 * One selection contract, asserted against both faces.
 *
 * A tile and a row are the same card wearing different layouts, and the board
 * hands them identical props. What must never differ is what a click, a long
 * press and a modified click *mean* — that lives in `useCardActivation`, and
 * the way it breaks is not a failing assertion in either component's own test
 * but a second face that quietly grew its own copy of the logic.
 *
 * So this file is a table, deliberately: every case runs against both, and a
 * new face is one entry away from being held to the same contract. Layout is
 * emphatically not asserted here — the two faces are supposed to differ there.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import type { CardMemberChat, CardMemberRun, CardSummary } from "../../api";
import CardTile from "./CardTile";
import CardRow from "./CardRow";

function member(overrides: Partial<CardMemberChat> & Pick<CardMemberChat, "chatId" | "folder">): CardMemberChat {
  return {
    title: null,
    status: "stopped",
    hasSummon: false,
    unread: false,
    isTriggered: false,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

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

/** The face's main surface — the button that opens the drawer, not the checkbox. */
function face() {
  return screen.getAllByRole("button", { name: /Ship the thing/ }).find((el) => el.closest('[role="group"]') === null)!;
}

/** The face's outer element, which is where the board's hover and gesture props land. */
function outer(container: HTMLElement) {
  return container.firstElementChild as HTMLElement;
}

function longPress(el: HTMLElement) {
  fireEvent.pointerDown(el, { pointerType: "touch", clientX: 10, clientY: 20 });
  act(() => void vi.advanceTimersByTime(500));
}

beforeEach(() => {
  vi.useFakeTimers();
  // Desktop: the row's mobile branch is a different layout, not a different
  // contract, and this file is about the contract.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const FACES = [
  ["CardTile", CardTile],
  ["CardRow", CardRow],
] as const;

describe.each(FACES)("%s — the shared selection contract", (_name, Face) => {
  describe("the checkbox affordance", () => {
    it("is mounted but invisible until something asks for it", () => {
      render(<Face card={card()} onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      const box = screen.getByRole("checkbox");
      // Hidden by opacity rather than by unmounting: a checkbox that only
      // exists on :hover is one keyboard users can never find.
      expect(box.style.opacity).toBe("0");
      expect(box.style.pointerEvents).toBe("none");
    });

    it("is revealed by hover", () => {
      const { container } = render(<Face card={card()} onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      fireEvent.mouseEnter(outer(container));
      expect(screen.getByRole("checkbox").style.opacity).toBe("1");

      fireEvent.mouseLeave(outer(container));
      expect(screen.getByRole("checkbox").style.opacity).toBe("0");
    });

    it("is revealed by keyboard focus, not only by the mouse", () => {
      render(<Face card={card()} onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      const box = screen.getByRole("checkbox");
      fireEvent.focus(box);
      expect(box.style.opacity).toBe("1");
      expect(box.style.pointerEvents).toBe("auto");
    });

    it("is revealed by selection mode, with no hover at all", () => {
      render(<Face card={card()} onClick={vi.fn()} selectionMode onToggleSelect={vi.fn()} />);
      expect(screen.getByRole("checkbox").style.opacity).toBe("1");
    });

    it("names itself identically on both faces", () => {
      render(<Face card={card()} onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      // From the hook's checkboxLabel, so the two faces cannot drift into
      // naming the same control two different things.
      expect(screen.getByRole("checkbox").getAttribute("aria-label")).toBe("Select Ship the thing");
    });

    it("does not exist at all when the board offers no selection", () => {
      render(<Face card={card()} onClick={vi.fn()} />);
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(face().getAttribute("aria-pressed")).toBeNull();
    });

    it("tracks selection in aria-checked", () => {
      const { rerender } = render(<Face card={card()} onClick={vi.fn()} selectionMode selected={false} onToggleSelect={vi.fn()} />);
      expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");

      rerender(<Face card={card()} onClick={vi.fn()} selectionMode selected onToggleSelect={vi.fn()} />);
      expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    });

    it("toggles without opening the drawer", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Face card={card()} onClick={onClick} onToggleSelect={onToggleSelect} />);

      fireEvent.click(screen.getByRole("checkbox"));
      expect(onToggleSelect).toHaveBeenCalledTimes(1);
      // A sibling of the open button, not a child of it — so no propagation to undo.
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("out of the selection's lifecycle scope", () => {
    it("answers neither a click nor a toggle", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Face card={card({ lifecycle: "closed" })} onClick={onClick} selectionMode selectable={false} onToggleSelect={onToggleSelect} />);

      fireEvent.click(face());
      expect(onClick).not.toHaveBeenCalled();
      expect(onToggleSelect).not.toHaveBeenCalled();
    });

    it("takes its checkbox out of tab order too, not merely out of sight", () => {
      render(<Face card={card({ lifecycle: "closed" })} onClick={vi.fn()} selectionMode selectable={false} onToggleSelect={vi.fn()} />);
      // A focusable button still fires on Enter however transparent it is.
      expect((screen.getByRole("checkbox", { hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("gestures", () => {
    it("enters selection on a long press, without opening the drawer", () => {
      const onClick = vi.fn();
      const onLongPress = vi.fn();
      render(<Face card={card()} onClick={onClick} onLongPress={onLongPress} onToggleSelect={vi.fn()} />);

      longPress(face());
      expect(onLongPress).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it("swallows the click the browser emits after that press", () => {
      const onClick = vi.fn();
      render(<Face card={card()} onClick={onClick} onLongPress={vi.fn()} onToggleSelect={vi.fn()} />);

      longPress(face());
      fireEvent.click(face());
      expect(onClick).not.toHaveBeenCalled();

      // Only that one click, though — the face is not left dead.
      fireEvent.click(face());
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("leaves the browser's own context menu alone when it has no selection to offer", () => {
      render(<Face card={card()} onClick={vi.fn()} />);
      // Not defaultPrevented: taking the native menu away and putting nothing
      // in its place is a pure loss.
      expect(fireEvent.contextMenu(face())).toBe(true);
    });

    it("routes a modified click to the board rather than opening", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Face card={card()} onClick={onClick} onToggleSelect={onToggleSelect} />);

      fireEvent.click(face(), { metaKey: true });
      expect(onToggleSelect).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it("opens the drawer on a plain click", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Face card={card()} onClick={onClick} onToggleSelect={onToggleSelect} />);

      fireEvent.click(face());
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onToggleSelect).not.toHaveBeenCalled();
    });

    it("toggles instead of opening once selection mode is on", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Face card={card()} onClick={onClick} selectionMode onToggleSelect={onToggleSelect} onLongPress={vi.fn()} />);

      fireEvent.click(face());
      expect(onToggleSelect).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("the running job", () => {
    const run = (overrides: Partial<CardMemberRun> = {}): CardMemberRun => ({
      runId: "run-1",
      jobId: "job-1",
      jobName: "nightly-rebase",
      status: "running",
      createdAt: "2026-08-07T10:00:00.000Z",
      updatedAt: "2026-08-07T10:30:00.000Z",
      ...overrides,
    });

    // The two faces give it different room — a line of its own on the tile,
    // a share of the status cell on the row — but "a running job names itself
    // on the card's face" is a fact contract, and the row silently dropping it
    // is exactly the divergence this file exists to catch.
    it("names itself on the face while the run is open", () => {
      render(<Face card={card({ memberRuns: [run()] })} onClick={vi.fn()} />);
      expect(screen.getByText(/nightly-rebase/)).toBeDefined();
    });

    it("says nothing once the run has ended", () => {
      render(<Face card={card({ memberRuns: [run({ endedAt: "2026-08-07T10:31:00.000Z" })] })} onClick={vi.fn()} />);
      expect(screen.queryByText(/nightly-rebase/)).toBeNull();
    });

    it("says nothing on a closed card, whose member runs are history", () => {
      render(<Face card={card({ lifecycle: "closed", memberRuns: [run()] })} onClick={vi.fn()} />);
      expect(screen.queryByText(/nightly-rebase/)).toBeNull();
    });
  });

  describe("the status line", () => {
    // The most prominent fact on a card face, and the exact thing `statusLine`
    // was extracted so the two faces could not drift on — and until these,
    // stubbing it to "" left 296 tests green on both.
    it("says what a card wants from you rather than naming its rollup state", () => {
      render(<Face card={card({ rollup: "needs_you", memberChats: [member({ chatId: "a", folder: "/x", status: "waiting", pendingKind: "permission" })] })} onClick={vi.fn()} />);
      // "Approval needed", not "Needs you": that difference is the whole
      // reason a board is scannable rather than something to click through.
      expect(screen.getByText("Approval needed")).toBeDefined();
    });

    it("says Idle when there is nothing to say", () => {
      render(<Face card={card({ rollup: "idle" })} onClick={vi.fn()} />);
      expect(screen.getByText("Idle")).toBeDefined();
    });

    it("says Closed over whatever the rollup still claims", () => {
      // A closed card's rollup is not recomputed on close, so the lifecycle
      // has to win here or a closed card reads as live.
      render(<Face card={card({ lifecycle: "closed", rollup: "needs_you" })} onClick={vi.fn()} />);
      expect(screen.getByText("Closed")).toBeDefined();
      expect(screen.queryByText("Needs you")).toBeNull();
    });
  });

  describe("the folder summary", () => {
    const SINGLE = [member({ chatId: "card-1", folder: "/home/cybil/callboard" })];
    const FANOUT = [...SINGLE, member({ chatId: "a", folder: "/home/cybil/callboard.feat-a" })];

    it("says nothing about folders until the board asks", () => {
      render(<Face card={card({ memberChats: FANOUT })} onClick={vi.fn()} />);
      expect(screen.queryByTitle("/home/cybil/callboard")).toBeNull();
      expect(screen.queryByText(/^\+\d/)).toBeNull();
    });

    it("shows the root folder and no +N when the card lives in one place", () => {
      render(<Face card={card({ memberChats: SINGLE })} onClick={vi.fn()} showPath />);
      expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
      expect(screen.queryByText(/^\+\d/)).toBeNull();
    });

    it("counts the other folders, and colours the count when the action is in one of them", () => {
      render(
        <Face
          card={card({ memberChats: [SINGLE[0], member({ chatId: "a", folder: "/elsewhere", status: "waiting" })], rollup: "needs_you" })}
          onClick={vi.fn()}
          showPath
        />,
      );
      expect(screen.getByText("+1").getAttribute("style")).toContain("--board-rollup-needs-you");
    });

    it("leaves the count in meta colour when only the folder on show is live", () => {
      render(
        <Face
          card={card({
            memberChats: [member({ chatId: "card-1", folder: "/home/cybil/callboard", status: "waiting" }), member({ chatId: "a", folder: "/elsewhere" })],
            rollup: "needs_you",
          })}
          onClick={vi.fn()}
          showPath
        />,
      );
      // The action is on the path already on the face. Lighting up the +N here
      // would send the reader somewhere there is nothing to find.
      expect(screen.getByText("+1").getAttribute("style")).toContain("--board-tile-meta-text");
    });

    it("takes the count's colour from those other folders, not from the card's rollup", () => {
      render(
        <Face
          card={card({
            memberChats: [
              member({ chatId: "card-1", folder: "/home/cybil/callboard", status: "waiting" }),
              member({ chatId: "a", folder: "/elsewhere", status: "ongoing" }),
            ],
            rollup: "needs_you",
          })}
          onClick={vi.fn()}
          showPath
        />,
      );
      // Someone is blocked on the root, and something is merely ticking over
      // in the other folder. Painting the +N "needs you" would have it claim a
      // person is waiting over there when nobody is — which is precisely the
      // fact this one glyph exists to carry.
      expect(screen.getByText("+1").getAttribute("style")).toContain("--board-rollup-active");
    });

    it("names the count for a reader who cannot see the colour it is painted in", () => {
      render(
        <Face
          card={card({ memberChats: [SINGLE[0], member({ chatId: "a", folder: "/elsewhere", status: "waiting" })], rollup: "needs_you" })}
          onClick={vi.fn()}
          showPath
        />,
      );
      // Otherwise the face's accessible name runs "+1" into the path beside it
      // and the state the colour carries is simply gone.
      expect(screen.getByText("+1").getAttribute("aria-label")).toBe("1 other folder, one needs you");
    });
  });
});
