// @vitest-environment jsdom
/**
 * The filter bar's scope toggles — Bookmarked, Triggered, Archived.
 *
 * They are the controls in the sidebar's filter state that do NOT go through
 * the modal's stage-then-Apply contract: each commits on the click. That
 * difference is the reason all three were promoted out of the modal, and it is
 * what this file pins — a reader who sees `onApply` called with no Apply button
 * in sight should find the behaviour asserted rather than have to guess it is a
 * bug.
 *
 * The other half is the grouping. Three adjacent icon buttons are a rail
 * whether or not anyone calls them one, and the thing that stops them reading
 * as three loose icons is the segmented border treatment. That is a visual
 * property, so it is asserted structurally here and looked at in a browser; the
 * point of pinning it at all is that "make them all look the same" is the
 * obvious tidy-up that would undo it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChatFilterBar from "./ChatFilterBar";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, type ChatFilters, type ChatViewOptions } from "../types/chatFilters";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Name in the bar → the `ChatViewOptions` key it sets, in rail order. */
const TOGGLES: { name: string; key: keyof ChatViewOptions }[] = [
  { name: "Bookmarked", key: "bookmarked" },
  { name: "Triggered", key: "showTriggered" },
  { name: "Archived", key: "showArchived" },
];

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
  // Found the way a screen reader would find them, which with no text labels is
  // the only way they can be found at all.
  const button = (name: string) => screen.getByRole("button", { name });
  return { onApply, button };
}

describe("the scope toggles", () => {
  /**
   * Icon-only, deliberately — see the docblock in ChatFilterBar for which half
   * of the old rail objection that answers and which it accepts.
   *
   * What must not go with the text is the accessible NAME. A button whose whole
   * content is an `<svg>` has none, and a nameless button is worse for a screen
   * reader than the labels were ever worth to a sighted user, so the name moves
   * to `aria-label`. Asserted from both ends: there is no text to fall back on,
   * and each button is still addressable by name.
   */
  it.each(TOGGLES)("$name has no text label, and a name that does not depend on one", ({ name }) => {
    const { button } = renderBar();
    expect(button(name).textContent).toBe("");
    expect(screen.getByRole("button", { name })).toBe(button(name));
  });

  /**
   * The name says what the control IS; `aria-pressed` says which way it is
   * SET. Folding the state into the name would announce a differently-named
   * control on each toggle, so the name has to be identical in both states.
   */
  it.each(TOGGLES)("$name keeps its state out of its name", ({ name, key }) => {
    const off = renderBar().button(name).getAttribute("aria-label");
    cleanup();
    const on = renderBar({ viewOptions: { [key]: true } }).button(name).getAttribute("aria-label");
    expect(off).toBe(name);
    expect(on).toBe(off);
  });

  it.each(TOGGLES)("$name reports its state through aria-pressed", ({ name, key }) => {
    expect(renderBar().button(name).getAttribute("aria-pressed")).toBe("false");
    cleanup();
    expect(renderBar({ viewOptions: { [key]: true } }).button(name).getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * These replaced switches, whose position answered "which way is this set?"
   * without being clicked. The titles have to answer the same question, so each
   * names the current state and not just the action — and differs between the
   * two states, which is what a title describing only the action would not do.
   */
  it.each(TOGGLES)("$name says in its title where the scope currently is", ({ name, key }) => {
    const off = renderBar().button(name).getAttribute("title")!;
    cleanup();
    const on = renderBar({ viewOptions: { [key]: true } }).button(name).getAttribute("title")!;
    expect(on).toMatch(/^Showing/);
    expect(off).not.toBe(on);
    // And each says what the click will do, since the icon does not.
    expect(on).toMatch(/click to/);
    expect(off).toMatch(/click to/);
  });

  /** The behavioural difference from every control in the modal. */
  it.each(TOGGLES)("$name commits on one click, with no Apply", ({ name, key }) => {
    const { onApply, button } = renderBar();

    fireEvent.click(button(name));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, [key]: true });
    // There is no Apply button in the bar to have gone through.
    expect(screen.queryByText("Apply")).toBeNull();
  });

  it.each(TOGGLES)("$name commits the other direction too", ({ name, key }) => {
    const { onApply, button } = renderBar({ viewOptions: { [key]: true } });

    fireEvent.click(button(name));

    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, [key]: false });
  });

  /**
   * Each only ever touches its own key. The filters half goes back unchanged
   * and the sibling scopes with it, so clicking one cannot quietly reset an
   * edit made in the modal or flip the toggle next to it.
   */
  it.each(TOGGLES)("$name hands back the other filter state untouched", ({ name, key }) => {
    const filters: ChatFilters = { ...DEFAULT_CHAT_FILTERS, directoryInclude: { value: "callboard", active: true } };
    const others = TOGGLES.filter((t) => t.key !== key);
    const { onApply, button } = renderBar({ filters, viewOptions: Object.fromEntries(others.map((t) => [t.key, true])) });

    fireEvent.click(button(name));

    expect(onApply.mock.calls[0][0]).toBe(filters);
    expect(onApply.mock.calls[0][1]).toEqual({ ...Object.fromEntries(others.map((t) => [t.key, true])), [key]: true });
  });
});

