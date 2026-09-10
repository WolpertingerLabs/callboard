// @vitest-environment jsdom
/**
 * The filters modal holds the four field filters and nothing else — every scope
 * option is a toggle button in the filter bar now (see ChatFilterBar.test.tsx).
 * So what is under test is the staging contract for those four (edits held
 * locally, committed as one Apply, discarded by Cancel), and the other half of
 * the split: this dialog carries `viewOptions` from prop to `onApply` untouched
 * and must never write one.
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
  const { rerender } = render(
    <ChatFilterModal onClose={onClose} filters={DEFAULT_CHAT_FILTERS} viewOptions={{ ...DEFAULT_CHAT_VIEW_OPTIONS, ...viewOptions }} onApply={onApply} />,
  );
  /**
   * Change `viewOptions` underneath the open modal — what happens when the
   * filter bar commits while this dialog is up. The two are siblings, so the
   * modal stays mounted through it.
   */
  const commitFromTheBar = (next: Partial<ChatViewOptions>) =>
    rerender(
      <ChatFilterModal
        onClose={onClose}
        filters={DEFAULT_CHAT_FILTERS}
        viewOptions={{ ...DEFAULT_CHAT_VIEW_OPTIONS, ...viewOptions, ...next }}
        onApply={onApply}
      />,
    );
  const setRegex = (value: string) => {
    const input = screen.getByPlaceholderText("e.g. my-project|other-repo");
    fireEvent.change(input, { target: { value } });
    fireEvent.click(input.parentElement!.querySelector("button")!);
  };
  return { onApply, onClose, commitFromTheBar, setRegex };
}

describe("ChatFilterModal", () => {
  it("renders the four field filters it owns", () => {
    renderModal();
    for (const label of ["Directory Include (regex)", "Directory Exclude (regex)", "Updated After", "Updated Before"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  /**
   * Moved, not duplicated. All three scopes are toggle buttons in the filter
   * bar now, committed on the click; a second copy in here — where edits wait
   * for Apply — would be two controls for one boolean with different commit
   * semantics, which is exactly how they drift.
   */
  it("no longer offers any of the scope switches", () => {
    renderModal();
    for (const gone of [/archived/i, /bookmark/i, /triggered/i]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    // Nor the section they lived in.
    expect(screen.queryByText("View")).toBeNull();
  });

  /**
   * The dim is unconditional now: chats on an archived card always fade. The
   * switch that used to gate it must not come back as a control the user can
   * leave off and then wonder why rows are faded.
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

  it("stages an edit and commits it on Apply", () => {
    const { onApply, onClose, setRegex } = renderModal();

    setRegex("callboard");
    // Still staged — nothing committed until Apply.
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ ...DEFAULT_CHAT_FILTERS, directoryInclude: { value: "callboard", active: true } });
    expect(onClose).toHaveBeenCalled();
  });

  it("discards staged edits on Cancel", () => {
    const { onApply, onClose, setRegex } = renderModal();

    setRegex("callboard");
    fireEvent.click(screen.getByText("Cancel"));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Reset All clears the field filters", () => {
    const { onApply, setRegex } = renderModal();

    setRegex("callboard");
    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][0]).toEqual(DEFAULT_CHAT_FILTERS);
  });
});

/**
 * The scopes are not this dialog's to write, and the way that is enforced is
 * that there is no staged copy of them at all — `viewOptions` goes from prop
 * straight back to `onApply`.
 *
 * It used to be a `localView` snapshot seeded at mount and never re-synced,
 * which made the modal capable of reverting a change the user had watched take
 * effect: the bar and the modal are siblings, and the overlay stops the mouse
 * but not the keyboard, so one Tab out of the filters button reaches a scope
 * toggle and Space commits it. jsdom does not model real tab order, so no test
 * can reproduce that route; what is pinned instead is narrower and stronger —
 * this modal must never write a value it does not show, however the value came
 * to change.
 */
describe("a scope committed from the bar while the modal is open", () => {
  it("survives Apply, rather than being reverted to the mount-time value", () => {
    const { onApply, commitFromTheBar } = renderModal({ showArchived: false });

    commitFromTheBar({ showArchived: true });
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true });
  });

  it("survives Apply in the other direction too", () => {
    const { onApply, commitFromTheBar } = renderModal({ showArchived: true });

    commitFromTheBar({ showArchived: false });
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: false });
  });

  it("holds for every scope, not just the one that moved out first", () => {
    const { onApply, commitFromTheBar } = renderModal();

    commitFromTheBar({ bookmarked: true, showTriggered: true });
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, bookmarked: true, showTriggered: true });
  });

  it("survives an edit made in here being applied alongside it", () => {
    const { onApply, commitFromTheBar, setRegex } = renderModal({ showArchived: false });

    // The modal's own staging still works: its edit commits, and the live
    // scopes ride along untouched.
    setRegex("callboard");
    commitFromTheBar({ showArchived: true });
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][0]).toEqual({ ...DEFAULT_CHAT_FILTERS, directoryInclude: { value: "callboard", active: true } });
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showArchived: true });
  });

  /**
   * "Reset All" resets all of what this dialog SHOWS. Resetting the scopes from
   * here would silently switch off toggle buttons the user can see lit in the
   * bar behind the dialog, from a control they cannot see at all.
   */
  it("survives Reset All, which resets the fields only", () => {
    const { onApply, commitFromTheBar, setRegex } = renderModal({ showTriggered: true });

    setRegex("callboard");
    commitFromTheBar({ showArchived: true });
    fireEvent.click(screen.getByText("Reset All"));
    fireEvent.click(screen.getByText("Apply"));

    expect(onApply.mock.calls[0][0]).toEqual(DEFAULT_CHAT_FILTERS);
    expect(onApply.mock.calls[0][1]).toEqual({ ...DEFAULT_CHAT_VIEW_OPTIONS, showTriggered: true, showArchived: true });
  });
});
