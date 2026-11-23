import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CALLBOARD_NOTICE_SUBTYPE } from "shared/types/index.js";
import MessageBubble from "./MessageBubble";

vi.mock("../api", () => ({}));
afterEach(cleanup);

it("renders a split-off ride-along block as its own row, labelled as Callboard's, not as the human's bubble", () => {
  render(
    <MessageBubble
      message={{ role: "system", type: "system", subtype: CALLBOARD_NOTICE_SUBTYPE, content: "🖥️ Computer control update — GUI action request withdrawn." }}
      onFork={vi.fn()}
    />,
  );
  const row = screen.getByTestId("callboard-notice");
  expect(row.textContent).toContain("Callboard told the agent");
  expect(row.textContent).toContain("GUI action request withdrawn.");
});
