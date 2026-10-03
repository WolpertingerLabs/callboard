import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FullscreenFrame, { FullscreenButton } from "./FullscreenFrame";

afterEach(cleanup);

function renderFrame(caption?: string) {
  const onClose = vi.fn();
  const utils = render(
    <FullscreenFrame onClose={onClose} caption={caption}>
      <img alt="content" />
    </FullscreenFrame>,
  );
  return { onClose, ...utils };
}

describe("FullscreenFrame", () => {
  it("closes on Escape", () => {
    const { onClose } = renderFrame();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const { onClose } = renderFrame();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops listening for Escape once unmounted", () => {
    const { onClose, unmount } = renderFrame();
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("attaches the Escape listener once per open, and calls the latest onClose", () => {
    const add = vi.spyOn(document, "addEventListener");
    try {
      const first = vi.fn();
      const latest = vi.fn();
      const { rerender } = render(
        <FullscreenFrame onClose={first}>
          <img alt="content" />
        </FullscreenFrame>,
      );
      rerender(
        <FullscreenFrame onClose={latest}>
          <img alt="content" />
        </FullscreenFrame>,
      );
      expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(first).not.toHaveBeenCalled();
      expect(latest).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
    }
  });

  it("closes on the × button", () => {
    const { onClose } = renderFrame();
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click on the backdrop, not on the content", () => {
    const { onClose } = renderFrame();
    const content = screen.getByAltText("content");
    fireEvent.click(content);
    expect(onClose).not.toHaveBeenCalled();
    // The click-catcher is the frame's parent: the full-size box around it.
    const backdrop = content.parentElement!.parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the caption under the content when given", () => {
    renderFrame("A caption");
    expect(screen.getByText("A caption")).toBeTruthy();
  });

  it("paints its controls with the media-control tokens, not literals", () => {
    renderFrame();
    const close = screen.getByRole("button", { name: "×" });
    expect(close.style.background).toBe("var(--media-control-bg-strong)");
    expect(close.style.color).toBe("var(--media-control-text)");
  });
});

describe("FullscreenButton", () => {
  it("opens on click", () => {
    const onClick = vi.fn();
    render(<FullscreenButton onClick={onClick} />);
    fireEvent.click(screen.getByTitle("Fullscreen"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
