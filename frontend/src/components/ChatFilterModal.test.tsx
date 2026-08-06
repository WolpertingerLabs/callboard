// @vitest-environment jsdom
/**
 * The filters modal is the single home for the sidebar's scope + layout
 * options, so what's under test is the staging contract: edits are held
 * locally, committed as one Apply, and discarded by Cancel.
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
  it("renders every scope and layout option", () => {
    renderModal();
    for (const label of ["Cards only", "Bookmarked only", "Show triggered chats", "Tree layout"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("stages a toggle and commits it on Apply", () => {
    const { onApply, onClose } = renderModal();

    fireEvent.click(screen.getByText("Cards only"));
    // Still staged — nothing committed until Apply.
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardsOnly: true });
    expect(onClose).toHaveBeenCalled();
  });

  it("discards staged toggles on Cancel", () => {
    const { onApply, onClose } = renderModal();

    fireEvent.click(screen.getByText("Tree layout"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("seeds the switches from the live values", () => {
    const { onApply } = renderModal({ cardsOnly: true, treeLayout: true });

    // Applying without touching anything hands back exactly what came in.
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, cardsOnly: true, treeLayout: true });
  });

  it("Reset All clears the view options too, not just the field filters", () => {
    const { onApply } = renderModal({ cardsOnly: true, showTriggered: true, bookmarked: true, treeLayout: true });

    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][0]).toEqual(DEFAULT_CHAT_FILTERS);
    expect(onApply.mock.calls[0][1]).toEqual(DEFAULT_CHAT_VIEW_OPTIONS);
  });
});
