import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
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
const manualInput = () => screen.getByRole("group", { name: /Manual input/ }) as HTMLFieldSetElement;
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
    await waitFor(() => expect(button("Refresh screenshot").disabled).toBe(false));
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

  it("hiding the screenshot discards late captures without resuming the agent", async () => {
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

// Real service queue/token semantics; the route does not forward fetch abort to
// service.observe, so deliberately ignore the client signal in this fixture.
async function serviceViewer(holdSecondCapture = false) {
  const owner = { ownerId: "viewer-regression", actorId: "agent", role: "agent" as const };
  const human = { ...owner, actorId: "human", role: "human" as const };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captures = 0;
  const mutation = vi.fn(async () => {});
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({
      observe: async () => {
        if (++captures === 2 && holdSecondCapture) await held;
        return { data: "AA==", mimeType: "image/png", width: 1000, height: 500, capturedAt: Date.now() };
      },
      act: mutation,
      close: async () => {},
      releaseInput: async () => {},
    }),
  };
  const service = new ComputerUseService({ authorize: () => "allow", targets: [{ id: "browser", enabled: true, driver }] });
  const opened = await service.open(owner, "browser");
  const lease = await service.takeover(human, { sessionId: opened.sessionId, generation: opened.generation });
  const ref = { sessionId: lease.sessionId, generation: lease.generation };
  vi.mocked(client.status).mockImplementation(async () => ({
    permission: "allow",
    capabilities: [{ kind: "browser", available: true }],
    sessions: service.status(human).map((item) => ({
      id: item.sessionId,
      kind: "browser",
      state: item.state,
      controller: item.controller === "none" ? null : item.controller,
      generation: item.generation,
    })),
  }));
  vi.mocked(client.observe).mockImplementation(async () => service.observe(human, ref));
  vi.mocked(client.action).mockImplementation(async (_chat, _id, request) => {
    try {
      return await service.act(human, {
        ...ref,
        leaseId: lease.leaseId,
        frameId: request.frameId,
        actionId: request.requestId,
        action: request.action as Parameters<typeof service.act>[1]["action"],
      });
    } catch (error) {
      // The HTTP adapter exposes a message rather than structured service codes.
      throw new Error((error as { code: string }).code);
    }
  });
  vi.mocked(client.control).mockImplementation(async (_chat, id, operation) => {
    if (operation === "stop") await service.stop(human, id);
    else if (operation === "revoke") await service.revoke(human, id);
  });
  return { service, human, ref, mutation, release, captureCount: () => captures };
}

it.each(["pause", "hide", "remount"] as const)("fences a pending preview through %s before acquiring new manual authority", async (mode) => {
  const fixture = await serviceViewer(true);
  let view = render(<ComputerUsePanel chatId="real-preview" permission="allow" />);
  try {
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: /Live preview/ }));
    await waitFor(() => expect(fixture.captureCount()).toBe(2));
    expect(manualInput().disabled).toBe(true);
    expect(screen.getByText(/Capturing screenshot… Manual input is paused/)).toBeTruthy();
    fireEvent.click(button("Enter"));
    expect(client.action).not.toHaveBeenCalled();
    expect(button("Stop").disabled).toBe(false);
    expect(button("Revoke").disabled).toBe(false);

    if (mode === "pause") fireEvent.click(screen.getByRole("checkbox", { name: /Live preview/ }));
    else if (mode === "hide") fireEvent.click(button("Hide screenshot"));
    else {
      view.unmount();
      view = render(<ComputerUsePanel chatId="real-preview" permission="allow" />);
      await expand();
    }
    fireEvent.click(button("Refresh screenshot"));
    expect(vi.mocked(client.observe).mock.calls[1][2]?.aborted).toBe(false);
    // No new HTTP observation may overtake the accepted held capture.
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.observe).toHaveBeenCalledTimes(2);
    expect(manualInput().disabled).toBe(true);
    await act(async () => {
      fixture.release();
    });
    await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    expect(fixture.captureCount()).toBe(3);
    fireEvent.click(button("Enter"));
    await waitFor(() => expect(fixture.mutation).toHaveBeenCalledTimes(1));
    expect(fixture.service.status(fixture.human)[0].state).toBe("ready");
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(button("Resume agent").disabled).toBe(false));
  } finally {
    fixture.release();
    view.unmount();
    await fixture.service.dispose();
  }
});

