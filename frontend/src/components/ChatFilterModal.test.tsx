// @vitest-environment jsdom
/**
 * The filters modal is the single home for the sidebar's scope options, so
 * what's under test is the staging contract: edits are held locally, committed
 * as one Apply, and discarded by Cancel.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChatFilterModal from "./ChatFilterModal";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, type ChatViewOptions } from "../types/chatFilters";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(viewOptions: Partial<ChatViewOptions> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(<ChatFilterModal onClose={onClose} filters={DEFAULT_CHAT_FILTERS} viewOptions={{ ...DEFAULT_CHAT_VIEW_OPTIONS, ...viewOptions }} onApply={onApply} />);
  return { onApply, onClose };
}

describe("ChatFilterModal view options", () => {
  it("renders every scope option", () => {
    renderModal();
    for (const label of ["Card lifecycle", "Open chats first", "Bookmarked only", "Show triggered chats"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  /**
   * The dim is unconditional now: chats on an archived card (or on no card at
   * all) always fade. The switch that used to gate it must not come back as a
   * control the user can leave off and then wonder why rows are faded.
   */
  it("no longer offers a dim switch", () => {
    renderModal();
    expect(screen.queryByText("Dim inactive chats")).toBeNull();
    expect(screen.queryByText(/Dim/)).toBeNull();
  });

  /**
   * The tree layout is no longer a choice — the sidebar always groups chats by
   * parentage — so the switch that used to turn it on must not come back as a
   * dead control the user can toggle to no effect.
   */
  it("no longer offers a layout switch", () => {
    renderModal();
    expect(screen.queryByText("Tree layout")).toBeNull();
  });

  it("stages a toggle and commits it on Apply", () => {
    const { onApply, onClose } = renderModal();

    fireEvent.click(screen.getByText("Bookmarked only"));
    // Still staged — nothing committed until Apply.
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, bookmarked: true });
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * The gap this filter closes: before it, the sidebar could only ask for OPEN
   * cards ("Cards only"), and with 804 of 805 cards closed on a real data dir
   * that collapsed 8,319 chats to 1 with no way to ask for the other side. So
   * the assertion that matters is that "Archived" is reachable at all.
   *
   * The label is "Archived"; the value it stages stays `inactive`, because that
   * is what goes out as `GET /api/chats?cardLifecycle=`.
   */
  it("stages each of the three lifecycle scopes", () => {
    const { onApply } = renderModal();

    for (const label of ["All", "Open", "Archived"]) expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardLifecycle: "inactive" });
  });

  it("keeps the deprecated cardsOnly alias in lock-step with the scope", () => {
    // Written so a downgrade to a bundle that only knows the boolean lands on
    // the same scope instead of silently widening the sidebar to everything.
    const { onApply } = renderModal();

    fireEvent.click(screen.getByText("Open"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toMatchObject({ cardLifecycle: "active", cardsOnly: true });

    cleanup();
    const second = renderModal({ cardLifecycle: "active", cardsOnly: true });
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByText("Apply"));
    expect(second.onApply.mock.calls[0][1]).toMatchObject({ cardLifecycle: "inactive", cardsOnly: false });
  });

  it("discards staged toggles on Cancel", () => {
    const { onApply, onClose } = renderModal();

    fireEvent.click(screen.getByText("Bookmarked only"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("seeds the switches from the live values", () => {
    const { onApply } = renderModal({ cardLifecycle: "inactive", bookmarked: true });

    // Applying without touching anything hands back exactly what came in.
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardLifecycle: "inactive", bookmarked: true });
  });

  /**
   * A scoped list is entirely on one side of the split, so there is no second
   * bucket for "Open chats first" to make a header over. A switch that silently
   * does nothing reads as a bug, so it goes inert and says why — in the new
   * vocabulary, not the `active`/`inactive` value behind it.
   */
  it.each([
    ["active", "open"],
    ["inactive", "archived"],
  ] as const)("makes the open-first switch inert while the scope is %s, and says why", (cardLifecycle, scopeWord) => {
    const { onApply } = renderModal({ cardLifecycle });

    const sortSwitch = screen.getByText("Open chats first").closest("button")!;
    expect(sortSwitch.disabled).toBe(true);
    // The reason, and the scope word in the new vocabulary — not the whole
    // sentence, which is copy and free to be reworded.
    expect(screen.getByText(/Nothing to split/).textContent).toContain(scopeWord);

    fireEvent.click(sortSwitch);
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toMatchObject({ cardLifecycle, sortByCardActive: false });
  });

  it("round-trips the open-first switch through Apply", () => {
    const { onApply } = renderModal();

    const sortSwitch = screen.getByText("Open chats first").closest("button")!;
    expect(sortSwitch.disabled).toBe(false);

    fireEvent.click(sortSwitch);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, sortByCardActive: true });
  });

  it("Reset All clears the view options too, not just the field filters", () => {
    const { onApply } = renderModal({ cardLifecycle: "inactive", showTriggered: true, bookmarked: true, sortByCardActive: true });

    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][0]).toEqual(DEFAULT_CHAT_FILTERS);
    expect(onApply.mock.calls[0][1]).toEqual(DEFAULT_CHAT_VIEW_OPTIONS);
  });
});
