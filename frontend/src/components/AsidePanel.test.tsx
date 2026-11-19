import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import AsidePanel from "./AsidePanel";
import { getAsidePanelWidth } from "../utils/localStorage";
import { isModalOpen } from "../utils/modalOpen";

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
  // Modal to assistive tech — but not to the page's own floating UI: the
  // quote bar works inside the sheet.
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(isModalOpen()).toBe(false);
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

it("keeps Tab inside the mobile sheet", () => {
  render(
    <AsidePanel label="Aside" isMobile onClose={() => {}}>
      <button>first</button>
      <div style={{ display: "none" }}>
        <button>hidden</button>
      </div>
      <button>last</button>
    </AsidePanel>,
  );
  const first = screen.getByText("first");
  const last = screen.getByText("last");
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
});

it("gives focus back to the opener it is handed when the focused control went away", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [menu, setMenu] = useState(true);
    return (
      <>
        <button data-testid="trigger">trigger</button>
        {menu && (
          <button
            onClick={() => {
              setMenu(false);
              setOpen(true);
            }}
          >
            menu row
          </button>
        )}
        {open && (
          <AsidePanel
            label="Aside"
            isMobile={false}
            onClose={() => setOpen(false)}
            getReturnFocus={() => document.querySelector<HTMLElement>('[data-testid="trigger"]')}
          >
            <p>reply</p>
          </AsidePanel>
        )}
      </>
    );
  }
  render(<Harness />);
  const row = screen.getByText("menu row");
  row.focus();
  fireEvent.click(row);
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  fireEvent.keyDown(screen.getByText("reply"), { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByTestId("trigger"));
});

it("leaves an Escape that an input method is using to cancel a composition", () => {
  const onClose = vi.fn();
  render(
    <AsidePanel label="Aside" isMobile={false} onClose={onClose}>
      <textarea aria-label="typing" />
    </AsidePanel>,
  );
  const field = screen.getByLabelText("typing");
  fireEvent.keyDown(field, { key: "Escape", isComposing: true });
  fireEvent.keyDown(field, { key: "Escape", keyCode: 229 });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
