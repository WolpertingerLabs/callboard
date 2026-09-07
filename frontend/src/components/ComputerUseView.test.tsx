import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "shared/types/computerUse.js";
import { computerUseClient as client } from "../api/computerUse";
import { useComputerUseController } from "../hooks/useComputerUseController";
import ComputerUseHeader from "./ComputerUseHeader";
import ComputerUsePanel from "./ComputerUsePanel";

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
let status: ComputerUseStatus;
function Harness({ id = "c1" }: { id?: string }) {
  const controller = useComputerUseController(id || undefined);
  const [visible, setVisible] = useState(false);
  return (
    <>
      <ComputerUseHeader controller={controller} />
      <button onClick={() => setVisible(!visible)}>Switch view</button>
      {visible && id && !controller.stopping && (
        <ComputerUsePanel key={`${id}:${controller.viewerEpoch}`} chatId={id} permission="allow" dedicated controller={controller} />
      )}
    </>
  );
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
beforeEach(() => {
  status = {
    permission: "allow",
    capabilities: [{ kind: "browser", available: true }],
    sessions: [
      { id: "s1", kind: "browser", state: "active", controller: "human", generation: 1 },
      { id: "s2", kind: "native", state: "awaiting_approval", controller: null, generation: 0 },
    ],
  };
  vi.mocked(client.status).mockImplementation(async () => structuredClone(status));
  vi.mocked(client.control).mockImplementation(async (_chat, id) => {
    const session = status.sessions.find((s) => s.id === id)!;
    session.state = "stopped";
    return structuredClone(session);
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
it("polls status only with hidden waiting badges and opens a full viewer without an Expand step or a second poller", async () => {
  vi.useFakeTimers();
  render(<Harness />);
  await act(async () => {});
  expect(screen.getByText(/1 active · 1 waiting/)).toBeTruthy();
  expect(screen.queryByLabelText("Target")).toBeNull();
  click("Switch view");
  expect(screen.getByLabelText("Target")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /▸/ })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(client.status).toHaveBeenCalledTimes(2);
  click("Switch view");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(client.status).toHaveBeenCalledTimes(3);
  expect(client.open).not.toHaveBeenCalled();
  expect(client.observe).not.toHaveBeenCalled();
  expect(client.control).not.toHaveBeenCalled();
});
it("stops all browser/native and pending sessions without confirmation, even when denied and status fails; exposes partial errors and retry", async () => {
  render(<Harness />);
  await screen.findByText(/1 active · 1 waiting/);
  status.permission = "deny";
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  vi.mocked(client.control).mockImplementation(async (_chat, id) => {
    if (id === "s2") throw new Error("native unavailable");
    return { id, state: "stopped" };
  });
  click("Stop computer control");
  await screen.findByRole("alert");
  expect(client.control).toHaveBeenCalledWith("c1", "s1", "stop", 1);
  expect(client.control).toHaveBeenCalledWith("c1", "s2", "stop", 0);
  expect(screen.getByRole("alert").textContent).toContain("native unavailable");
  expect(screen.getByText(/status unavailable \(last known\)/).textContent).toContain("0 active · 1 waiting");
  vi.mocked(client.status).mockImplementation(async () => ({ ...status, sessions: [] }));
  click("Stop computer control");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
it("dispatches known stops without waiting for discovery or screenshot and never presents late capture after view remount", async () => {
  let resolveCapture!: (value: Awaited<ReturnType<typeof client.observe>>) => void;
  vi.mocked(client.observe).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveCapture = resolve;
      }) as ReturnType<typeof client.observe>,
  );
  render(<Harness />);
  await screen.findByText(/1 active · 1 waiting/);
  click("Switch view");
  click("Refresh screenshot");
  await waitFor(() => expect(client.observe).toHaveBeenCalledTimes(1));
  click("Switch view");
  click("Switch view");
  expect(screen.queryByRole("img")).toBeNull();
  click("Stop computer control");
  expect(client.control).toHaveBeenCalledTimes(2);
  await act(async () =>
    resolveCapture({ generation: 1, frameId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", frame: { data: "AA==", mimeType: "image/png", width: 10, height: 10 } }),
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(client.observe).toHaveBeenCalledTimes(1);
});
it("drops text and preview on view change, and never restarts preview on return", async () => {
  vi.mocked(client.observe).mockResolvedValue({
    generation: 1,
    frameId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    frame: { data: "AA==", mimeType: "image/png", width: 10, height: 10 },
  });
  render(<Harness />);
  await screen.findByText(/1 active · 1 waiting/);
  click("Switch view");
  fireEvent.click(screen.getByLabelText(/Live preview/));
  await screen.findByRole("img");
  fireEvent.change(screen.getByLabelText("Text to type"), { target: { value: "secret" } });
  click("Switch view");
  click("Switch view");
  expect(screen.queryByRole("img")).toBeNull();
  expect((screen.getByLabelText("Text to type") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText(/Live preview/) as HTMLInputElement).checked).toBe(false);
});
it("fences old route discovery/actions and never sends an old controller stop to a new chat ID", async () => {
  let resolveStatus!: (value: ComputerUseStatus) => void;
  render(<Harness />).unmount();
  const view = render(<Harness />);
  await screen.findByText(/1 active · 1 waiting/);
  vi.mocked(client.status).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
  );
  click("Stop computer control");
  vi.mocked(client.status).mockResolvedValue({ ...status, sessions: [] });
  view.rerender(<Harness id="c2" />);
  await screen.findByText(/0 active · 0 waiting/);
  await act(async () => resolveStatus({ ...status, sessions: [{ id: "late", kind: "native", controller: "agent", state: "active", generation: 1 }] }));
  expect(client.control).toHaveBeenCalledWith("c1", "late", "stop", 1);
  expect(vi.mocked(client.control).mock.calls.every(([id]) => id === "c1")).toBe(true);
  expect(screen.getByText(/0 active · 0 waiting/)).toBeTruthy();
});
it("reports background status failure truthfully and keeps emergency stop available without any observation", async () => {
  vi.useFakeTimers();
  render(<Harness />);
  await act(async () => {});
  vi.mocked(client.status).mockRejectedValue(new Error("disconnected"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByText(/status unavailable \(last known\)/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Stop computer control" }) as HTMLButtonElement).disabled).toBe(false);
  expect(client.observe).not.toHaveBeenCalled();
  expect(client.open).not.toHaveBeenCalled();
});
it("does not let a late old-chat status response populate the new chat header", async () => {
  let resolve!: (value: ComputerUseStatus) => void;
  vi.mocked(client.status).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<Harness />);
  vi.mocked(client.status).mockResolvedValue({ ...status, sessions: [] });
  view.rerender(<Harness id="c2" />);
  await screen.findByText(/0 active · 0 waiting/);
  await act(async () => resolve(status));
  expect(screen.getByText(/0 active · 0 waiting/)).toBeTruthy();
  expect(screen.queryByText(/1 active · 1 waiting/)).toBeNull();
});
