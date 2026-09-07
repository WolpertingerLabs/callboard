import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ComputerUseController } from "../hooks/useComputerUseController";
import ComputerUseHeader from "./ComputerUseHeader";

// jsdom does not measure geometry. These guard the actual CSS flex constraints;
// physical fit/wrapping is checked with normal-sandbox Firefox fixtures.
const css = readFileSync("frontend/src/components/ComputerUsePanel.css", "utf8");
afterEach(cleanup);
it("allows wrapping at available pane width while protecting stop text and long errors", () => {
  const { container } = render(
    <>
      <style>{css}</style>
      <header className="chat-header" style={{ display: "flex" }}>
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
  expect(getComputedStyle(container.querySelector(".chat-header-identity")!).flexBasis).toBe("220px");
  expect(getComputedStyle(container.querySelector(".chat-header-actions")!).maxWidth).toBe("100%");
  const stop = getComputedStyle(screen.getByRole("button", { name: "Stop computer control" }));
  expect(stop.flexShrink).toBe("0");
  expect(stop.whiteSpace).toBe("nowrap");
  expect(getComputedStyle(screen.getByRole("alert")).overflowWrap).toBe("anywhere");
});
