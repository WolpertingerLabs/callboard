import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ComputerUseController } from "../hooks/useComputerUseController";
import { readCss } from "../testing/cssCascade";
import ComputerUseHeader from "./ComputerUseHeader";

// jsdom does not measure geometry or evaluate container queries. These guard
// the strip's own flex constraints and its responsive placement inside the
// chat header, whose base layout is index.css's and is guarded in
// pages/Chat.headerLayout.test.tsx. Physical fit/wrapping is checked with
// isolated Chromium/Firefox fixtures using the actual Chat DOM and CSS.
const pageCss = readCss("index.css");
const stripCss = readCss("components/ComputerUsePanel.css");
afterEach(cleanup);
it("wraps inside the page header while protecting stop text and long errors", () => {
  const { container } = render(
    <>
      <style>{pageCss}</style>
      <style>{stripCss}</style>
      <header className="chat-header">
        <div className="chat-header-identity">
          <div className="chat-header-identity-line">Branch and provider</div>
        </div>
        <div className="chat-header-actions">
          <button>View</button>
        </div>
        <button className="chat-header-generation-stop">Stop generation</button>
        <ComputerUseHeader
          controller={
            { hasUsage: true, status: null, statusError: "", stopping: false, stopError: "x".repeat(500), stopAll: async () => {} } as ComputerUseController
          }
        />
      </header>
    </>,
  );
  for (const selector of [".chat-header", ".chat-header-actions", ".computer-use-header", ".computer-use-summary"]) {
    expect(getComputedStyle(container.querySelector(selector)!).flexWrap).toBe("wrap");
  }
  const strip = getComputedStyle(container.querySelector(".chat-header > .computer-use-header")!);
  expect(strip.gridColumn).toBe("1 / -1");
  expect(strip.paddingTop).toBe("8px");
  const stop = getComputedStyle(screen.getByRole("button", { name: "Stop computer control" }));
  expect(stop.flexShrink).toBe("0");
  expect(stop.whiteSpace).toBe("nowrap");
  expect(getComputedStyle(screen.getByRole("alert")).overflowWrap).toBe("anywhere");
});

it("does not change mobile strip spacing or add width-dependent hiding", () => {
  const { container } = render(
    <>
      <style>{pageCss}</style>
      <style>{stripCss}</style>
      <header className="chat-header chat-header-mobile" />
      <ComputerUseHeader controller={{ hasUsage: true, status: null } as ComputerUseController} />
    </>,
  );
  const strip = getComputedStyle(container.querySelector(".computer-use-header")!);
  expect(strip.padding).toBe("4px 16px");
  expect(strip.gridColumn).toBe("");
  const rules = [...container.querySelectorAll("style")[1].sheet!.cssRules];
  expect(rules.filter((rule) => rule.cssText.startsWith("@container"))).toHaveLength(0);
  // Header-owned grid/wrapping must remain in index.css, not depend on this feature.
  const headerOwned = rules.filter(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule &&
      rule.selectorText.split(",").some((selector) => /^\.chat-(layout|header[a-z-]*)(?::not\([^)]*\))?$/.test(selector.trim())),
  );
  expect(headerOwned.map((rule) => rule.selectorText)).toEqual([]);
  const desktopPlacement = rules.find(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === ".chat-header:not(.chat-header-mobile) > .computer-use-header",
  )!;
  expect(desktopPlacement.style.getPropertyValue("border-top")).toBe("1px solid var(--border)");
});
