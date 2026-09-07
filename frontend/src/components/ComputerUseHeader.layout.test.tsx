import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ComputerUseController } from "../hooks/useComputerUseController";
import ComputerUseHeader from "./ComputerUseHeader";

// jsdom does not measure geometry or evaluate container queries. These guard
// the actual CSS grid/flex constraints and responsive declarations;
// physical fit/wrapping is checked with normal-sandbox Firefox fixtures.
const css = readFileSync("frontend/src/components/ComputerUsePanel.css", "utf8");
afterEach(cleanup);
it("allows wrapping at available pane width while protecting stop text and long errors", () => {
  const { container } = render(
    <>
      <style>{css}</style>
      <header className="chat-header">
        <div className="chat-header-identity">
          <div className="chat-header-identity-line">Branch and provider</div>
        </div>
        <div className="chat-header-actions">
          <ComputerUseHeader
            controller={{ status: null, statusError: "", stopping: false, stopError: "x".repeat(500), stopAll: async () => {} } as ComputerUseController}
          />
        </div>
      </header>
    </>,
  );
  for (const selector of [".chat-header", ".chat-header-actions", ".chat-header-identity-line", ".computer-use-header", ".computer-use-summary"]) {
    expect(getComputedStyle(container.querySelector(selector)!).flexWrap).toBe("wrap");
  }
  expect(getComputedStyle(container.querySelector(".chat-header")!).display).toBe("grid");
  expect(getComputedStyle(container.querySelector(".chat-header")!).gridTemplateColumns).toBe("minmax(220px, 1fr) minmax(0, auto) auto");
  expect(getComputedStyle(container.querySelector(".chat-header-identity")!).flexBasis).toBe("220px");
  expect(getComputedStyle(container.querySelector(".chat-header-actions")!).maxWidth).toBe("100%");
  const stop = getComputedStyle(screen.getByRole("button", { name: "Stop computer control" }));
  expect(stop.flexShrink).toBe("0");
  expect(stop.whiteSpace).toBe("nowrap");
  expect(getComputedStyle(screen.getByRole("alert")).overflowWrap).toBe("anywhere");
});

it("uses named chat-container rules to reserve the identity-row stop and group narrow-pane actions", () => {
  const { container } = render(<style>{css}</style>);
  const rules = [...container.querySelector("style")!.sheet!.cssRules];
  const responsive = rules.filter((rule) => rule.cssText.startsWith("@container")) as CSSContainerRule[];
  expect(responsive.map((rule) => rule.conditionText)).toEqual(["chat-layout (max-width: 900px)", "chat-layout (max-width: 620px)"]);
  const declarations = (index: number, suffix: string) => {
    const rules = [...responsive[index].cssRules] as CSSStyleRule[];
    return rules.find((rule) => rule.selectorText === `.chat-header:not(.chat-header-mobile)${suffix}`)!.style;
  };
  expect(declarations(0, "").getPropertyValue("grid-template-columns")).toBe("minmax(0, 1fr) auto");
  expect(declarations(0, " .chat-header-generation-stop").getPropertyValue("grid-row")).toBe("1");
  expect(declarations(0, " .chat-header-generation-stop").getPropertyValue("grid-column")).toBe("2");
  expect(declarations(0, " .chat-header-actions").getPropertyValue("grid-row")).toBe("2");
  expect(declarations(0, " .chat-header-actions").getPropertyValue("grid-column")).toBe("1 / -1");
  expect(declarations(1, " .chat-header-actions > .computer-use-header").getPropertyValue("order")).toBe("1");
  expect(declarations(1, " .chat-header-actions > .computer-use-header").getPropertyValue("flex-basis")).toBe("100%");
});
it("leaves the mobile header on its existing flex layout", () => {
  const { container } = render(
    <>
      <style>{css}</style>
      <header className="chat-header chat-header-mobile" />
    </>,
  );
  expect(getComputedStyle(container.querySelector("header")!).display).toBe("flex");
});
