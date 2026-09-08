import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ComputerUseController } from "../hooks/useComputerUseController";
import { readCss } from "../testing/cssCascade";
import ComputerUseHeader from "./ComputerUseHeader";

// jsdom does not measure geometry or evaluate container queries. These guard
// the strip's own flex constraints and its responsive placement inside the
// chat header, whose base layout is index.css's and is guarded in
// pages/Chat.headerLayout.test.tsx. Physical fit/wrapping is checked with
// normal-sandbox Firefox fixtures.
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
          <ComputerUseHeader
            controller={
              { hasUsage: true, status: null, statusError: "", stopping: false, stopError: "x".repeat(500), stopAll: async () => {} } as ComputerUseController
            }
          />
        </div>
      </header>
    </>,
  );
  for (const selector of [".chat-header", ".chat-header-actions", ".computer-use-header", ".computer-use-summary"]) {
    expect(getComputedStyle(container.querySelector(selector)!).flexWrap).toBe("wrap");
  }
  // The strip is the one action allowed to give up width; everything else in the row is rigid.
  expect(getComputedStyle(container.querySelector(".chat-header-actions > .computer-use-header")!).flexShrink).toBe("1");
  const stop = getComputedStyle(screen.getByRole("button", { name: "Stop computer control" }));
  expect(stop.flexShrink).toBe("0");
  expect(stop.whiteSpace).toBe("nowrap");
  expect(getComputedStyle(screen.getByRole("alert")).overflowWrap).toBe("anywhere");
});

it("styles only its own placement in the header, and takes the full row at narrow chat widths", () => {
  const { container } = render(<style>{stripCss}</style>);
  const rules = [...container.querySelector("style")!.sheet!.cssRules];
  // No header-owned layout rule may live here: the header must lay out
  // correctly whether or not this stylesheet is loaded.
  const headerOwned = rules.filter(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && /(^|,\s*)\.chat-(layout|header[a-z-]*)(\s*[,:{]|\s*$)/.test(rule.selectorText),
  );
  expect(headerOwned.map((rule) => rule.selectorText)).toEqual([]);
  const responsive = rules.filter((rule) => rule.cssText.startsWith("@container")) as CSSContainerRule[];
  expect(responsive.map((rule) => rule.conditionText)).toEqual(["chat-layout (max-width: 620px)"]);
  const inner = [...responsive[0].cssRules] as CSSStyleRule[];
  expect(inner.map((rule) => rule.selectorText)).toEqual([".chat-header:not(.chat-header-mobile) .chat-header-actions > .computer-use-header"]);
  expect(inner[0].style.getPropertyValue("order")).toBe("1");
  expect(inner[0].style.getPropertyValue("flex-basis")).toBe("100%");
});
