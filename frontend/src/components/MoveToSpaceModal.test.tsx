// @vitest-environment jsdom
/** "Move to space…": the current space is not offered, and a failed move says why and stays open. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { moveToSpace } from "../api";
import { SpaceContext } from "../contexts/SpaceContext";
import { makeSpaceContext, testSpace } from "../testing/spaceContext";
import MoveToSpaceModal from "./MoveToSpaceModal";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), moveToSpace: vi.fn() }));

const SPACES = [testSpace("default", "General"), testSpace("sp_work", "Work"), testSpace("sp_home", "Home")];

function renderModal(onClose = vi.fn(), onMoved = vi.fn()) {
  render(
    <SpaceContext.Provider value={makeSpaceContext(SPACES)}>
      <MoveToSpaceModal chatIds={["c1"]} subject="“Fix it”" currentSpaceId="sp_work" onClose={onClose} onMoved={onMoved} />
    </SpaceContext.Provider>,
  );
  return { onClose, onMoved };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MoveToSpaceModal", () => {
  it("leaves the chat's own space out of the list", () => {
    renderModal();
    expect(screen.queryByRole("button", { name: /Work/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Home/ })).toBeTruthy();
  });

  it("shows the server's error and stays open when nothing moved", async () => {
    vi.mocked(moveToSpace).mockResolvedValue({ movedRoots: [], chatCount: 0, failed: [{ id: "c1", error: "Chat not found" }] });
    const { onClose, onMoved } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Chat not found"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
    // And the buttons are usable again for a retry.
    expect((screen.getByRole("button", { name: /Home/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a thrown request error", async () => {
    vi.mocked(moveToSpace).mockRejectedValue(new Error('Space "Old" is archived'));
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /General/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("archived"));
  });

  it("closes and reports on success", async () => {
    vi.mocked(moveToSpace).mockResolvedValue({ movedRoots: ["c1"], chatCount: 3, failed: [] });
    const { onClose, onMoved } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onMoved).toHaveBeenCalledWith({ movedRoots: ["c1"], chatCount: 3, failed: [] }, "sp_home");
    expect(moveToSpace).toHaveBeenCalledWith("sp_home", { chatIds: ["c1"] });
  });
});
