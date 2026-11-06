// @vitest-environment jsdom
/**
 * The "Move to folder" dialog: pick an existing folder, type a new one, or
 * take the chat out of its folder — and stay open with the message when the
 * write is refused.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MoveToFolderModal from "./MoveToFolderModal";

afterEach(cleanup);

function renderModal(props: Partial<Parameters<typeof MoveToFolderModal>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<MoveToFolderModal subject="“A chat”" existingFolders={["work", "Alpha", "work"]} onSubmit={onSubmit} onClose={onClose} {...props} />);
  return { onSubmit: (props.onSubmit as typeof onSubmit) ?? onSubmit, onClose };
}

const input = () => screen.getByLabelText(/new folder/i) as HTMLInputElement;

describe("MoveToFolderModal", () => {
  it("lists existing folders once each, sorted case-insensitively, and files into one on click", async () => {
    const { onSubmit, onClose } = renderModal();
    const listed = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t === "work" || t === "Alpha");
    expect(listed).toEqual(["Alpha", "work"]);

    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Alpha"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("files into a typed new folder, trimmed, on Enter", async () => {
    const { onSubmit } = renderModal();
    fireEvent.change(input(), { target: { value: "  Side projects  " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Side projects"));
  });

  it("reuses an existing folder's spelling for a case-insensitive match", async () => {
    const { onSubmit } = renderModal();
    fireEvent.change(input(), { target: { value: "WORK" } });
    fireEvent.click(screen.getByText("Move"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("work"));
  });

  it("rejects control characters before going to the server", () => {
    const { onSubmit } = renderModal();
    fireEvent.change(input(), { target: { value: "bad\u0007name" } });
    fireEvent.click(screen.getByText("Move"));
    expect(screen.getByRole("alert").textContent).toMatch(/control/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("caps the input at the server's limit", () => {
    renderModal();
    expect(input().maxLength).toBe(64);
  });

  it("marks the current folder and offers Remove from folder only when in one", async () => {
    const { onSubmit } = renderModal({ currentFolder: "work" });
    const current = screen.getByText("work").closest("button")!;
    expect(current.disabled).toBe(true);
    expect(current.getAttribute("aria-current")).toBe("true");

    fireEvent.click(screen.getByText("Remove from folder"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(null));

    cleanup();
    renderModal();
    expect(screen.queryByText("Remove from folder")).toBeNull();
  });

  it("stays open and shows the server's message when the write fails", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Only a root chat can be filed into a folder"));
    const { onClose } = renderModal({ onSubmit });
    fireEvent.click(screen.getByText("Alpha"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/root chat/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cannot be closed by Escape, Cancel or the backdrop while a save is in flight", async () => {
    let settle: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const { onClose } = renderModal({ onSubmit });
    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    fireEvent.keyDown(document, { key: "Escape" });
    expect((screen.getByText("Cancel") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Cancel"));
    // The backdrop: ModalOverlay's outermost element.
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).not.toHaveBeenCalled();

    settle();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("says a pinned row stays under Pinned, and says nothing otherwise", () => {
    renderModal({ pinned: true });
    expect(screen.getByText(/stays under Pinned/)).toBeTruthy();
    cleanup();
    renderModal();
    expect(screen.queryByText(/stays under Pinned/)).toBeNull();
  });

  describe("starred folders", () => {
    /** The folder rows' names, top to bottom. */
    const rowNames = () => screen.queryAllByRole("button", { name: /^(Star|Unstar) folder / }).map((b) => b.getAttribute("aria-label")!.replace(/^(Star|Unstar) folder /, ""));

    it("lists starred folders first, each group sorted, and fills their stars", () => {
      renderModal({ existingFolders: ["work", "Alpha", "beta", "Zed"], starredFolders: ["Zed", "beta"], onToggleStar: vi.fn() });

      expect(rowNames()).toEqual(["beta", "Zed", "Alpha", "work"]);
      expect(screen.getByRole("button", { name: "Unstar folder Zed" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Star folder Alpha" })).toBeTruthy();
    });

    it("still offers a starred folder no chat names, and files into it", async () => {
      const { onSubmit } = renderModal({ existingFolders: ["work"], starredFolders: ["Someday"], onToggleStar: vi.fn() });

      expect(rowNames()).toEqual(["Someday", "work"]);
      fireEvent.click(screen.getByText("Someday"));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Someday"));
    });

    it("matches a star to a chat's folder case-insensitively, keeping the chat's spelling", async () => {
      const { onSubmit } = renderModal({ existingFolders: ["work"], starredFolders: ["Work"], onToggleStar: vi.fn() });

      expect(rowNames()).toEqual(["work"]);
      expect(screen.getByRole("button", { name: "Unstar folder work" })).toBeTruthy();
      // A typed name matching only the star still files under one spelling.
      fireEvent.change(input(), { target: { value: "WORK" } });
      fireEvent.click(screen.getByText("Move"));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("work"));
    });

    it("toggles the star without selecting the folder, by click and from the keyboard", () => {
      const onToggleStar = vi.fn();
      const { onSubmit, onClose } = renderModal({ starredFolders: ["work"], onToggleStar });

      fireEvent.click(screen.getByRole("button", { name: "Star folder Alpha" }));
      expect(onToggleStar).toHaveBeenCalledWith("Alpha");
      const unstar = screen.getByRole("button", { name: "Unstar folder work" }) as HTMLButtonElement;
      // A real <button>, so it is in the tab order and Enter/Space activate it.
      expect(unstar.tagName).toBe("BUTTON");
      expect(unstar.tabIndex).toBe(0);
      unstar.focus();
      expect(document.activeElement).toBe(unstar);
      fireEvent.click(unstar);
      expect(onToggleStar).toHaveBeenLastCalledWith("work");

      expect(onSubmit).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("stars the current folder too, even though its row cannot be picked", () => {
      const onToggleStar = vi.fn();
      renderModal({ currentFolder: "work", onToggleStar });
      const star = screen.getByRole("button", { name: "Star folder work" }) as HTMLButtonElement;
      expect(star.disabled).toBe(false);
      fireEvent.click(star);
      expect(onToggleStar).toHaveBeenCalledWith("work");
    });

    it("drops an unstarred folder no chat names", () => {
      const props = { existingFolders: ["work"], onToggleStar: vi.fn() };
      const { rerender } = render(<MoveToFolderModal subject="s" starredFolders={["Someday"]} onSubmit={vi.fn()} onClose={vi.fn()} {...props} />);
      expect(screen.getByText("Someday")).toBeTruthy();
      rerender(<MoveToFolderModal subject="s" starredFolders={[]} onSubmit={vi.fn()} onClose={vi.fn()} {...props} />);
      expect(screen.queryByText("Someday")).toBeNull();
    });

    it("disables the stars until the list is read, with the reason as the tooltip", () => {
      renderModal({ onToggleStar: vi.fn(), starDisabled: true, starError: "Could not reach the daemon" });
      const star = screen.getByRole("button", { name: "Star folder Alpha" }) as HTMLButtonElement;
      expect(star.disabled).toBe(true);
      expect(star.title).toBe("Could not reach the daemon");
      // And said where a touch screen can see it, not only in the tooltip.
      expect(screen.getByRole("status").textContent).toMatch(/Couldn't load starred folders/);
    });

    it("says nothing while the stars are merely still loading", () => {
      renderModal({ onToggleStar: vi.fn(), starDisabled: true });
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("shows a failed star write", () => {
      renderModal({ onToggleStar: vi.fn(), starError: "Could not save that change" });
      expect(screen.getByRole("status").textContent).toMatch(/Could not save/);
    });

    it("renders no stars without onToggleStar", () => {
      renderModal({ starredFolders: ["work"] });
      expect(rowNames()).toEqual([]);
      expect(screen.getByText("work")).toBeTruthy();
    });
  });
});
