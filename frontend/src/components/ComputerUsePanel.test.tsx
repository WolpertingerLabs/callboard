import { useState } from "react";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "shared/types/computerUse.js";
import type { PermissionLevel } from "shared/types/permissions.js";
import ComputerUsePanel, { framePoint } from "./ComputerUsePanel";
import { computerUseClient as client } from "../api/computerUse";
import { useComputerUseController } from "../hooks/useComputerUseController";

vi.mock("../api/computerUse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/computerUse")>()),
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

// The panel is only ever the chat's Computer view, fed by the chat's shared
// controller; "Switch view" unmounts and remounts it exactly as Chat.tsx does.
function Viewer({
  chatId = "c1",
  permission,
  provider,
  onPermissions,
  onRender,
}: {
  chatId?: string;
  permission?: PermissionLevel;
  provider?: string;
  onPermissions?: () => void;
  onRender?: (controller: ReturnType<typeof useComputerUseController>) => void;
}) {
  const [visible, setVisible] = useState(true);
  const controller = useComputerUseController(chatId, { viewOpen: visible });
  onRender?.(controller);
  return (
    <>
      <button onClick={() => setVisible(!visible)}>Switch view</button>
      {visible && !controller.stopping && (
        <ComputerUsePanel
          key={`${chatId}:${controller.viewerEpoch}`}
          chatId={chatId}
          permission={permission}
          provider={provider}
          onPermissions={onPermissions}
          controller={controller}
        />
      )}
    </>
  );
}
// The first shared status read has landed and rendered the session row.
const ready = () => screen.findByRole("button", { name: "Stop" });

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
  it("reads status once on load, never enables or captures automatically, and disables unavailable native targets", async () => {
    render(<Viewer permission="allow" />);
    await ready();
    expect(client.status).toHaveBeenCalledTimes(1);
    expect(client.open).not.toHaveBeenCalled();
    expect(client.observe).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(button("Enable").disabled).toBe(true);
    expect(screen.getByText(/No display/)).toBeTruthy();
    expect(screen.getByText(/Same-machine native control/)).toBeTruthy();
  });

  it("keeps legacy/missing permission deny, with an actionable settings path that states what each level does", async () => {
    const onPermissions = vi.fn();
    render(<Viewer onPermissions={onPermissions} />);
    await ready();
    expect(button("Enable").disabled).toBe(true);
    expect(button("Refresh screenshot").disabled).toBe(true);
    const denied = screen.getByText(/Computer control is denied/);
    expect(denied.textContent).toContain("Ask confirms each agent action with you in the chat; Allow lets the agent act unattended.");
    expect(denied.textContent).toContain("Either way, only your Enable click starts a target.");
    // The two facts a viewer mis-assumes stay on the panel itself; only the
    // rest of the explanation moved into the disclosure below them.
    const brief = screen.getByText(/Only you can enable a target/);
    expect(brief.closest("details")).toBeNull();
    expect(brief.textContent).toContain("Only you can enable a target — the agent never can, at any permission level.");
    expect(brief.textContent).toContain("Tools run on the configured service target, not on this viewer's computer.");
    const intro = screen.getByText(/Controls Callboard's browser and desktop tools/).textContent!;
    expect(intro).toContain("Allow lets the agent act on its own, while Ask stops its turn and asks you in the chat before each action.");
    expect(intro).not.toMatch(/agent enables/);
    fireEvent.click(button("Chat permissions"));
    expect(onPermissions).toHaveBeenCalled();
    // Nothing to consent to while it is denied, so the Enable note stays away.
    expect(screen.queryByRole("note", { name: "What Enable grants" })).toBeNull();
  });

  /**
   * The Enable click is the consent boundary for unattended control, and the
   * two levels produce identical panels otherwise. A chat someone else
   * configured — or you configured a month ago — must say which one it is at
   * the moment you click, not two screens away in Chat permissions.
   */
  it.each([
    ["allow", "This chat is set to Allow:", /acts on it without asking you again/],
    ["ask", "This chat is set to Ask:", /asks you here in the chat before every action/],
  ] as const)("says what Enable grants when the chat is %s", async (permission, heading, detail) => {
    status.permission = permission;
    render(<Viewer permission={permission} />);
    await ready();

    const note = screen.getByRole("note", { name: "What Enable grants" });
    expect(note.textContent).toContain(heading);
    expect(note.textContent).toMatch(detail);
    expect(note.textContent).not.toMatch(permission === "allow" ? /asks you/ : /without asking/);
    // At the moment of the decision: the same row as the button, never behind
    // the disclosure that holds the rest of the explanation.
    expect(note.closest("details")).toBeNull();
    const row = button("Enable").closest(".computer-use-toolbar");
    expect(row).toBeTruthy();
    expect(note.closest(".computer-use-toolbar")).toBe(row);
  });

  it("takes the level from the server, not from this tab's copy of the chat record", async () => {
    // A level changed in another tab (or by the human in Chat permissions)
    // reaches this panel through status first. Showing the stale prop here
    // would tell someone they are consenting to the opposite of what they are.
    status.permission = "allow";
    render(<Viewer permission="ask" />);
    await ready();

    expect(screen.getByRole("note", { name: "What Enable grants" }).textContent).toContain("This chat is set to Allow:");
  });

  it.each(["codex", "claude-code", "pi", undefined])(
    "explains the shared subagent grant for the engines whose subagents share the tool server (%s)",
    async (provider) => {
      // Claude Code Task subagents run in the same CLI process against the same
      // in-process server; Codex native subagents inherit the parent's per-turn
      // socket. Both act under the parent chat's identity, so both must be told.
      status.permission = "ask";
      status.sessions = [
        status.sessions[0],
        { id: "request", kind: "browser", state: "pending_approval", controller: null, generation: 0, reason: "Approve access to this target" },
      ];
      render(<Viewer permission="ask" provider={provider} />);
      await ready();
      const note = screen.queryByText(/shared with any subagents the agent runs inside this chat's turn/);
      if (provider !== "codex" && provider !== "claude-code") {
        expect(note).toBeNull();
        expect(button("Enable").hasAttribute("aria-describedby")).toBe(false);
        expect(button("Confirm request").hasAttribute("aria-describedby")).toBe(false);
        return;
      }
      expect(note!.getAttribute("role")).toBe("note");
      // Demoted, but not inside the disclosure: a closed <details> takes the
      // description these buttons point at out of the accessibility tree.
      expect(note!.closest("details")).toBeNull();
      expect(note!.textContent).toContain(provider === "codex" ? "Codex native subagents" : "Claude Code Task subagents");
      expect(note!.textContent).toContain("recorded under this chat's identity");
      // Both places a human grants access point at the same note.
      expect(button("Enable").getAttribute("aria-describedby")).toBe(note!.id);
      expect(button("Confirm request").getAttribute("aria-describedby")).toBe(note!.id);
    },
  );

  it("requires takeover and a fresh frame, then sends fenced manual actions", async () => {
    render(<Viewer permission="allow" />);
    await ready();
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
    render(<Viewer permission="allow" />);
    await ready();
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
    render(<Viewer permission="ask" />);
    await ready();
    expect(button("Refresh screenshot").disabled).toBe(true);
    fireEvent.click(button("Approve this request"));
    await waitFor(() => expect(button("Refresh screenshot").disabled).toBe(false));
    // An accepted approval is never aborted by this view: the shared ledger must learn its result.
    expect(client.control).toHaveBeenCalledWith("c1", "s1", "approve", 1, undefined);
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    fireEvent.click(button("Revoke"));
    await waitFor(() => expect(button("Revoke").disabled).toBe(true));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("drops a late screenshot when the view is closed", async () => {
    let resolve!: (value: typeof observation) => void;
    vi.mocked(client.observe).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<Viewer permission="allow" />);
    await ready();
    fireEvent.click(button("Refresh screenshot"));
    fireEvent.click(button("Switch view"));
    await act(async () => {
      resolve(observation);
    });
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(button("Switch view"));
    await ready();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("retains emergency stop/revoke when screenshot or status requests fail", async () => {
    vi.mocked(client.observe).mockRejectedValue(new Error("Capture consent revoked. Configure OS capture consent."));
    render(<Viewer permission="allow" />);
    await ready();
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
    render(<Viewer permission="allow" />);
    await ready();
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
    render(<Viewer permission="allow" />);
    await ready();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(client.open).not.toHaveBeenCalled();
    fireEvent.click(button("Enable"));
    // A server-accepted open cannot be cancelled by aborting its fetch, so none is passed.
    await waitFor(() => expect(client.open).toHaveBeenCalledWith("c1", "native"));
  });

  it("discards stale generation frames permanently when status changes", async () => {
    render(<Viewer permission="allow" />);
    await ready();
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
    render(<Viewer permission="allow" />);
    await ready();
    fireEvent.click(button("Refresh screenshot"));
    fireEvent.click(button("Hide screenshot"));
    await act(async () => {
      resolve(observation);
    });
    expect(screen.queryByRole("img")).toBeNull();
    expect(client.control).not.toHaveBeenCalled();
  });

  it.each(["click", "drag"] as const)("keeps a %s press across a status poll that changes nothing", async (mode) => {
    status.sessions[0].controller = "human";
    let controller!: ReturnType<typeof useComputerUseController>;
    render(<Viewer permission="allow" onRender={(value) => (controller = value)} />);
    await ready();
    fireEvent.click(button("Refresh screenshot"));
    const img = await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    if (mode === "drag") fireEvent.change(screen.getByLabelText("Pointer"), { target: { value: "drag" } });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;
    fireEvent.pointerDown(img, { clientX: 100, clientY: 50, pointerId: 1 });
    // The shared poller republishes an identical status mid-press.
    await act(async () => {
      await controller.readStatus();
    });
    fireEvent.pointerUp(img, { clientX: 300, clientY: 50, pointerId: 1 });
    await waitFor(() => expect(client.action).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.action).mock.calls[0][2].action).toEqual(
      mode === "drag" ? { type: "drag", fromX: 100, fromY: 50, toX: 300, toY: 50 } : { type: "click", x: 300, y: 50, button: "left" },
    );
  });

  it("opens on the live session, not an older stopped one still listed in status", async () => {
    status.sessions = [
      { id: "old", kind: "browser", state: "stopped", controller: null, generation: 3 },
      { id: "live", kind: "browser", state: "ready", controller: "agent", generation: 1 },
    ];
    render(<Viewer permission="allow" />);
    await ready();
    expect((screen.getByLabelText("Session") as HTMLSelectElement).value).toBe("live");
    expect(screen.getByText(/State: ready · Controller: agent/)).toBeTruthy();
    expect(button("Take over").disabled).toBe(false);
    expect(button("Refresh screenshot").disabled).toBe(false);
    // An explicit choice of the stopped session is still honoured.
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "old" } });
    expect(screen.getByText(/State: stopped · Controller: none/)).toBeTruthy();
    expect(button("Stop").disabled).toBe(true);
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
  render(<Viewer permission="allow" />);
  await ready();
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
  let view = render(<Viewer chatId="real-preview" permission="allow" />);
  try {
    await ready();
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
      view = render(<Viewer chatId="real-preview" permission="allow" />);
      await ready();
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
  const view = render(<Viewer chatId="real-stale" permission="allow" />);
  try {
    await ready();
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
  const view = render(<Viewer chatId="real-emergency" permission="allow" />);
  try {
    await ready();
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

it("does not dispatch an unaccepted queued preview after the new view closes", async () => {
  const fixture = await serviceViewer(true);
  let view = render(<Viewer chatId="real-queued-preview" permission="allow" />);
  try {
    await ready();
    fireEvent.click(button("Refresh screenshot"));
    await screen.findByRole("img");
    await waitFor(() => expect(manualInput().disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: /Live preview/ }));
    await waitFor(() => expect(fixture.captureCount()).toBe(2));
    view.unmount();
    view = render(<Viewer chatId="real-queued-preview" permission="allow" />);
    await ready();
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

describe("desktop readiness guidance", () => {
  it.each([
    ["setup-required", "Desktop setup required", /Ask your agent in chat/],
    ["unsupported", "Desktop environment unsupported", /compatible native driver/],
    ["permission-blocked", "Desktop permissions required", /file, network, and code/],
    ["unknown", "Desktop readiness unconfirmed", /Retry status to check/],
    [undefined, "Desktop readiness unconfirmed", /Retry status to check/],
    ["future-classification", "Desktop readiness unconfirmed", /Retry status to check/],
  ])("renders passive, escaped guidance for %s", async (readiness, heading, guidance) => {
    const onPermissions = vi.fn();
    status.sessions = [];
    status.capabilities[1] = { kind: "native", available: false, reason: "<img src=x onerror=alert(1)> unsupported DISPLAY", ...({ readiness } as object) };
    render(<Viewer permission="allow" onPermissions={onPermissions} />);
    await waitFor(() => expect(button("Enable").disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(screen.getByRole("heading", { name: heading as string })).toBeTruthy();
    expect(screen.getByText(guidance as RegExp)).toBeTruthy();
    expect(screen.getByText(status.capabilities[1].reason!)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(button("Enable").disabled).toBe(true);
    fireEvent.click(button("Enable"));
    expect(client.open).not.toHaveBeenCalled();
    expect(client.control).not.toHaveBeenCalled();
    expect(client.action).not.toHaveBeenCalled();
    expect(client.observe).not.toHaveBeenCalled();
    expect(onPermissions).not.toHaveBeenCalled();
    expect(screen.queryByText(/Choose a target above and enable it/)).toBeNull();
  });
  it("shows only the denied notice rather than a setup diagnosis", async () => {
    status.capabilities[1] = { kind: "native", available: false, readiness: "setup-required", reason: "No display" };
    render(<Viewer permission="deny" />);
    await ready();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(screen.getByText(/Computer control is denied/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Desktop setup/ })).toBeNull();
    expect(screen.queryByText("No display")).toBeNull();
  });
  it("does not diagnose during loading or change available desktop behavior", async () => {
    vi.mocked(client.status).mockReturnValue(new Promise(() => {}));
    const view = render(<Viewer permission="allow" />);
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(screen.getByRole("heading", { name: "Desktop readiness unconfirmed" })).toBeTruthy();
    expect(button("Enable").disabled).toBe(true);
    view.unmount();
    status.capabilities[1] = { kind: "native", available: true };
    vi.mocked(client.status).mockResolvedValue(status);
    render(<Viewer permission="allow" />);
    await ready();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "native" } });
    expect(screen.queryByRole("heading", { name: /Desktop readiness/ })).toBeNull();
    expect(button("Enable").disabled).toBe(false);
    fireEvent.click(button("Enable"));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith("c1", "native"));
  });
});
