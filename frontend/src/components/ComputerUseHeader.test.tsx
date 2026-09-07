import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "shared/types/computerUse.js";
import type { ComputerUseController } from "../hooks/useComputerUseController";
import ComputerUseHeader from "./ComputerUseHeader";

const status: ComputerUseStatus = {
  permission: "allow",
  capabilities: [],
  sessions: [
    { id: "a", kind: "browser", state: "active", controller: "agent", generation: 1 },
    { id: "h", kind: "native", state: "ready", controller: "human", generation: 1 },
    { id: "p", kind: "native", state: "awaiting_approval", controller: null, generation: 0 },
    { id: "o", kind: "browser", state: "paused", controller: null, generation: 1 },
    { id: "t", kind: "native", state: "stopped", controller: "agent", generation: 1 },
  ],
};
function controller(overrides: Partial<ComputerUseController> = {}): ComputerUseController {
  return {
    hasUsage: true,
    status,
    statusError: "",
    stopping: false,
    stopError: "",
    stopAll: vi.fn(async () => {}),
    readStatus: vi.fn(async () => undefined),
    beginMutation: vi.fn(() => vi.fn()),
    viewerEpoch: 0,
    ...overrides,
  };
}
afterEach(cleanup);
it("keeps counts, pending approval and named controllers visible with full accessible details, excluding terminal sessions", () => {
  const control = controller();
  render(<ComputerUseHeader controller={control} />);
  expect(screen.getByText("2 active · 1 waiting")).toBeTruthy();
  expect(screen.getByText("Agent 1")).toBeTruthy();
  expect(screen.getByText("Human 1")).toBeTruthy();
  expect(screen.getByText("1 other")).toBeTruthy();
  const summary = screen.getByRole("status");
  expect(summary.getAttribute("aria-label")).toContain("1 waiting for approval");
  expect(summary.title).toBe(summary.getAttribute("aria-label"));
  expect(summary.textContent).not.toContain("Browser & Computer Control:");
  expect(control.stopAll).not.toHaveBeenCalled();
  expect(control.readStatus).not.toHaveBeenCalled();
  expect(control.beginMutation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop computer control" }));
  expect(control.stopAll).toHaveBeenCalledTimes(1);
});
it.each([
  [null, "", "Checking…"],
  [null, "offline", "Unavailable"],
  [{ ...status, sessions: [] }, "", "Idle"],
  [{ ...status, sessions: [], permission: "deny" }, "", "Disabled"],
  [status, "offline", "Last known"],
] as const)("shows a truthful concise state (%s, %s)", (snapshot, error, label) => {
  render(<ComputerUseHeader controller={controller({ status: snapshot as ComputerUseStatus | null, statusError: error })} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Stop computer control" }) as HTMLButtonElement).disabled).toBe(false);
  if (!snapshot) expect(screen.getByRole("status").textContent).not.toContain("0 active");
  if (snapshot?.sessions.length) expect(screen.getByText("Human 1")).toBeTruthy();
});
it("does not mistake denied permission for stopped sessions; distinguishes no controller from human or agent", () => {
  render(<ComputerUseHeader controller={controller({ status: { ...status, permission: "deny", sessions: [status.sessions[2]] } })} />);
  expect(screen.getByText("Disabled")).toBeTruthy();
  expect(screen.getByText("0 active · 1 waiting")).toBeTruthy();
  expect(screen.getByText("No controller")).toBeTruthy();
});
it("keeps a stable stop accessible name during stopping and displays retry errors separately", () => {
  render(<ComputerUseHeader controller={controller({ stopping: true, stopError: "Could not verify stopped state. Retry Stop computer control." })} />);
  expect(screen.getByText("Stopping…")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Stop computer control" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Could not verify");
});

it.each([null, ...(["deny", "ask", "allow"] as const).map((permission) => ({ ...status, permission, sessions: [] }))])(
  "renders no strip or spacing for unused status %s, including errors; explicit viewing provides Stop without latching usage",
  (snapshot) => {
    const control = controller({ hasUsage: false, status: snapshot, statusError: "offline" });
    const { container, rerender } = render(<ComputerUseHeader controller={control} />);
    expect(container.innerHTML).toBe("");
    rerender(<ComputerUseHeader controller={control} viewOpen />);
    fireEvent.click(screen.getByRole("button", { name: "Stop computer control" }));
    expect(control.stopAll).toHaveBeenCalledTimes(1);
    rerender(<ComputerUseHeader controller={control} />);
    expect(container.innerHTML).toBe("");
    expect(control.beginMutation).not.toHaveBeenCalled();
  },
);

it.each([{ stopping: true }, { stopError: "Discovery failed. Retry Stop computer control." }])(
  "keeps unused closed-view Stop uncertainty visible (%s)",
  (uncertainty) => {
    const control = controller({ hasUsage: false, status: null, ...uncertainty });
    const { container, rerender } = render(<ComputerUseHeader controller={control} />);
    expect(screen.getByRole("button", { name: "Stop computer control" })).toBeTruthy();
    if (uncertainty.stopError) expect(screen.getByRole("alert").textContent).toContain("Retry Stop");
    rerender(<ComputerUseHeader controller={{ ...control, stopping: false, stopError: "" }} />);
    expect(container.innerHTML).toBe("");
  },
);
