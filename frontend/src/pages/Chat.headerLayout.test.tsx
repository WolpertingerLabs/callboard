import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readCss } from "../testing/cssCascade";

// The chat header's base layout is the page's own, not a side effect of which
// feature components happen to be imported. #419 moved the header's grid,
// wrapping and container query into ComputerUsePanel.css, so the header only
// rendered correctly because ComputerUseHeader was imported somewhere. These
// render the header markup Chat.tsx produces with index.css alone.
// jsdom does not evaluate container queries; the responsive rules are read
// from the CSSOM instead.
const css = readCss("index.css");
afterEach(cleanup);

it("lays out the desktop header as a wrapping grid from index.css alone", () => {
  const { container } = render(
    <>
      <style>{css}</style>
      <div className="chat-layout">
        <header className="chat-header">
          <div className="chat-header-identity">
            <div className="chat-header-identity-line">Branch and provider</div>
          </div>
          <div className="chat-header-actions">
            <button>View</button>
          </div>
          <button className="chat-header-generation-stop">Stop</button>
        </header>
      </div>
    </>,
  );
  const header = getComputedStyle(container.querySelector(".chat-header")!);
  expect(header.display).toBe("grid");
  expect(header.gridTemplateColumns).toBe("minmax(220px, 1fr) minmax(0, auto) auto");
  expect(header.flexWrap).toBe("wrap");
  expect(getComputedStyle(container.querySelector(".chat-layout")!).getPropertyValue("container")).toBe("chat-layout / inline-size");
  expect(getComputedStyle(container.querySelector(".chat-header-identity")!).flexBasis).toBe("220px");
  for (const selector of [".chat-header-identity-line", ".chat-header-actions"]) {
    const style = getComputedStyle(container.querySelector(selector)!);
    expect(style.display).toBe("flex");
    expect(style.flexWrap).toBe("wrap");
  }
  expect(getComputedStyle(container.querySelector(".chat-header-actions")!).maxWidth).toBe("100%");
  expect(getComputedStyle(container.querySelector(".chat-header-actions > button")!).flexShrink).toBe("0");
  expect(getComputedStyle(container.querySelector(".chat-header-generation-stop")!).flexShrink).toBe("0");
});

it("keeps the mobile header on flex with a narrower identity column", () => {
  const { container } = render(
    <>
      <style>{css}</style>
      <header className="chat-header chat-header-mobile">
        <div className="chat-header-identity" />
      </header>
    </>,
  );
  expect(getComputedStyle(container.querySelector("header")!).display).toBe("flex");
  expect(getComputedStyle(container.querySelector(".chat-header-identity")!).flexBasis).toBe("100px");
});

it("reserves the identity-row stop and moves actions to a second row at narrow chat widths", () => {
  const { container } = render(<style>{css}</style>);
  const rules = [...container.querySelector("style")!.sheet!.cssRules];
  const responsive = rules.filter((rule) => rule.cssText.startsWith("@container")) as CSSContainerRule[];
  expect(responsive.map((rule) => rule.conditionText)).toEqual(["chat-layout (max-width: 900px)", "chat-layout (max-width: 620px)"]);
  const declarations = (index: number, suffix: string) => {
    const inner = [...responsive[index].cssRules] as CSSStyleRule[];
    return inner.find((rule) => rule.selectorText === `.chat-header:not(.chat-header-mobile)${suffix}`)!.style;
  };
  expect(declarations(0, "").getPropertyValue("grid-template-columns")).toBe("minmax(0, 1fr) auto");
  expect(declarations(0, " .chat-header-generation-stop").getPropertyValue("grid-row")).toBe("1");
  expect(declarations(0, " .chat-header-generation-stop").getPropertyValue("grid-column")).toBe("2");
  expect(declarations(0, " .chat-header-actions").getPropertyValue("grid-row")).toBe("2");
  expect(declarations(0, " .chat-header-actions").getPropertyValue("grid-column")).toBe("1 / -1");
  expect(declarations(1, " .chat-header-actions").getPropertyValue("width")).toBe("100%");
});
