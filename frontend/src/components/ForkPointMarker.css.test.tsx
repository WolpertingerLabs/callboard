// @vitest-environment jsdom
/**
 * The fork-point menu's keyboard focus indicator, read back through the real
 * index.css cascade (see testing/cssCascade.ts for why the stylesheet is
 * injected rather than regexed).
 *
 * The row's hover tint is too faint to mark focus on its own, and
 * forced-colors mode drops it entirely, so a focused row must carry an
 * outline — and keep one under forced colors.
 */
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatTreeNode } from "../api";
import { declarationsJsdomIgnores, injectCss, readCss } from "../testing/cssCascade";
import ForkPointMarker from "./ForkPointMarker";

vi.mock("../api", () => ({}));

let sheet: CSSStyleSheet;
beforeAll(() => {
  ({ sheet } = injectCss(readCss("index.css")));
});

afterEach(() => {
  cleanup();
});

const forks: ChatTreeNode[] = ["f1", "f2"].map((chatId) => ({
  chatId,
  title: `Fork ${chatId}`,
  role: "fork",
  forkedAt: "2026-01-01T00:00:00.000Z",
  provider: "claude-code",
  status: "stopped",
  folder: "/repo",
  createdAt: "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  children: [],
}));

/**
 * The element's computed `outline`. jsdom caches computed style until a DOM
 * mutation, and a focus change is not one — without the nudge, a row read
 * before focus moved keeps reporting its old outline. A browser recomputes.
 */
function outlineOf(el: HTMLElement): string {
  document.body.toggleAttribute("data-style-recalc");
  return getComputedStyle(el).outline;
}

function openMenu() {
  render(
    <MemoryRouter>
      <ForkPointMarker forks={forks} align="left" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "2 forks" }));
  return screen.getAllByRole("menuitem");
}

it("outlines the keyboard-focused row, and only that row", () => {
  const [first, second] = openMenu();
  // Opening the menu focuses its first row.
  expect(document.activeElement).toBe(first);
  expect(first.matches(":focus-visible")).toBe(true);

  const focused = outlineOf(first);
  expect(focused).not.toBe("");
  expect(focused).not.toMatch(/^none\b/);
  expect(focused).toMatch(/\bsolid\b/);
  expect(outlineOf(second)).toBe("");

  fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  expect(outlineOf(second)).toBe(focused);
  expect(outlineOf(first)).toBe("");
});

it("keeps a system-colour outline under forced colors, where the tint is dropped", () => {
  // jsdom never evaluates @media, so the fallback is checked as authored.
  const [first] = openMenu();
  const fallback = declarationsJsdomIgnores(sheet).filter(
    (d) => d.condition.includes("forced-colors: active") && d.property.startsWith("outline") && first.matches(d.selectorText),
  );
  expect(fallback).toHaveLength(1);
  expect(fallback[0].value).toMatch(/\bsolid\b.*\bHighlight\b/i);
});
