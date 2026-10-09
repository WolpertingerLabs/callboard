/**
 * The New Chat panel must scroll within the sidebar column, not overflow it.
 *
 * On a phone, with Permissions expanded, the panel outgrew ChatList's
 * fixed-height flex column. As a plain flex item (`min-height: auto`, no
 * scroll container) it could neither shrink nor scroll: the Create button sat
 * below the viewport with no touch able to reach it, and focus scrolling moved
 * an `overflow: hidden` layout ancestor instead, pushing the sidebar header
 * off-screen. Verified in Chromium at 390x844 before and after the fix.
 *
 * jsdom has no layout, so this guards the mechanism through the real cascade
 * (NewChatPanel.css injected, not regexed): the rendered panel carries the
 * class, and the class makes it a shrinkable, bounded scroll container.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NewChatPanel from "./NewChatPanel";
import { resetSystemInfoCache } from "../api";
import { injectCss, readCss } from "../testing/cssCascade";

let removeCss: () => void = () => {};

beforeEach(() => {
  resetSystemInfoCache();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })),
  );
  removeCss = injectCss(readCss("components/NewChatPanel.css")).remove;
});

afterEach(() => {
  removeCss();
  cleanup();
  vi.unstubAllGlobals();
});

it("is a shrinkable, bounded scroll container even with Permissions expanded", () => {
  render(
    <MemoryRouter>
      <NewChatPanel onClose={() => {}} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Permissions:/ }));
  expect(screen.getByTestId("permission-review-settings")).toBeTruthy();

  const panel = screen.getByTestId("new-chat-panel");
  const style = getComputedStyle(panel);
  // Scrolls itself rather than spilling into the hidden layout ancestor.
  expect(style.overflowY).toBe("auto");
  // May shrink below its content inside the column (min-height: auto would not).
  expect(style.flexShrink).toBe("1");
  expect(style.minHeight).toMatch(/^0(px)?$/);
  // Scroll stays in the panel instead of chaining to the page behind it.
  expect(style.getPropertyValue("overscroll-behavior")).toBe("contain");
  // No inline height/overflow that would override the stylesheet.
  expect(panel.style.overflow).toBe("");
  expect(panel.style.overflowY).toBe("");
  expect(panel.style.maxHeight).toBe("");
});
