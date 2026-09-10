// @vitest-environment jsdom
/**
 * The filter bar's "Archived" toggle.
 *
 * It is the one control in the sidebar's filter state that does NOT go through
 * the modal's stage-then-Apply contract — it commits on the click. That
 * difference is the reason it was promoted out of the modal, and it is what
 * this file pins: a reader who sees `onApply` called with no Apply button in
 * sight should find the behaviour asserted rather than have to guess it is a
 * bug.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChatFilterBar from "./ChatFilterBar";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, type ChatFilters, type ChatViewOptions } from "../types/chatFilters";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBar(overrides: { viewOptions?: Partial<ChatViewOptions>; filters?: ChatFilters } = {}) {
  const onApply = vi.fn();
  render(
    <ChatFilterBar
      filters={overrides.filters ?? DEFAULT_CHAT_FILTERS}
      viewOptions={{ ...DEFAULT_CHAT_VIEW_OPTIONS, ...overrides.viewOptions }}
      onApply={onApply}
      searchQuery=""
      onSearchChange={() => {}}
      onSearchSubmit={() => {}}
      isSearching={false}
    />,
  );
  // Found the way a screen reader would find it, which after the label was
  // dropped is the only way it can be found at all.
  return { onApply, button: screen.getByRole("button", { name: "Archived" }) };
}

describe("the Archived toggle", () => {
  /**
   * Icon-only, deliberately — see the docblock in ChatFilterBar for which half
   * of the old rail objection that answers and which it accepts.
   *
   * What must not go with the text is the accessible NAME. A button whose whole
   * content is an `<svg>` has none, and a nameless button is worse for a screen
   * reader than the label was ever worth to a sighted user, so the name moves
   * to `aria-label`. Asserted from both ends: there is no text to fall back on,
   * and the button is still addressable by name.
   */
  it("has no text label, and an accessible name that does not depend on one", () => {
    const { button } = renderBar();
    expect(button.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Archived" })).toBe(button);
  });

  /**
   * The name says what the control IS; `aria-pressed` says which way it is
   * SET. Folding the state into the name would announce a differently-named
   * control on each toggle, so the name has to be identical in both states.
   */
  it("keeps the state out of the name", () => {
    const off = renderBar().button.getAttribute("aria-label");
    cleanup();
    const on = renderBar({ viewOptions: { showArchived: true } }).button.getAttribute("aria-label");
    expect(off).toBe("Archived");
    expect(on).toBe(off);
  });

  /**
   * Two icon buttons now sit side by side, which is a rail of two whether or
   * not it is called one. The least it can do is look like one deliberate
   * pair rather than two near-misses, so the toggle keeps the filters button's
   * box and glyph size.
   */
  it("matches the filters button's footprint, so the two read as siblings", () => {
    const { button } = renderBar();
    const filtersButton = screen.getByTitle("Filters and view");

    expect(button.style.padding).toBe(filtersButton.style.padding);
    expect(button.style.borderRadius).toBe(filtersButton.style.borderRadius);
    expect(button.querySelector("svg")?.getAttribute("width")).toBe(filtersButton.querySelector("svg")?.getAttribute("width"));
  });

  it("reports its state through aria-pressed", () => {
    expect(renderBar().button.getAttribute("aria-pressed")).toBe("false");
    cleanup();
    expect(renderBar({ viewOptions: { showArchived: true } }).button.getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * It replaced a switch, whose position answered "which way is this set?"
   * without being clicked. The title has to answer the same question, so it
   * names the current state and not just the action.
   */
  it("says in its title where the scope currently is", () => {
    expect(renderBar().button.getAttribute("title")).toMatch(/hidden/);
    cleanup();
    expect(renderBar({ viewOptions: { showArchived: true } }).button.getAttribute("title")).toMatch(/^Showing/);
  });

  /** The behavioural difference from every control in the modal. */
  it("commits on one click, with no Apply", () => {
    const { onApply, button } = renderBar();

    fireEvent.click(button);

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true });
    // There is no Apply button in the bar to have gone through.
    expect(screen.queryByText("Apply")).toBeNull();
  });

  it("commits the other direction too", () => {
    const { onApply, button } = renderBar({ viewOptions: { showArchived: true } });

    fireEvent.click(button);

    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: false });
  });

  /**
   * It only ever touches its own key. The filters half goes back unchanged and
   * the sibling view options with it, so clicking this cannot quietly reset an
   * edit made in the modal.
   */
  it("hands back the other filter state untouched", () => {
    const filters: ChatFilters = { ...DEFAULT_CHAT_FILTERS, directoryInclude: { value: "callboard", active: true } };
    const { onApply, button } = renderBar({ filters, viewOptions: { bookmarked: true, showTriggered: true } });

    fireEvent.click(button);

    expect(onApply.mock.calls[0][0]).toBe(filters);
    expect(onApply.mock.calls[0][1]).toEqual({ bookmarked: true, showTriggered: true, showArchived: true });
  });
});

describe("the filters button badge", () => {
  /**
   * The badge means "there are edits inside the modal". `showArchived` is not
   * inside it any more, so counting it would put a "1 active" badge on a modal
   * that shows nothing changed — pointing at a control that is lit up on the
   * button next to it.
   */
  it("does not count the Archived toggle", () => {
    renderBar({ viewOptions: { showArchived: true } });
    expect(screen.getByTitle("Filters and view")).toBeTruthy();
    expect(screen.queryByTitle(/1 active/)).toBeNull();
  });

  it("still counts the options that are inside the modal", () => {
    renderBar({ viewOptions: { showArchived: true, bookmarked: true } });
    expect(screen.getByTitle("Filters and view (1 active)")).toBeTruthy();
  });
});
