/**
 * The panel's height contract, as far as jsdom can hold it.
 *
 * jsdom does no layout, so nothing here can see the failure this file exists
 * for: `min-height: 0` on `.computer-use-stage` let a short panel shrink the
 * stage under its own min-content, paint the manual-input controls across the
 * footer, and leave `.computer-use-body`'s scrollHeight unchanged — so the
 * overlapped controls could not be scrolled into view. `elementFromPoint` over
 * the Navigate button returned the footer. That is measured in Chromium
 * against this component's real markup, not here.
 *
 * What is testable here is the cascade that produced it, and it is one
 * declaration on each of three elements:
 *
 * - the setup block and the footer do not shrink, so every pixel a short panel
 *   is missing is taken from the stage;
 * - the stage therefore has to keep its automatic minimum size (min-content) —
 *   it is the only thing that stops it collapsing under its own controls;
 * - and the shrink has to land somewhere, so it lands on the viewport, whose
 *   definite `height: 0` both takes the screenshot's intrinsic height out of
 *   the stage's min-content and lets flex-grow give it the leftover space.
 *
 * Read as declarations rather than as computed values: `min-height`'s absence
 * is the assertion for the stage, and an initial value read back from
 * `getComputedStyle` cannot distinguish "not set" from "set to the initial
 * value". The `@media` block is invisible to the resolved cascade at any
 * viewport (see `testing/cssCascade.ts`), so its rules are read the same way.
 */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "shared/types/computerUse.js";
import { declarationsFor, injectCss, readCss } from "../testing/cssCascade";
import { computerUseClient as client } from "../api/computerUse";
import { useComputerUseController } from "../hooks/useComputerUseController";
import ComputerUsePanel from "./ComputerUsePanel";

vi.mock("../api/computerUse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/computerUse")>()),
  computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() },
}));

const MOBILE = "(max-width: 768px)";
let sheet: CSSStyleSheet;
let remove: (() => void) | undefined;

function Viewer() {
  const [visible] = useState(true);
  const controller = useComputerUseController("c1", { viewOpen: visible });
  return <ComputerUsePanel chatId="c1" permission="allow" controller={controller} />;
}

beforeAll(() => {
  ({ sheet, remove } = injectCss(readCss("components/ComputerUsePanel.css")));
});
afterAll(() => remove?.());
beforeEach(() => {
  const status: ComputerUseStatus = {
    permission: "allow",
    capabilities: [{ kind: "browser", available: true }],
    sessions: [{ id: "s1", kind: "browser", state: "active", controller: "agent", generation: 1 }],
  };
  vi.mocked(client.status).mockImplementation(async () => structuredClone(status));
  vi.mocked(client.observe).mockResolvedValue({
    generation: 1,
    frameId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    frame: { data: "AA==", mimeType: "image/png", width: 1280, height: 800 },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The real panel, showing a frame, so every class asserted on is one it renders. */
async function panel() {
  const { container } = render(<Viewer />);
  await screen.findByRole("button", { name: "Stop" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh screenshot" }));
  await waitFor(() => screen.getByRole("img"));
  await act(async () => {});
  const find = (selector: string) => {
    const element = container.querySelector(selector);
    if (!element) throw new Error(`the panel rendered no ${selector}`);
    return element;
  };
  return {
    body: find(".computer-use-body"),
    setup: find(".computer-use-setup"),
    stage: find(".computer-use-stage"),
    footer: find(".computer-use-footer"),
    viewport: find(".computer-use-viewport"),
  };
}
const values = (element: Element, property: string, condition = "") =>
  declarationsFor(sheet, element, property)
    // `declarationsFor` matches by prefix, so `flex` would also collect
    // `flex-direction`; these assertions are about the property itself.
    .filter((declaration) => declaration.property === property && declaration.condition === condition)
    // jsdom hands `min-height: 0` back as "0px" and `height: 0` as "0"; the
    // distinction is the property, not the declaration.
    .map((declaration) => declaration.value.replace(/^0px$/, "0"));

describe("the panel's vertical contract", () => {
  it("takes all of a short panel's shrink out of the stage", async () => {
    const { setup, footer } = await panel();
    // `flex: 0 0 auto` — no grow, no shrink. This is the premise of everything
    // below: if either of these could shrink, the stage would not have to.
    expect(values(setup, "flex")).toEqual(["0 0 auto"]);
    expect(values(footer, "flex")).toEqual(["0 0 auto"]);
  });

  it("leaves the stage its automatic minimum size, so it cannot collapse under its own controls", async () => {
    const { stage } = await panel();
    expect(values(stage, "flex")).toEqual(["1 1 auto"]);
    // The regression: any `min-height` here re-enables the collapse. There is
    // no value of it that is safe — a smaller floor is the same bug at a
    // smaller panel — so the assertion is that none is set at all, under any
    // condition, which is also why this one reads the raw declarations.
    expect(declarationsFor(sheet, stage, "min-height")).toEqual([]);
  });

  it("lands the shrink on the screenshot instead", async () => {
    const { viewport } = await panel();
    expect(values(viewport, "min-height")).toEqual(["0"]);
    // Definite, so the image's intrinsic height stays out of the stage's
    // min-content; flex-grow then hands the box the space that is left.
    expect(values(viewport, "height")).toEqual(["0"]);
    expect(values(viewport, "flex")).toEqual(["1 1 auto"]);
  });

  it("scrolls the panel when even the stage's minimum does not fit", async () => {
    const { body } = await panel();
    expect(getComputedStyle(body).overflow).toBe("auto");
    expect(getComputedStyle(document.querySelector(".computer-use-panel")!).overflow).toBe("hidden");
  });

  it("hands the phone rules back a content-sized frame", async () => {
    const { stage, viewport } = await panel();
    // Under the phone rules nothing shrinks, so the stage's floor is moot and
    // the frame takes the width it needs — but then the viewport must give up
    // the definite 0 height, or the image would overflow a zero-height box.
    expect(values(stage, "flex", MOBILE)).toEqual(["0 0 auto"]);
    expect(values(viewport, "height", MOBILE)).toEqual(["auto"]);
  });
});

it("keeps desktop guidance and long diagnostics wrappable using theme tokens", async () => {
  await panel();
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
  const notice = screen.getByRole("heading", { name: "Desktop readiness unconfirmed" }).parentElement!;
  expect(values(notice, "min-width")).toEqual(["0"]);
  expect(values(notice, "overflow-wrap")).toEqual(["anywhere"]);
  expect(values(notice, "color")).toEqual(["var(--text)"]);
  expect(values(notice, "background")).toEqual(["var(--bg)"]);
});
