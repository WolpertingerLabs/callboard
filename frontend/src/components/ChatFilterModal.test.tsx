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
    for (const label of ["Card lifecycle", "Dim inactive chats", "Active cards first", "Bookmarked only", "Show triggered chats"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
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
   * the assertion that matters is that "Inactive" is reachable at all.
   */
  it("stages each of the three lifecycle scopes", () => {
    const { onApply } = renderModal();

    fireEvent.click(screen.getByText("Inactive"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardLifecycle: "inactive" });
  });

  it("keeps the deprecated cardsOnly alias in lock-step with the scope", () => {
    // Written so a downgrade to a bundle that only knows the boolean lands on
    // the same scope instead of silently widening the sidebar to everything.
    const { onApply } = renderModal();

    fireEvent.click(screen.getByText("Active"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toMatchObject({ cardLifecycle: "active", cardsOnly: true });

    cleanup();
    const second = renderModal({ cardLifecycle: "active", cardsOnly: true });
    fireEvent.click(screen.getByText("Inactive"));
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
   * Either non-default scope already narrows the list to one side of the
   * split, so there is nothing left for "Dim inactive chats" to fade. A switch
   * that silently does nothing reads as a bug, so it goes inert and says why.
   */
  it.each(["active", "inactive"] as const)("makes the dim switch inert while the scope is %s, and says why", (cardLifecycle) => {
    const { onApply } = renderModal({ cardLifecycle });

    const dimSwitch = screen.getByText("Dim inactive chats").closest("button")!;
    expect(dimSwitch.disabled).toBe(true);
    expect(screen.getByText(/Nothing to dim/)).toBeTruthy();

    fireEvent.click(dimSwitch);
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toMatchObject({ cardLifecycle, dimCardless: false });
  });

  it("leaves the dim switch live while the scope is All", () => {
    const { onApply } = renderModal();

    const dimSwitch = screen.getByText("Dim inactive chats").closest("button")!;
    expect(dimSwitch.disabled).toBe(false);

    fireEvent.click(dimSwitch);
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, dimCardless: true });
  });

  /**
   * Same reasoning as the dim switch, and the reason the two sit next to each
   * other: a scoped list is entirely on one side of the split, so there is no
   * second bucket for "Active cards first" to make a header over.
   */
  it("makes the active-first switch inert while the scope is not All, and says why", () => {
    const { onApply } = renderModal({ cardLifecycle: "active", cardsOnly: true });

    const sortSwitch = screen.getByText("Active cards first").closest("button")!;
    expect(sortSwitch.disabled).toBe(true);
    expect(screen.getByText(/Nothing to split/)).toBeTruthy();

    fireEvent.click(sortSwitch);
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toMatchObject({ cardLifecycle: "active", sortByCardActive: false });
  });

  it("round-trips the active-first switch through Apply", () => {
    const { onApply } = renderModal();

    const sortSwitch = screen.getByText("Active cards first").closest("button")!;
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
