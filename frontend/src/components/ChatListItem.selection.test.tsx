// @vitest-environment jsdom
/**
 * The sidebar row as a SELECTABLE row.
 *
 * The gesture rules themselves are shared code — `useSelectionActivation`, the
 * hook the board's two faces also run on, held to one contract by
 * `board/cardFace.parity.test.tsx`. So this file deliberately does not re-test
 * them. What it tests is the half that cannot be shared: this row's own markup
 * decisions, and the three places they differ from `CardRow` on purpose.
 *
 *  - the checkbox rides in the row's existing action cluster rather than taking
 *    a left-hand slot, so it is revealed by the same hover the kebab always
 *    was, and by keyboard focus;
 *  - it is MOUNTED only while shown, where CardRow keeps its own mounted at
 *    `opacity: 0`. A sidebar of 50 rows doing that is 50 invisible tab stops,
 *    so the trade is one tab stop while pointing at a row (and one per row
 *    during a selection, where they are visible) instead of one per row always;
 *  - the checkbox is a DESCENDANT of the row's clickable surface, not a
 *    sibling of it as on a card face, so its click has to stop the row's own
 *    handler from toggling straight back.
 *
 * And the aria, where the departure is the sharpest: the ROW carries no role
 * and no `aria-pressed`. It cannot honour them — it is a div that contains
 * buttons, so it cannot become one, and it has no tab stop and no key handler.
 * The state lives on the checkbox instead, which is a real button with
 * `role="checkbox"` and `aria-checked`.
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

const FOLDER = "/home/cybil/projects/my-cool-repo";

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: "sess-1",
    session_log_path: null,
    metadata: JSON.stringify({ title: "Fix the rebase" }),
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

/** The row root, which is where the list's hover and gesture props land. */
function row(container: HTMLElement) {
  return container.firstElementChild as HTMLElement;
}

const noop = () => {};

/** A row with selection wired, as the list wires it. */
function renderSelectable(props: Partial<React.ComponentProps<typeof ChatListItem>> = {}) {
  return render(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} onToggleSelect={vi.fn()} {...props} />);
}

