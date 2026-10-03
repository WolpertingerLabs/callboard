import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ModalOverlay from "./ModalOverlay";

afterEach(cleanup);

describe("ModalOverlay onBackdropClick", () => {
  it("runs on a click on the backdrop itself, not on the dialog inside it", () => {
    const onBackdropClick = vi.fn();
    render(
      <ModalOverlay onBackdropClick={onBackdropClick}>
        <div>dialog</div>
      </ModalOverlay>,
    );
    fireEvent.click(screen.getByText("dialog"));
    expect(onBackdropClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("dialog").parentElement!);
    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });

  it("is opt-in: without it a backdrop click does nothing", () => {
    render(
      <ModalOverlay>
        <div>dialog</div>
      </ModalOverlay>,
    );
    expect(() => fireEvent.click(screen.getByText("dialog").parentElement!)).not.toThrow();
  });
});
