/**
 * The tile's two jobs, and the seam between them.
 *
 * A tile is a button that opens a drawer, and — once the board hands it
 * selection props — a checkbox that toggles. The regression that matters most
 * is the seam: a long press must not ALSO open the drawer via the click every
 * browser emits afterwards, and a tile handed no selection props at all must
 * be indistinguishable from the tile that existed before any of this.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import type { CardSummary } from "../../api";
import CardTile from "./CardTile";

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

/** The tile's main surface — the full-bleed "open" button, not the checkbox. */
function tile() {
  return screen.getByRole("button", { name: /Ship the thing/ });
}

function longPress(el: HTMLElement) {
  fireEvent.pointerDown(el, { pointerType: "touch", clientX: 10, clientY: 20 });
  act(() => void vi.advanceTimersByTime(500));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("with no selection props — the no-regression control", () => {
  it("opens on click, exactly as it always did", () => {
    const onClick = vi.fn();
    render(<CardTile card={card()} onClick={onClick} />);
    fireEvent.click(tile());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("still renders its emoji, title and chat count", () => {
    render(<CardTile card={card({ status: "waiting on review" })} onClick={vi.fn()} />);
    expect(screen.getByText("🚀")).toBeDefined();
    expect(screen.getByText("Ship the thing")).toBeDefined();
    expect(screen.getByText(/waiting on review/)).toBeDefined();
  });

  it("offers no checkbox and claims no pressed state", () => {
    render(<CardTile card={card()} onClick={vi.fn()} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(tile().getAttribute("aria-pressed")).toBeNull();
  });

  it("leaves the browser's own context menu alone", () => {
    render(<CardTile card={card()} onClick={vi.fn()} />);
    // Not defaultPrevented: with nothing to offer in its place, taking the
    // native menu away would be a pure loss.
    expect(fireEvent.contextMenu(tile())).toBe(true);
  });

  it("is a real button, which is where Enter and Space activation comes from", () => {
    render(<CardTile card={card()} onClick={vi.fn()} />);
    // jsdom does not synthesise click from keydown, so the honest assertion is
    // on the element that gives us native keyboard activation, not on a
    // keydown handler we would then have to de-duplicate against the click.
    expect(tile().tagName).toBe("BUTTON");
  });
});

describe("long press", () => {
  it("calls onLongPress and NOT onClick", () => {
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(<CardTile card={card()} onClick={onClick} onLongPress={onLongPress} onToggleSelect={vi.fn()} />);

    longPress(tile());
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // The click the browser emits after the press must not also open the drawer.
    fireEvent.click(tile());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("suppresses only the one click that follows it", () => {
    const onClick = vi.fn();
    render(<CardTile card={card()} onClick={onClick} onLongPress={vi.fn()} onToggleSelect={vi.fn()} />);

    longPress(tile());
    fireEvent.click(tile());
    fireEvent.click(tile());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a short press still opens the drawer", () => {
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(<CardTile card={card()} onClick={onClick} onLongPress={onLongPress} onToggleSelect={vi.fn()} />);

    fireEvent.pointerDown(tile(), { pointerType: "touch", clientX: 10, clientY: 20 });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.pointerUp(tile());
    fireEvent.click(tile());

    expect(onLongPress).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("in selection mode", () => {
  it("a tap toggles instead of opening the drawer", () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(<CardTile card={card()} onClick={onClick} selectionMode selected={false} onToggleSelect={onToggleSelect} onLongPress={vi.fn()} />);

    fireEvent.click(tile());
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a tile outside the lifecycle scope does neither", () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      <CardTile card={card({ lifecycle: "closed" })} onClick={onClick} selectionMode selectable={false} onToggleSelect={onToggleSelect} onLongPress={vi.fn()} />,
    );

    fireEvent.click(tile());
    expect(onToggleSelect).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("takes an out-of-scope tile's checkbox out of tab order too", () => {
    render(<CardTile card={card({ lifecycle: "closed" })} onClick={vi.fn()} selectionMode selectable={false} onToggleSelect={vi.fn()} />);
    // Invisible is not enough: a focusable button fires on Enter however
    // transparent it is.
    expect((screen.getByRole("checkbox", { hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tracks selection in aria-pressed", () => {
    const { rerender } = render(<CardTile card={card()} onClick={vi.fn()} selectionMode selected={false} onToggleSelect={vi.fn()} />);
    expect(tile().getAttribute("aria-pressed")).toBe("false");

    rerender(<CardTile card={card()} onClick={vi.fn()} selectionMode selected onToggleSelect={vi.fn()} />);
    expect(tile().getAttribute("aria-pressed")).toBe("true");
  });

  it("marks the checkbox checked and shows a checkmark, not just a colour", () => {
    const { container } = render(<CardTile card={card()} onClick={vi.fn()} selectionMode selected onToggleSelect={vi.fn()} />);
    const box = screen.getByRole("checkbox", { name: /Select Ship the thing/ });
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("svg.lucide-check")).not.toBeNull();
  });
});

describe("the checkbox affordance", () => {
  it("is in the DOM even before hover, so Tab can reach it", () => {
    render(<CardTile card={card()} onClick={vi.fn()} onToggleSelect={vi.fn()} />);
    const box = screen.getByRole("checkbox");
    // Hidden by opacity rather than by unmounting: a checkbox that only
    // exists on :hover is one keyboard users can never find.
    expect(box.style.opacity).toBe("0");
    expect(box.style.pointerEvents).toBe("none");
  });

  it("is revealed by keyboard focus, not only by the mouse", () => {
    render(<CardTile card={card()} onClick={vi.fn()} onToggleSelect={vi.fn()} />);
    const box = screen.getByRole("checkbox");
    fireEvent.focus(box);
    expect(box.style.opacity).toBe("1");
    expect(box.style.pointerEvents).toBe("auto");
  });

  it("toggles without opening the drawer", () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(<CardTile card={card()} onClick={onClick} onToggleSelect={onToggleSelect} />);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    // A sibling of the open button, not a child of it — so no propagation to undo.
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("modifier clicks reach the board even outside selection mode", () => {
  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
  ])("%s+click routes to onToggleSelect rather than opening", (_name, init) => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(<CardTile card={card()} onClick={onClick} onToggleSelect={onToggleSelect} />);

    fireEvent.click(tile(), init);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a plain click still opens the drawer", () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(<CardTile card={card()} onClick={onClick} onToggleSelect={onToggleSelect} />);

    fireEvent.click(tile());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
  });
});
