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
    for (const label of ["Show archived", "Bookmarked only", "Show triggered chats"]) {
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

  /**
   * The three controls "Show archived" replaced. They are gone as controls, not
   * merely as fields: the archived rows are told apart by the dim alone now, so
   * a segmented All/Open/Archived scope or an "Open chats first" split coming
   * back would be a second, contradicting answer to the same question.
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

  /**
   * The gap this toggle closes: the sidebar hides chats on an archived card by
   * default, and with 804 of 805 cards closed on a real data dir that is most
   * of them. So the assertion that matters is that they are reachable at all,
   * from one switch, in one click.
   */
  it("stages Show archived and commits it on Apply", () => {
    const { onApply } = renderModal();

    fireEvent.click(screen.getByText("Show archived"));
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true });
  });

  it("switches Show archived back off again", () => {
    const { onApply } = renderModal({ showArchived: true });

    fireEvent.click(screen.getByText("Show archived"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: false });
  });

  it("says what each position of Show archived does", () => {
    // The hint is the only place the dim is explained, now that it is not a
    // switch of its own — on, it warns the extra rows arrive faded and in
    // place rather than collected at the bottom; off, it has to say "browse",
    // because a content search widens past this switch and the user would
    // otherwise be promised something the sidebar behind the modal contradicts.
    renderModal();
    expect(screen.getByText(/Browse open cards only/)).toBeTruthy();
    expect(screen.getByText(/search still finds everything/)).toBeTruthy();

    fireEvent.click(screen.getByText("Show archived"));
    expect(screen.getByText(/dimmed and in place/)).toBeTruthy();
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

    // Applying without touching anything hands back exactly what came in.
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true, bookmarked: true });
  });

  it("Reset All clears the view options too, not just the field filters", () => {
    const { onApply } = renderModal({ showArchived: true, showTriggered: true, bookmarked: true });

    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][0]).toEqual(DEFAULT_CHAT_FILTERS);
    expect(onApply.mock.calls[0][1]).toEqual(DEFAULT_CHAT_VIEW_OPTIONS);
  });
});
