import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import AsidePanel from "./AsidePanel";
import { getAsidePanelWidth } from "../utils/localStorage";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.getSelection()?.removeAllRanges();
});

it("closes on Escape, unless a menu, a modal or a selection inside claims it", () => {
  const onClose = vi.fn();
  const { rerender } = render(
    <AsidePanel label="Aside: why" isMobile={false} onClose={onClose}>
      <p>reply text</p>
    </AsidePanel>,
  );
  fireEvent.keyDown(screen.getByText("reply text"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);

  rerender(
    <AsidePanel label="Aside: why" isMobile={false} onClose={onClose}>
      <p>reply text</p>
      <div role="menu" />
    </AsidePanel>,
  );
  fireEvent.keyDown(screen.getByText("reply text"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);

  rerender(
    <AsidePanel label="Aside: why" isMobile={false} onClose={onClose}>
      <p>reply text</p>
    </AsidePanel>,
  );
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("reply text"));
  window.getSelection()!.addRange(range);
  fireEvent.keyDown(screen.getByText("reply text"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("is a complementary region on desktop, resizable from the keyboard, and keeps the width", () => {
  render(
    <div style={{ width: 1400 }}>
      <AsidePanel label="Aside: why" isMobile={false} onClose={() => {}}>
        <p>reply</p>
      </AsidePanel>
    </div>,
  );
  expect(screen.getByRole("complementary", { name: "Aside: why" })).toBeTruthy();
  const separator = screen.getByRole("separator", { name: "Resize aside panel" });
  const before = Number(separator.getAttribute("aria-valuenow"));
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(before);
  expect(getAsidePanelWidth()).toBe(Number(separator.getAttribute("aria-valuenow")));
});

it("is a full-screen dialog sheet on mobile, with no resize edge", () => {
  render(
    <AsidePanel label="Aside: why" isMobile onClose={() => {}}>
      <p>reply</p>
    </AsidePanel>,
  );
  const sheet = screen.getByRole("dialog", { name: "Aside: why" });
  expect(sheet.style.position).toBe("fixed");
  // Not aria-modal: the quote bar would take that for a modal and stand down.
  expect(sheet.getAttribute("aria-modal")).toBeNull();
  expect(screen.queryByRole("separator")).toBeNull();
});

it("takes focus on open and gives it back on close", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen((v) => !v)}>toggle</button>
        {open && (
          <AsidePanel label="Aside" isMobile={false} onClose={() => setOpen(false)}>
            <p>reply</p>
          </AsidePanel>
        )}
      </>
    );
  }
  render(<Harness />);
  const toggle = screen.getByText("toggle");
  toggle.focus();
  fireEvent.click(toggle);
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(document.activeElement).toBe(screen.getByRole("complementary"));
  fireEvent.keyDown(screen.getByText("reply"), { key: "Escape" });
  expect(document.activeElement).toBe(toggle);
});
