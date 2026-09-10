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
   * The rail is ONE outlined box with three icons in it, not three buttons in a
   * row: outer corners rounded, inner corners square, and both sides of every
   * seam suppressed, so there are no internal dividers at all. Measured in
   * Chromium across all seven meaningful on/off combinations — rail 84x28,
   * every button box 28x28, inter-button gaps [0, 0].
   *
   * Worth pinning because the failure mode is a tidy-up that gives all three
   * buttons the same style object. That reads as an improvement in a diff and
   * turns the group back into the loose row of icons that got these controls
   * moved into the modal in the first place — three separately outlined buttons
   * with doubled 2px seams, which is not a rail.
   *
   * The corners are the easy half. The seams are assertable only because of the
   * SPELLING, which is why the component says `borderRightWidth: 0` rather than
   * the more obvious `border-right: none`. jsdom's CSS parser silently drops
   * `border: none`, `border-right: none` AND `border-right-style: none` — set
   * any of them and the declaration is simply not in the element's `cssText`,
   * so an assertion about it would be testing the parser. `border-right-width:
   * 0px` is the one spelling jsdom RETAINS, and in Chromium the two compute
   * identically (1px/0px/1px/1px), so nothing about the rendering changes.
   *
   * A future reader tidying it back to `border-right: none` would lose the test
   * below without turning anything red, which is exactly the state this replaced:
   * before it, deleting the seam-suppression line outright left all four tests
   * in this block passing.
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

  /**
   * The other half of the same claim, and the one the corners cannot stand in
   * for: with the radii correct but the seams left in, the rail is three
   * outlined boxes sharing straight edges rather than one box.
   *
   * Read off `borderLeftWidth`/`borderRightWidth` because that is the spelling
   * the component uses and the only one jsdom keeps — see the note above. The
   * outer edges assert the empty string on purpose: the `border` shorthand
   * carries a `var()`, so jsdom cannot expand it into longhands, and an unset
   * longhand is therefore proof that side was never suppressed. That is what
   * stops the test passing on a component that dropped every border.
   */
  it("suppresses both sides of every seam, so the rail is one box and not three", () => {
    const { button } = renderBar();
    const [first, middle, last] = TOGGLES.map((t) => button(t.name).style);
    const SUPPRESSED = "0px";
    const DRAWN = "";

    // Left edge of the rail is drawn; its right seam is not.
    expect([first.borderLeftWidth, first.borderRightWidth]).toEqual([DRAWN, SUPPRESSED]);
    // The middle button contributes no edge of its own in either direction.
    expect([middle.borderLeftWidth, middle.borderRightWidth]).toEqual([SUPPRESSED, SUPPRESSED]);
    // Right edge of the rail is drawn; its left seam is not.
    expect([last.borderLeftWidth, last.borderRightWidth]).toEqual([SUPPRESSED, DRAWN]);

    // And the outline itself is still there — otherwise "one box" would be
    // satisfied by a rail with no box at all.
    for (const s of [first, middle, last]) expect(s.border).toContain("var(--chatlist-item-border)");
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
   *
   * Asserted on the `--chatlist-*` tokens rather than on `--text`/`--border`,
   * because "exactly as the header does" is the claim and those are the tokens
   * SidebarHeader uses. They alias to the generic ones in both built-in themes,
   * so this is not a visual difference today — it is a difference that only
   * shows up under a custom theme, which is the case where the two rails must
   * still agree.
   */
  it("lights an active toggle the way the header lights an active nav button", () => {
    const { button } = renderBar({ viewOptions: { showTriggered: true } });
    const on = button("Triggered").style;
    const off = button("Archived").style;

    expect(on.background).toBe("var(--accent)");
    expect(on.color).toBe("var(--chatlist-icon-nav-active)");
    expect(off.background).toBe("var(--bg-secondary)");
    expect(off.color).toBe("var(--chatlist-icon-nav)");
    // Stated as a difference rather than as `border: none`, which jsdom drops.
    expect(off.border).toContain("var(--chatlist-item-border)");
    expect(on.border).not.toContain("var(--chatlist-item-border)");
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
