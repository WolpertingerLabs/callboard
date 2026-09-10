// @vitest-environment jsdom
/**
 * The filters modal is the home for the sidebar's scope options bar one
 * ("Show archived" is a toggle button in the filter bar — see
 * ChatFilterBar.test.tsx), so what's under test is the staging contract: edits
 * are held locally, committed as one Apply, and discarded by Cancel.
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
  it("renders every scope option it still owns", () => {
    renderModal();
    for (const label of ["Bookmarked only", "Show triggered chats"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  /**
   * Moved, not duplicated. "Show archived" is the "Archived" toggle button in
   * the filter bar now, committed on the click; a second copy in here — where
   * edits wait for Apply — would be two controls for one boolean with
   * different commit semantics, which is exactly how they drift.
   */
  it("no longer offers a Show archived switch", () => {
    renderModal();
    expect(screen.queryByText("Show archived")).toBeNull();
    expect(screen.queryByText(/archived/i)).toBeNull();
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

  /**
   * The three controls the "Archived" toggle replaced. They are gone as
   * controls, not merely as fields: the archived rows are told apart by the dim
   * alone now, so a segmented All/Open/Archived scope or an "Open chats first"
   * split coming back would be a second, contradicting answer to the same
   * question — and the answer no longer lives in this modal at all.
   */
  it("no longer offers the lifecycle scope or the open-first split", () => {
    renderModal();
    expect(screen.queryByText("Card lifecycle")).toBeNull();
    expect(screen.queryByText("Open chats first")).toBeNull();
    for (const label of ["All", "Open", "Archived"]) expect(screen.queryByText(label)).toBeNull();
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

  it("discards staged toggles on Cancel", () => {
    const { onApply, onClose } = renderModal();

    fireEvent.click(screen.getByText("Bookmarked only"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("seeds the switches from the live values", () => {
    const { onApply } = renderModal({ showArchived: true, bookmarked: true });

    // Applying without touching anything hands back exactly what came in —
    // including `showArchived`, which this modal no longer edits but still has
    // to carry through untouched rather than resetting to its default.
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true, bookmarked: true });
  });

  it("Reset All clears the view options too, not just the field filters", () => {
    const { onApply } = renderModal({ showTriggered: true, bookmarked: true });

    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][0]).toEqual(DEFAULT_CHAT_FILTERS);
    expect(onApply.mock.calls[0][1]).toEqual(DEFAULT_CHAT_VIEW_OPTIONS);
  });

  /**
   * Reset All resets what this modal shows. `showArchived` is not in it, so
   * resetting from here would silently switch off a lit toggle button in the
   * bar behind the dialog — an invisible control undoing a visible one.
   */
  it("Reset All leaves Show archived alone, since it is not a control in here", () => {
    const { onApply } = renderModal({ showArchived: true, showTriggered: true });

    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true });
  });
});
