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
});