it("recovers a real stale-frame rejection without denying authorized refresh or replaying the action", async () => {
  const fixture = await serviceViewer();
  const view = render(<ComputerUsePanel chatId="real-stale" permission="allow" />);
  try {
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    // A second human viewer supersedes the displayed token without changing the lease.
    await fixture.service.observe(fixture.human, fixture.ref);
    fireEvent.click(button("Enter"));
    await screen.findByText("stale_frame");
    await waitFor(() => expect(button("Refresh screenshot").disabled).toBe(false));
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(client.action).toHaveBeenCalledTimes(1);
    expect(fixture.service.status(fixture.human)[0].state).toBe("ready");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/Computer control is denied/)).toBeNull();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    fireEvent.click(button("Enter"));
    await waitFor(() => expect(fixture.mutation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button("Resume agent").disabled).toBe(false));
  } finally {
    view.unmount();
    await fixture.service.dispose();
  }
});

it.each(["stop", "revoke"] as const)("keeps emergency %s immediate while an accepted preview is held", async (operation) => {
  const fixture = await serviceViewer(true);
  const view = render(<ComputerUsePanel chatId="real-emergency" permission="allow" />);
  try {
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: /Live preview/ }));
    await waitFor(() => expect(fixture.captureCount()).toBe(2));
    fireEvent.click(button(operation === "stop" ? "Stop" : "Revoke"));
    await waitFor(() => expect(fixture.service.status(fixture.human)[0].state).toBe(operation === "stop" ? "stopped" : "revoked"));
    expect(fixture.mutation).not.toHaveBeenCalled();
    await act(async () => {
      fixture.release();
    });
    await waitFor(() => expect(button("Retry status").disabled).toBe(false));
    expect(screen.queryByRole("img")).toBeNull();
    expect(button("Refresh screenshot").disabled).toBe(true);
  } finally {
    fixture.release();
    view.unmount();
    await fixture.service.dispose();
  }
});

it("does not dispatch an unaccepted queued preview after the new panel closes", async () => {
  const fixture = await serviceViewer(true);
  let view = render(<ComputerUsePanel chatId="real-queued-preview" permission="allow" />);
  try {
    await expand();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: /Live preview/ }));
    await waitFor(() => expect(fixture.captureCount()).toBe(2));
    view.unmount();
    view = render(<ComputerUsePanel chatId="real-queued-preview" permission="allow" />);
    await expand();
    fireEvent.click(screen.getByRole("checkbox", { name: /Live preview/ }));
    // The new preview is queued behind B, but has not reached the server.
    expect(client.observe).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      fixture.release();
    });
    expect(client.observe).toHaveBeenCalledTimes(2);
    expect(fixture.captureCount()).toBe(2);
  } finally {
    fixture.release();
    view.unmount();
    await fixture.service.dispose();
  }
});

/**
 * The collapsed heading's background is a CSS contract, not a component one.
 *
 * `index.css`'s global reset clears a button's border but not its background,
 * so a `<button>` with no `background` declaration paints the user agent's
 * `buttonface` — #efefef in Chrome. The heading is the full width of the panel
 * and sits directly above the composer, so on a phone in dark mode that read as
 * a light band of unstyled whitespace jammed into the chat view, with --text
 * over it at roughly 1.1:1.
 *
 * jsdom applies no stylesheet and resolves no user-agent defaults, so there is
 * nothing to assert on a rendered node — `getComputedStyle` reports the empty
 * string either way, which is exactly what it reported while the bug was live.
 * The stylesheet is what has to be checked, so the stylesheet is what is read.
 */
describe("the collapsed heading's stylesheet contract", () => {
  // Not `new URL(..., import.meta.url)`: Vite rewrites that into an asset
  // reference, and the http URL it returns is not openable by fs.
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ComputerUsePanel.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const heading = /\.computer-use-heading\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("declares a background so the rule never falls through to buttonface", () => {
    expect(heading).not.toBe("");
    expect(/(^|;)\s*background(-color)?\s*:/.test(heading)).toBe(true);
  });

  it("takes the panel's own surface rather than painting a fill of its own", () => {
    // `transparent` is the whole point: .computer-use-panel already sets
    // `background: var(--surface)`, so the heading reads as that panel's header
    // in either theme without naming a second colour that could drift from it.
    expect(/(^|;)\s*background\s*:\s*transparent\s*(;|$)/.test(heading)).toBe(true);
  });
});
