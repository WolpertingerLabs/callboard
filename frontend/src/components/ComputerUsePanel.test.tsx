import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "shared/types/computerUse.js";
import ComputerUsePanel, { framePoint } from "./ComputerUsePanel";
import { computerUseClient as client } from "../api/computerUse";

vi.mock("../api/computerUse", () => ({
  computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() },
}));
let status: ComputerUseStatus;
const observation = {
  generation: 1,
  frameId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  frame: { data: "AA==", mimeType: "image/png" as const, width: 1000, height: 500 },
};
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
async function expand() {
  fireEvent.click(button("▸ Browser & Computer Control"));
  await waitFor(() => expect(button("Retry status").disabled).toBe(false));
}
beforeEach(() => {
  status = {
    permission: "allow",
    capabilities: [
      { kind: "browser", available: true },
      { kind: "native", available: false, reason: "No display. Configure a supported native display on the service host." },
    ],
    sessions: [{ id: "s1", kind: "browser", state: "active", controller: "agent", generation: 1 }],
  };
  vi.mocked(client.status).mockImplementation(async () => structuredClone(status));
  vi.mocked(client.observe).mockResolvedValue(observation);
  vi.mocked(client.open).mockResolvedValue({ session: status.sessions[0] });
  vi.mocked(client.control).mockImplementation(async (_chat, _id, operation) => {
    status.sessions[0].controller = operation === "takeover" ? "human" : "agent";
    if (operation === "revoke") status.sessions[0].state = "revoked";
    if (operation === "approve") status.sessions[0].state = "active";
  });
  vi.mocked(client.action).mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComputerUsePanel", () => {
  it("never enables or captures automatically and disables unavailable native targets", async () => {
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    expect(client.status).not.toHaveBeenCalled();
    await expand();
    expect(client.open).not.toHaveBeenCalled();
    expect(client.observe).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(button("Enable").disabled).toBe(true);
    expect(screen.getByText(/No display/)).toBeTruthy();
    expect(screen.getByText(/Same-machine native control/)).toBeTruthy();
  });

  it("keeps legacy/missing permission deny, with an actionable settings path", async () => {
    const onPermissions = vi.fn();
    render(<ComputerUsePanel chatId="c1" onPermissions={onPermissions} />);
    await expand();
    expect(button("Enable").disabled).toBe(true);
    expect(button("Refresh screenshot").disabled).toBe(true);
    fireEvent.click(button("Chat permissions"));
    expect(onPermissions).toHaveBeenCalled();
  });

  it("requires takeover and a fresh frame, then sends fenced manual actions", async () => {
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    expect((screen.getByRole("group", { name: /Manual input/ }) as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(button("Take over"));
    await waitFor(() => expect(button("Resume agent").disabled).toBe(false));
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    fireEvent.change(screen.getByLabelText("Text to type"), { target: { value: "hello" } });
    fireEvent.click(button("Type text"));
    await waitFor(() =>
      expect(client.action).toHaveBeenCalledWith(
        "c1",
        "s1",
        {
          action: { type: "type", text: "hello" },
          expectedGeneration: 1,
          frameId: observation.frameId,
          requestId: expect.any(String),
        },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(button("Resume agent").disabled).toBe(false));
    fireEvent.click(button("Resume agent"));
    await waitFor(() => expect(client.control).toHaveBeenLastCalledWith("c1", "s1", "resume", 1, expect.any(AbortSignal)));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each(["browser", "native"] as const)("ties the %s takeover privacy warning to Resume agent", async (kind) => {
    status.sessions[0].kind = kind;
    if (kind === "native") status.capabilities[1].available = true;
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    if (kind === "native") fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(button("Resume agent").hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText(/Resuming immediately captures/)).toBeNull();

    fireEvent.click(button("Take over"));
    await waitFor(() => expect(button("Resume agent").disabled).toBe(false));
    const resume = button("Resume agent");
    const warning = screen.getByText(/Resuming immediately captures/);
    expect(warning.getAttribute("role")).toBe("note");
    expect(resume.getAttribute("aria-describedby")).toBe(warning.id);
    expect(warning.textContent).toContain("new agent-visible screenshot");
    expect(warning.textContent).toContain(kind === "native" ? "full native desktop on the service host" : "managed browser page");
    expect(warning.textContent).not.toContain(kind === "native" ? "managed browser page" : "full native desktop");
    expect(warning.textContent).toContain("Remove sensitive windows or content from that target first");
    expect(warning.textContent).toContain("Previewing during takeover does not itself send those images to the agent");
    expect(client.observe).not.toHaveBeenCalled();

    fireEvent.click(resume);
    await waitFor(() => expect(screen.queryByText(/Resuming immediately captures/)).toBeNull());
    expect(button("Resume agent").hasAttribute("aria-describedby")).toBe(false);
  });

  it("offers explicit scoped approval for ask and clears revoked screenshots", async () => {
    status.permission = "ask";
    status.sessions[0].state = "awaiting_approval";
    render(<ComputerUsePanel chatId="c1" permission="ask" />);
    await expand();
    expect(button("Refresh screenshot").disabled).toBe(true);
    fireEvent.click(button("Approve this request"));
    await waitFor(() => expect(button("Refresh screenshot").disabled).toBe(false));
    expect(client.control).toHaveBeenCalledWith("c1", "s1", "approve", 1, expect.any(AbortSignal));
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    fireEvent.click(button("Revoke"));
    await waitFor(() => expect(button("Revoke").disabled).toBe(true));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("drops a late screenshot when the panel is closed", async () => {
    let resolve!: (value: typeof observation) => void;
    vi.mocked(client.observe).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    fireEvent.click(button("▾ Browser & Computer Control"));
    await act(async () => {
      resolve(observation);
    });
    expect(screen.queryByRole("img")).toBeNull();
    await expand();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("retains emergency stop/revoke when screenshot or status requests fail", async () => {
    vi.mocked(client.observe).mockRejectedValue(new Error("Capture consent revoked. Configure OS capture consent."));
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("alert");
    expect(button("Stop").disabled).toBe(false);
    expect(button("Revoke").disabled).toBe(false);
    expect(button("Enable").disabled).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("fences an in-flight capture when emergency stop supersedes it", async () => {
    let resolve!: (value: typeof observation) => void;
    vi.mocked(client.observe).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    fireEvent.click(button("Stop"));
    await waitFor(() => expect(client.control).toHaveBeenCalledWith("c1", "s1", "stop", 1, expect.any(AbortSignal)));
    await act(async () => {
      resolve(observation);
    });
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("requires explicit native selection and enable even when available", async () => {
    status.capabilities[1] = { kind: "native", available: true };
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(client.open).not.toHaveBeenCalled();
    fireEvent.click(button("Enable"));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith("c1", "native", expect.any(AbortSignal)));
  });

  it("discards stale generation frames permanently when status changes", async () => {
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    status.sessions[0].generation = 2;
    fireEvent.click(button("Retry status"));
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    await waitFor(() => expect(button("Retry status").disabled).toBe(false));
    status.sessions[0].generation = 1;
    fireEvent.click(button("Retry status"));
    await waitFor(() => expect(button("Retry status").disabled).toBe(false));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("hiding the screenshot cancels late captures without resuming the agent", async () => {
    let resolve!: (value: typeof observation) => void;
    vi.mocked(client.observe).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<ComputerUsePanel chatId="c1" permission="allow" />);
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    fireEvent.click(button("Hide screenshot"));
    await act(async () => {
      resolve(observation);
    });
    expect(screen.queryByRole("img")).toBeNull();
    expect(client.control).not.toHaveBeenCalled();
  });

  it("maps scaled screenshot coordinates and clamps edges", () => {
    expect(framePoint(260, 145, { left: 10, top: 20, width: 500, height: 250 }, 1000, 500)).toEqual({ x: 500, y: 250 });
    expect(framePoint(999, -10, { left: 10, top: 20, width: 500, height: 250 }, 1000, 500)).toEqual({ x: 999, y: 0 });
  });
});

it("uses the new capture token after an action and clears stale-frame errors without retrying", async () => {
  status.sessions[0].controller = "human";
  const nextFrameId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  vi.mocked(client.observe)
    .mockResolvedValueOnce(observation)
    .mockResolvedValue({ ...observation, frameId: nextFrameId });
  render(<ComputerUsePanel chatId="c1" permission="allow" />);
  await expand();
  fireEvent.click(button("Refresh screenshot"));
  await screen.findByRole("img");
  fireEvent.click(button("Enter"));
  await waitFor(() => expect(client.action).toHaveBeenCalledTimes(1));
  expect(vi.mocked(client.action).mock.calls[0][2].frameId).toBe(observation.frameId);
  await waitFor(() => expect(button("Resume agent").disabled).toBe(false));
  vi.mocked(client.action).mockRejectedValueOnce(new Error("stale_frame: capture again"));
  fireEvent.click(button("Enter"));
  await waitFor(() => expect(client.action).toHaveBeenCalledTimes(2));
  expect(vi.mocked(client.action).mock.calls[1][2].frameId).toBe(nextFrameId);
  await screen.findByText("stale_frame: capture again");
  expect(screen.queryByRole("img")).toBeNull();
  expect(client.action).toHaveBeenCalledTimes(2);
});