describe("the checkbox affordance", () => {
  it("adds no tab stop to a row at rest", () => {
    const { container } = renderSelectable();
    // Not merely invisible — absent. This is the departure from CardRow, and
    // the whole of its justification: an always-mounted box would be one tab
    // stop per row, on a list that has fifty.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("is revealed by hover, alongside the kebab that was already there", () => {
    const { container } = renderSelectable();
    fireEvent.mouseEnter(row(container));

    expect(screen.getByRole("checkbox")).toBeTruthy();
    // The cluster's other occupant is untouched: revealing a checkbox must not
    // cost the row its menu.
    expect(screen.getByTitle("Chat actions")).toBeTruthy();

    fireEvent.mouseLeave(row(container));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("survives the pointer leaving while it holds focus", () => {
    const { container } = renderSelectable();
    fireEvent.mouseEnter(row(container));
    fireEvent.focus(screen.getByRole("checkbox"));
    fireEvent.mouseLeave(row(container));

    // `checkboxFocusProps` is the whole point: a control that vanished out
    // from under its own focus ring would be unusable by keyboard even where
    // a keyboard can reach it.
    expect(screen.getByRole("checkbox")).toBeTruthy();

    fireEvent.blur(screen.getByRole("checkbox"));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("is shown in selection mode with no hover at all", () => {
    renderSelectable({ selectionMode: true });
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("names itself by what the row says, not by the chat's folder", () => {
    renderSelectable({ selectionMode: true });
    // From the shared hook's `checkboxLabel`, over the row's `displayName` —
    // a checkbox announcing the folder path of a titled chat names a control
    // the user cannot see.
    expect(screen.getByRole("checkbox").getAttribute("aria-label")).toBe("Select Fix the rebase");
  });

  it("draws a checkmark rather than only a colour", () => {
    const { container, rerender } = renderSelectable({ selectionMode: true });
    expect(container.querySelector("svg.lucide-check")).toBeNull();

    rerender(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} onToggleSelect={vi.fn()} selectionMode selected />);
    expect(container.querySelector("svg.lucide-check")).toBeTruthy();
  });

  it("toggles without opening the chat", () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    const { container } = render(<ChatListItem chat={makeChat()} onClick={onClick} onDelete={noop} onToggleSelect={onToggleSelect} />);
    fireEvent.mouseEnter(row(container));

    fireEvent.click(screen.getByRole("checkbox"));
    // Exactly once, and the row's own handler did not also fire: the box sits
    // INSIDE the clickable row here, unlike a card face's, so without the
    // stopPropagation this would toggle on and straight back off.
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("the selected row", () => {
  it("says so with the accent bar and a ring", () => {
    const { container } = renderSelectable({ selectionMode: true, selected: true });
    const style = row(container).style;

    expect(style.borderLeft).toContain("var(--accent)");
    expect(style.outline).toContain("var(--accent)");
  });

  it("keeps the active chat's own bar when it is not selected", () => {
    const { container } = renderSelectable({ selectionMode: true, isActive: true });
    // "Selected" and "open in the pane" are different facts that can both be
    // true; the bar is one slot, so the selection wins it and the active row
    // keeps it otherwise.
    expect(row(container).style.borderLeft).toContain("var(--chatlist-item-active-border)");
  });

  it("puts the state on the checkbox and NOT on the row", () => {
    const { container, rerender } = renderSelectable({ selectionMode: true });

    // The row is a div with an onClick: no tab stop, no key handler, and it
    // cannot become a <button> because it contains buttons. So it claims
    // neither a role nor a pressed state — announcing a button that cannot be
    // reached or activated is worse than announcing nothing. CardRow can do
    // the opposite precisely because it IS a button.
    expect(row(container).getAttribute("role")).toBeNull();
    expect(row(container).getAttribute("aria-pressed")).toBeNull();

    // What a screen reader gets instead, and it is a real control:
    const box = screen.getByRole("checkbox");
    expect(box.tagName).toBe("BUTTON");
    expect(box.getAttribute("aria-checked")).toBe("false");

    rerender(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} onToggleSelect={vi.fn()} selectionMode selected />);
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  it("is an unnamed clickable div when the list offers no selection at all", () => {
    const { container } = render(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} />);
    expect(row(container).getAttribute("role")).toBeNull();
    expect(row(container).getAttribute("aria-pressed")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("out of the selection's scope", () => {
  const outOfScope = { selectionMode: true, selectable: false } as const;

  it("answers neither a click nor a toggle", () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    const { container } = render(
      <ChatListItem chat={makeChat()} onClick={onClick} onDelete={noop} onToggleSelect={onToggleSelect} {...outOfScope} />,
    );

    fireEvent.click(row(container));
    expect(onClick).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it("is dimmed, and offers no checkbox to press", () => {
    const { container } = render(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} onToggleSelect={vi.fn()} {...outOfScope} />);
    expect(row(container).style.opacity).toBe("0.35");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("the kebab, while a selection is live", () => {
  it("stands down, so a per-chat action cannot be fired inside a bulk gesture", () => {
    const { container } = renderSelectable({ selectionMode: true });
    fireEvent.mouseEnter(row(container));

    expect(screen.queryByTitle("Chat actions")).toBeNull();
    // The checkbox is what the cluster holds instead.
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("takes an already-open menu down with it", () => {
    const { container, rerender } = renderSelectable();
    fireEvent.mouseEnter(row(container));
    fireEvent.click(screen.getByTitle("Chat actions"));
    expect(screen.getByText("Delete")).toBeTruthy();

    rerender(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} onToggleSelect={vi.fn()} selectionMode />);

    // `menuOpen` is the row's own state and outlives the button that set it;
    // left up, the popup would float over the selection — and come back when
    // the selection ended, anchored to a rect from minutes earlier.
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("comes back when the selection ends", () => {
    const { container, rerender } = renderSelectable({ selectionMode: true });
    fireEvent.mouseEnter(row(container));

    rerender(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} onToggleSelect={vi.fn()} />);
    expect(screen.getByTitle("Chat actions")).toBeTruthy();
  });
});

describe("the row's own gesture", () => {
  it("enters selection on a long press, without opening the chat", () => {
    vi.useFakeTimers();
    try {
      const onClick = vi.fn();
      const onLongPress = vi.fn();
      const { container } = render(
        <ChatListItem chat={makeChat()} onClick={onClick} onDelete={noop} onToggleSelect={vi.fn()} onLongPress={onLongPress} />,
      );

      fireEvent.pointerDown(row(container), { pointerType: "touch", clientX: 10, clientY: 20 });
      vi.advanceTimersByTime(500);

      expect(onLongPress).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();

      // And the click the browser emits afterwards does not also navigate —
      // the suppression the shared hook owns, wired through this row's
      // handlers rather than around them.
      fireEvent.click(row(container));
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the browser's own context menu alone when the list offers no selection", () => {
    const { container } = render(<ChatListItem chat={makeChat()} onClick={noop} onDelete={noop} />);
    // Not defaultPrevented: taking the native menu away and putting nothing in
    // its place is a pure loss.
    expect(fireEvent.contextMenu(row(container))).toBe(true);
  });

  it("routes a modified click to the list rather than opening the chat", () => {
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    const { container } = render(<ChatListItem chat={makeChat()} onClick={onClick} onDelete={noop} onToggleSelect={onToggleSelect} />);

    fireEvent.click(row(container), { metaKey: true });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("still opens the chat on a plain click", () => {
    const onClick = vi.fn();
    const { container } = render(<ChatListItem chat={makeChat()} onClick={onClick} onDelete={noop} onToggleSelect={vi.fn()} />);

    fireEvent.click(row(container));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