describe("the toggles as one segmented group", () => {
  /**
   * Same box as the header's nav buttons, and as the filters button beside
   * them, because the two rows are meant to read as one stack rather than as
   * two bars that nearly line up. Sized rather than padded — see
   * headerButtonStyle for why the border differences make padding wrong.
   */
  it("gives every button the header-button footprint, filters button included", () => {
    const { button } = renderBar();
    const boxes = [screen.getByTitle("Filters"), ...TOGGLES.map((t) => button(t.name))];

    for (const box of boxes) {
      expect(box.style.width).toBe("28px");
      expect(box.style.height).toBe("28px");
      expect(box.style.padding).toBe("0px");
      expect(box.style.boxSizing).toBe("border-box");
      expect(box.querySelector("svg")?.getAttribute("width")).toBe("16");
    }
  });

  /**
   * The rail is one object with three cells, not three buttons in a row: outer
   * corners rounded, inner corners square, and the border each pair shares
   * suppressed so it is not drawn twice at 2px.
   *
   * The corners are what this can assert. The suppressed borders it cannot:
   * jsdom's CSS parser drops `border-right: none` (and `border: none`) on the
   * floor entirely — set either and the declaration simply is not in the
   * element's `cssText` — so an assertion about them would be testing the
   * parser, not the component. Those are checked in the browser instead, at
   * both sidebar widths.
   *
   * Worth pinning even half-covered, because the failure mode is a tidy-up that
   * gives all three buttons the same style object. That reads as an improvement
   * in a diff and turns the group back into the loose row of icons that got
   * these controls moved into the modal in the first place.
   */
  it("rounds only the outer corners, so the three read as one unit", () => {
    const { button } = renderBar();
    const [first, middle, last] = TOGGLES.map((t) => button(t.name).style);
    // jsdom serializes a zero radius unitless and a non-zero one with px.
    const ROUNDED = "6px";
    const SQUARE = "0";

    expect([first.borderTopLeftRadius, first.borderBottomLeftRadius]).toEqual([ROUNDED, ROUNDED]);
    expect([first.borderTopRightRadius, first.borderBottomRightRadius]).toEqual([SQUARE, SQUARE]);

    expect([middle.borderTopLeftRadius, middle.borderBottomLeftRadius]).toEqual([SQUARE, SQUARE]);
    expect([middle.borderTopRightRadius, middle.borderBottomRightRadius]).toEqual([SQUARE, SQUARE]);

    expect([last.borderTopLeftRadius, last.borderBottomLeftRadius]).toEqual([SQUARE, SQUARE]);
    expect([last.borderTopRightRadius, last.borderBottomRightRadius]).toEqual([ROUNDED, ROUNDED]);
  });

  /** They are adjacent in the DOM too — a gap between them is not a group. */
  it("puts the three in one container, with nothing between them", () => {
    const { button } = renderBar();
    const rail = button("Bookmarked").parentElement!;

    expect(Array.from(rail.children)).toEqual(TOGGLES.map((t) => button(t.name)));
    // The filters button is NOT in it: it opens a dialog rather than setting a
    // scope, and a segmented group claims its members answer one question.
    expect(rail.contains(screen.getByTitle("Filters"))).toBe(false);
  });

  /**
   * An active toggle drops its border and takes the accent, exactly as the
   * header's active nav button does. Both halves matter: the accent is the
   * "on" signal, and dropping the border is what stops the control moving by a
   * pixel as it lights up.
   */
  it("lights an active toggle the way the header lights an active nav button", () => {
    const { button } = renderBar({ viewOptions: { showTriggered: true } });
    const on = button("Triggered").style;
    const off = button("Archived").style;

    expect(on.background).toBe("var(--accent)");
    expect(on.color).toBe("var(--text-on-accent)");
    expect(off.background).toBe("var(--bg-secondary)");
    expect(off.color).toBe("var(--text)");
    // Stated as a difference rather than as `border: none`, which jsdom drops.
    expect(off.border).toContain("var(--border)");
    expect(on.border).not.toContain("var(--border)");
  });
});

describe("the filters button badge", () => {
  /**
   * The badge means "there are edits inside the modal", and no view option is
   * inside it any more — all three are lit or unlit on the rail next to the
   * badge. Counting one would put "1 active" on a modal that shows nothing
   * changed, sending the user looking for an edit that isn't there.
   */
  it("counts no view option, whichever of them is on", () => {
    renderBar({ viewOptions: { showArchived: true, bookmarked: true, showTriggered: true } });
    expect(screen.getByTitle("Filters")).toBeTruthy();
    expect(screen.queryByTitle(/active/)).toBeNull();
  });

  it("counts the field filters, which are what the modal still holds", () => {
    renderBar({
      viewOptions: { showArchived: true },
      filters: { ...DEFAULT_CHAT_FILTERS, directoryInclude: { value: "callboard", active: true } },
    });
    expect(screen.getByTitle("Filters (1 active)")).toBeTruthy();
  });
});
