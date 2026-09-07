import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "shared/types/computerUse.js";
import { computerUseClient as client } from "../api/computerUse";
import { useComputerUseController } from "../hooks/useComputerUseController";
import ComputerUseHeader from "./ComputerUseHeader";
import ComputerUsePanel from "./ComputerUsePanel";

vi.mock("../api/computerUse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/computerUse")>()),
  computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() },
}));
let status: ComputerUseStatus;
function Harness({ id = "c1", onRender }: { id?: string; onRender?: (controller: ReturnType<typeof useComputerUseController>) => void }) {
  const controller = useComputerUseController(id || undefined);
  const [visible, setVisible] = useState(false);
  onRender?.(controller);
  return (
    <>
      <ComputerUseHeader controller={controller} viewOpen={visible} />
      <button onClick={() => setVisible(!visible)}>Switch view</button>
      {visible && id && !controller.stopping && (
        <ComputerUsePanel key={`${id}:${controller.viewerEpoch}`} chatId={id} permission="allow" controller={controller} />
      )}
    </>
  );
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const summary = () => screen.getByRole("status", { name: /^Browser & Computer Control/ });
function expectIdle() {
  expect(screen.getByText("Idle")).toBeTruthy();
  expect(summary().getAttribute("aria-label")).toContain("0 active · 0 waiting for approval");
}

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
  expect(screen.getByText("Last known")).toBeTruthy();
  expect(summary().getAttribute("aria-label")).toContain("Status unavailable (last known)");
  expect(screen.getByText("0 active · 1 waiting")).toBeTruthy();
  vi.mocked(client.status).mockImplementation(async () => ({ ...status, sessions: [] }));
  vi.mocked(client.control).mockImplementation(async (_chat, id) => ({ id, state: "stopped" }));
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
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Stop computer control" })).toBeNull();
  await act(async () => resolveStatus({ ...status, sessions: [{ id: "late", kind: "native", controller: "agent", state: "active", generation: 1 }] }));
  expect(client.control).toHaveBeenCalledWith("c1", "late", "stop", 1);
  expect(vi.mocked(client.control).mock.calls.every(([id]) => id === "c1")).toBe(true);
  expect(screen.queryByRole("button", { name: "Stop computer control" })).toBeNull();
});
it("reports background status failure truthfully and keeps emergency stop available without any observation", async () => {
  vi.useFakeTimers();
  render(<Harness />);
  await act(async () => {});
  vi.mocked(client.status).mockRejectedValue(new Error("disconnected"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByText("Last known")).toBeTruthy();
  expect(summary().getAttribute("aria-label")).toContain("Status unavailable (last known)");
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
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Stop computer control" })).toBeNull();
  await act(async () => resolve(status));
  expect(screen.queryByRole("button", { name: "Stop computer control" })).toBeNull();
  expect(screen.queryByText(/1 active · 1 waiting/)).toBeNull();
});

// Permanent reproduction: viewer Retry used to bypass the shared poll revision
// fence and republish an older status after a newer status/error had arrived.
it.each(["stopped", "new pending", "connection lost"] as const)(
  "fences a late viewer status success and failure after newer shared authority: %s",
  async (newer) => {
    vi.useFakeTimers();
    render(<Harness />);
    await act(async () => {});
    const stale = structuredClone(status);
    click("Switch view");
    const oldRead = deferred<ComputerUseStatus>();
    vi.mocked(client.status).mockImplementationOnce(() => oldRead.promise);
    click("Retry status");
    await act(async () => {});
    if (newer === "connection lost") vi.mocked(client.status).mockRejectedValue(new Error("offline"));
    else {
      status = {
        ...status,
        capabilities: [],
        sessions: newer === "stopped" ? [] : [{ id: "new-emergency-id", kind: "native", state: "awaiting_approval", controller: null, generation: 0 }],
      };
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const header = summary().getAttribute("aria-label");
    await act(async () => oldRead.resolve(stale));
    expect(summary().getAttribute("aria-label")).toBe(header);
    expect((screen.getByRole("button", { name: "Enable" }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.status).toHaveBeenCalledTimes(3);

    // Repeat with a late error: it must neither replace the newer state/error
    // nor trigger an automatic recovery request that supersedes newer authority.
    const oldFailure = deferred<ComputerUseStatus>();
    vi.mocked(client.status).mockImplementationOnce(() => oldFailure.promise);
    click("Retry status");
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => oldFailure.reject(new Error("old failure")));
    expect(summary().getAttribute("aria-label")).toBe(header);
    expect(client.status).toHaveBeenCalledTimes(5);
    if (newer === "new pending") {
      click("Stop computer control");
      expect(client.control).toHaveBeenCalledWith("c1", "new-emergency-id", "stop", 0);
      // Real sessions survive absence; generation-zero request IDs can expire
      // silently and are retired only by the authoritative missing snapshot.
      expect(client.control).toHaveBeenCalledWith("c1", "s1", "stop", 1);
      expect(vi.mocked(client.control).mock.calls.some(([, id]) => id === "s2")).toBe(false);
      await act(async () => {});
    }
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("preserves a post-mutation response and ordered refresh against an older pending poll", async () => {
  vi.useFakeTimers();
  status.sessions[0].controller = "agent";
  render(<Harness />);
  await act(async () => {});
  click("Switch view");
  const stale = structuredClone(status);
  const poll = deferred<ComputerUseStatus>();
  const postMutation = deferred<ComputerUseStatus>();
  vi.mocked(client.status)
    .mockImplementationOnce(() => poll.promise)
    .mockImplementationOnce(() => postMutation.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  vi.mocked(client.control).mockImplementationOnce(async () => {
    status.sessions[0] = { ...status.sessions[0], controller: "human", generation: 2 };
    return structuredClone(status.sessions[0]);
  });
  click("Take over");
  await act(async () => {});
  expect(summary().getAttribute("aria-label")).toContain("controllers: agent 0 / human 1");
  expect(screen.getByText("Human 1")).toBeTruthy();
  await act(async () => poll.resolve(stale));
  expect(summary().getAttribute("aria-label")).toContain("controllers: agent 0 / human 1");
  expect(screen.getByText("Human 1")).toBeTruthy();
  await act(async () => postMutation.resolve(structuredClone(status)));
  expect((screen.getByRole("button", { name: "Resume agent" }) as HTMLButtonElement).disabled).toBe(false);
  expect(client.observe).not.toHaveBeenCalled();
});

// Permanent emergency-stop reproductions. No transport settlement is assumed:
// both status and control can hang forever, and old results can arrive after retry.
it.each(["status", "control", "both", "both then route change"] as const)(
  "bounds never-resolving %s waits, exposes failures, resumes polling/viewer, and fences late results after retry",
  async (hung) => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    await act(async () => {});
    click("Switch view");
    const stale = structuredClone(status);
    const reads: ReturnType<typeof deferred<ComputerUseStatus>>[] = [];
    const stops: ReturnType<typeof deferred<unknown>>[] = [];
    if (hung !== "control")
      vi.mocked(client.status).mockImplementation(() => {
        const read = deferred<ComputerUseStatus>();
        reads.push(read);
        return read.promise;
      });
    vi.mocked(client.control).mockImplementation(() => {
      if (hung === "status") return Promise.reject(new Error("known stop failed"));
      const stop = deferred<unknown>();
      stops.push(stop);
      return stop.promise;
    });
    click("Stop computer control");
    expect(client.control).toHaveBeenCalledTimes(2); // Before discovery settles.
    await act(async () => {});
    if (hung === "status") expect(screen.getByRole("alert").textContent).toContain("known stop failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect((screen.getByRole("button", { name: "Stop computer control" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole("alert").some((alert) => /Retry Stop computer control/.test(alert.textContent ?? ""))).toBe(true);
    if (hung !== "status") expect(screen.getAllByRole("alert").some((alert) => /timed out/.test(alert.textContent ?? ""))).toBe(true);
    expect(screen.getByLabelText("Target")).toBeTruthy(); // Viewer no longer pinned unavailable.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(vi.mocked(client.status).mock.calls.length).toBeGreaterThan(3); // Polling recovered.

    // Retry is independent of every old unresolved request. No abort signals
    // were sent to stop; a UI deadline makes no server-cancellation claim.
    expect(vi.mocked(client.control).mock.calls.every((args) => args[4] === undefined)).toBe(true);
    vi.mocked(client.status).mockImplementation(async () => structuredClone(status));
    vi.mocked(client.control).mockImplementation(async (_chat, id) => {
      const session = status.sessions.find((item) => item.id === id)!;
      session.state = "stopped";
      return structuredClone(session);
    });
    const chatId = hung === "both then route change" ? "c2" : "c1";
    if (chatId === "c2") {
      view.rerender(<Harness id="c2" />);
      await act(async () => {});
    }
    click("Stop computer control");
    await act(async () => {});
    expectIdle();
    expect(screen.queryByRole("alert")).toBeNull();
    const callsAfterRetry = vi.mocked(client.control).mock.calls.length;
    await act(async () => {
      for (const [index, read] of reads.entries()) {
        if (index % 2) read.reject(new Error("late old status failure"));
        else read.resolve(stale);
      }
      for (const [index, stop] of stops.entries()) {
        if (index % 2) stop.reject(new Error("late old stop failure"));
        else stop.resolve({ ...stale.sessions[0], generation: 99 });
      }
    });
    expectIdle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.control).toHaveBeenCalledTimes(callsAfterRetry);
    expect(
      vi
        .mocked(client.control)
        .mock.calls.slice(2)
        .every(([id, , operation]) => id === chatId && operation === "stop"),
    ).toBe(true);
    expect(client.open).not.toHaveBeenCalled();
    expect(client.observe).not.toHaveBeenCalled();
  },
);

const openedSession = { id: "late-open", kind: "browser" as const, state: "active", controller: "agent" as const, generation: 1 };

// Exact review reproduction: a zero-session poll wins display authority while
// Enable is pending. Its later successful response must still teach Stop the ID.
it.each(["open viewer", "closed viewer", "newer status error"] as const)(
  "retains a successfully opened emergency ID independently of stale display authority: %s",
  async (mode) => {
    vi.useFakeTimers();
    status.sessions = [];
    render(<Harness />);
    await act(async () => {});
    click("Switch view");
    const open = deferred<{ session: typeof openedSession }>();
    vi.mocked(client.open).mockReturnValueOnce(open.promise);
    click("Enable");
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expectIdle();
    vi.mocked(client.status).mockRejectedValue(new Error("offline after empty poll"));
    if (mode === "closed viewer") click("Switch view");
    if (mode !== "open viewer") {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      if (mode === "closed viewer") expect(screen.queryByText("Last known")).toBeNull();
      else expect(screen.getByText("Last known")).toBeTruthy();
    }
    await act(async () => open.resolve({ session: openedSession }));
    expect(screen.getByText("Last known")).toBeTruthy();
    expect(summary().getAttribute("aria-label")).toContain("0 active · 0 waiting for approval");
    expect(summary().getAttribute("aria-label")).toContain("Status unavailable (last known)");
    if (mode !== "closed viewer") expect((screen.getByRole("button", { name: "Enable" }) as HTMLButtonElement).disabled).toBe(true);
    // An accepted open remains observable by the shared ledger on viewer close;
    // aborting its fetch would lose the only acknowledgement of its session ID.
    expect(vi.mocked(client.open).mock.calls[0][2]).toBeUndefined();
    vi.mocked(client.control).mockResolvedValue({ id: openedSession.id, state: "stopped" });
    click("Stop computer control");
    expect(client.control).toHaveBeenCalledWith("c1", openedSession.id, "stop", 1);
    await act(async () => {});
    expect(summary().getAttribute("aria-label")).toContain("0 active · 0 waiting for approval");
    expect(client.observe).not.toHaveBeenCalled();
    expect(vi.mocked(client.control).mock.calls.every(([, , operation]) => operation === "stop")).toBe(true);
  },
);

it("learns the newly created ID from a late successful approval after its viewer closes", async () => {
  vi.useFakeTimers();
  status.sessions = [status.sessions[1]];
  render(<Harness />);
  await act(async () => {});
  click("Switch view");
  const approval = deferred<unknown>();
  vi.mocked(client.control).mockReturnValueOnce(approval.promise);
  click("Approve this request");
  await act(async () => {});
  click("Switch view");
  status.sessions = [];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expectIdle();
  await act(async () => approval.resolve(openedSession));
  expectIdle();
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  vi.mocked(client.control).mockResolvedValue({ id: openedSession.id, state: "stopped" });
  click("Stop computer control");
  expect(client.control).toHaveBeenCalledWith("c1", openedSession.id, "stop", 1);
  expect(vi.mocked(client.control).mock.calls[0][4]).toBeUndefined();
  await act(async () => {});
});

it.each(["different chat", "same chat, new lifetime"] as const)("does not leak late open IDs into %s", async (mode) => {
  vi.useFakeTimers();
  status.sessions = [];
  const view = render(<Harness />);
  await act(async () => {});
  click("Switch view");
  const open = deferred<{ session: typeof openedSession }>();
  vi.mocked(client.open).mockReturnValueOnce(open.promise);
  click("Enable");
  await act(async () => {});
  view.rerender(<Harness id="c2" />);
  await act(async () => {});
  if (mode === "same chat, new lifetime") {
    view.rerender(<Harness id="c1" />);
    await act(async () => {});
  }
  await act(async () => open.resolve({ session: openedSession }));
  expectIdle();
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  click("Stop computer control");
  await act(async () => {});
  expect(client.control).not.toHaveBeenCalled();
  expect(summary().getAttribute("aria-label")).toContain("0 active · 0 waiting for approval");
});

it.each(["status", "stop acknowledgement"] as const)(
  "does not revive a terminal emergency ID from a late active open response after %s",
  async (terminalSource) => {
    vi.useFakeTimers();
    status.sessions = [];
    render(<Harness />);
    await act(async () => {});
    click("Switch view");
    const open = deferred<{ session: typeof openedSession }>();
    vi.mocked(client.open).mockReturnValueOnce(open.promise);
    click("Enable");
    await act(async () => {});
    status.sessions = [{ ...openedSession, generation: 2 }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    if (terminalSource === "status") {
      status.sessions = [{ ...openedSession, generation: 3, state: "stopped" }];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
    } else {
      click("Stop computer control");
      await act(async () => {});
      expect(client.control).toHaveBeenCalledWith("c1", openedSession.id, "stop", 2);
    }
    const stoppedCalls = vi.mocked(client.control).mock.calls.length;
    await act(async () => open.resolve({ session: openedSession }));
    expectIdle();
    vi.mocked(client.status).mockRejectedValue(new Error("offline after terminal acknowledgement"));
    click("Stop computer control");
    await act(async () => {});
    expect(client.control).toHaveBeenCalledTimes(stoppedCalls);
    expect(summary().getAttribute("aria-label")).toContain("0 active · 0 waiting for approval");
  },
);

it("consumes a target approval ID that returns a different real session ID, even when post-approval reads fail", async () => {
  status.sessions = [{ id: "request", kind: "browser", state: "pending_approval", generation: 0, controller: null }];
  render(<Harness />);
  await screen.findByText("0 active · 1 waiting");
  click("Switch view");
  vi.mocked(client.control).mockImplementation(async (_chat, id, operation) => {
    if (operation === "approve") {
      status.sessions = [{ ...openedSession, generation: 4 }];
      vi.mocked(client.status).mockRejectedValue(new Error("post-approval offline"));
      return status.sessions[0];
    }
    if (id === "request") throw new Error("Unknown session");
    status.sessions[0].state = "stopped";
    return { ...status.sessions[0] };
  });
  click("Approve this request");
  await screen.findByText("Last known");
  // Stop must learn the returned ID and forget the consumed request even when
  // fresh status cannot establish visible authority.
  click("Stop computer control");
  await act(async () => {});
  expect(client.control).toHaveBeenCalledWith("c1", openedSession.id, "stop", 4);
  expect(
    vi
      .mocked(client.control)
      .mock.calls.filter(([, , op]) => op === "stop")
      .map(([, id]) => id),
  ).toEqual([openedSession.id]);
  expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Unknown session"))).toBe(false);
  vi.mocked(client.status).mockImplementation(async () => structuredClone(status));
  click("Stop computer control");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(vi.mocked(client.control).mock.calls.filter(([, , op]) => op === "stop")).toHaveLength(1);
});

it.each(["pending", "awaiting_approval", "approval_required", "pending_approval"] as const)(
  "retires expired/removed generation-zero %s requests, without dropping the active session",
  async (alias) => {
    vi.useFakeTimers();
    status.sessions = [
      { ...openedSession, generation: 7 },
      { id: "expired-request", kind: "browser", state: alias, controller: null, generation: 0 },
    ];
    render(<Harness />);
    await act(async () => {});
    status.sessions = [status.sessions[0]];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    vi.mocked(client.control).mockImplementation(async (_chat, id) => {
      if (id === "expired-request") throw new Error("Unknown session");
      status.sessions[0].state = "stopped";
      return { ...status.sessions[0] };
    });
    click("Stop computer control");
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    click("Stop computer control");
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.control).toHaveBeenCalledExactlyOnceWith("c1", openedSession.id, "stop", 7);
  },
);

// Daemon restart or service eviction: the server no longer knows a real session.
// Its absence from status never retires it (absence is not proof it stopped), so
// only the server's not_found on stop can settle it. Without that, every Stop
// re-sent the dead id, failed, and then verification reported it still active.
it.each(["stop", "revoke"] as const)("retires a real session the server no longer knows after a not_found %s, so Stop settles", async (operation) => {
  status.sessions = [status.sessions[0]];
  render(<Harness />);
  await screen.findByText("1 active · 0 waiting");
  status.sessions = [];
  vi.mocked(client.control).mockRejectedValue(Object.assign(new Error("Control session not found"), { code: "not_found" }));
  if (operation === "stop") click("Stop computer control");
  else {
    click("Switch view");
    click("Revoke");
  }
  await act(async () => {});
  await waitFor(() => expect(client.control).toHaveBeenCalledWith("c1", "s1", operation, 1, ...(operation === "stop" ? [] : [expect.any(AbortSignal)])));
  if (operation === "revoke") {
    // Settled, not failed: the view shows no error and the dead session leaves the list.
    await waitFor(() => expect(screen.queryByText(/State: /)).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    click("Switch view");
  }
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop computer control" }).hasAttribute("disabled")).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expectIdle();
  click("Stop computer control");
  await act(async () => {});
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vi.mocked(client.control).mock.calls.filter(([, , op]) => op === "stop")).toHaveLength(operation === "stop" ? 1 : 0);
});

it("still reports a transport failure on stop and keeps that session for retry", async () => {
  status.sessions = [status.sessions[0]];
  render(<Harness />);
  await screen.findByText("1 active · 0 waiting");
  status.sessions = [];
  vi.mocked(client.control).mockRejectedValue(Object.assign(new Error("Bad gateway"), { code: undefined, status: 502 }));
  click("Stop computer control");
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("Bad gateway");
  vi.mocked(client.control).mockResolvedValue({ id: "s1", state: "stopped" });
  click("Stop computer control");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(client.control).toHaveBeenCalledTimes(2);
});

it("clears a raced Unknown session request-stop error only after authoritative discovery confirms expiration", async () => {
  status.sessions = [{ id: "expired", kind: "browser", state: "pending_approval", controller: null, generation: 0 }];
  render(<Harness />);
  await screen.findByText("0 active · 1 waiting");
  status.sessions = []; // The host expired it since the last poll.
  vi.mocked(client.control).mockRejectedValue(new Error("Unknown session"));
  click("Stop computer control");
  await act(async () => {});
  expect(screen.queryByRole("alert")).toBeNull();
  expectIdle();
  click("Stop computer control");
  await act(async () => {});
  expect(screen.queryByRole("alert")).toBeNull();
  expect(client.control).toHaveBeenCalledExactlyOnceWith("c1", "expired", "stop", 0);
});

it("does not retire pending requests from a stale ignored read, or real positive-generation sessions from an authoritative missing read", async () => {
  vi.useFakeTimers();
  status.sessions = [status.sessions[1], { ...openedSession, state: "awaiting_approval", generation: 5 }];
  render(<Harness />);
  await act(async () => {});
  click("Switch view");
  const old = deferred<ComputerUseStatus>();
  vi.mocked(client.status).mockReturnValueOnce(old.promise);
  click("Retry status");
  await act(async () => {});
  // A newer authoritative read keeps s2, but is missing the real session.
  status.sessions = [status.sessions[0]];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await act(async () => old.resolve({ ...status, sessions: [] }));
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  vi.mocked(client.control).mockImplementation(async (_chat, id) => ({ id, state: "stopped" }));
  click("Stop computer control");
  expect(client.control).toHaveBeenCalledWith("c1", "s2", "stop", 0);
  expect(client.control).toHaveBeenCalledWith("c1", openedSession.id, "stop", 5);
  await act(async () => {});
});

it("does not retire a late-created pending request from an authoritative empty read dispatched before its ID was learned", async () => {
  vi.useFakeTimers();
  status.sessions = [];
  render(<Harness />);
  await act(async () => {});
  click("Switch view");
  const open = deferred<Awaited<ReturnType<typeof client.open>>>();
  vi.mocked(client.open).mockReturnValueOnce(open.promise);
  click("Enable");
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  click("Switch view");
  const poll = deferred<ComputerUseStatus>();
  vi.mocked(client.status).mockReturnValueOnce(poll.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await act(async () => open.resolve({ session: { id: "late-request", kind: "browser", state: "pending_approval", generation: 0, controller: null } }));
  await act(async () => poll.resolve({ ...status, sessions: [] }));
  expectIdle();
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  vi.mocked(client.control).mockResolvedValue({ id: "late-request", state: "stopped" });
  click("Stop computer control");
  expect(client.control).toHaveBeenCalledWith("c1", "late-request", "stop", 0);
  await act(async () => {});
});

it.each([undefined, { done: true }])("consumes an action request on a successful opaque approval result (%s), not its parent session", async (result) => {
  status.sessions = [
    { ...openedSession, generation: 8 },
    { id: "action-request", kind: "browser", state: "pending_approval", generation: 0, controller: null },
  ];
  render(<Harness />);
  await screen.findByText("1 active · 1 waiting");
  click("Switch view");
  vi.mocked(client.control).mockImplementation(async (_chat, id, operation) => {
    if (operation === "approve") {
      status.sessions = [status.sessions[0]];
      vi.mocked(client.status).mockRejectedValue(new Error("offline"));
      return result;
    }
    if (id === "action-request") throw new Error("Unknown session");
    return { id, state: "stopped" };
  });
  click("Confirm request");
  await screen.findByText("Last known");
  click("Stop computer control");
  await act(async () => {});
  expect(vi.mocked(client.control).mock.calls.filter(([, , op]) => op === "stop")).toEqual([["c1", openedSession.id, "stop", 8]]);
});

it.each(["pending", "error"] as const)("never renders old-chat %s Stop flags or alerts in an unused destination, even before effects reset", async (mode) => {
  status.sessions = [];
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  const view = render(<Harness />);
  await act(async () => {});
  click("Switch view");
  const discovery = deferred<ComputerUseStatus>();
  if (mode === "pending") vi.mocked(client.status).mockReturnValueOnce(discovery.promise);
  click("Stop computer control");
  await act(async () => {});
  click("Switch view");
  expect(screen.getByRole("button", { name: "Stop computer control" })).toBeTruthy();
  if (mode === "error") expect(screen.getByRole("alert").textContent).toContain("Retry Stop");
  else expect(screen.getByText("Stopping…")).toBeTruthy();

  const renders: { stopping: boolean; stopError: string; hasUsage: boolean }[] = [];
  const record = ({ stopping, stopError, hasUsage }: ReturnType<typeof useComputerUseController>) => renders.push({ stopping, stopError, hasUsage });
  vi.mocked(client.status).mockResolvedValue({ ...status, sessions: [] });
  view.rerender(<Harness id="c2" onRender={record} />);
  await act(async () => {});
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.every((value) => !value.stopping && !value.stopError && !value.hasUsage)).toBe(true);
  expect(screen.queryByRole("button", { name: "Stop computer control" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  // Returning to c1 is a new controller lifetime, not a revival of its old Stop.
  view.rerender(<Harness id="c1" onRender={record} />);
  await act(async () => {});
  if (mode === "pending") {
    await act(async () => discovery.resolve({ ...status, sessions: [openedSession] }));
    expect(client.control).toHaveBeenCalledWith("c1", openedSession.id, "stop", 1);
    expect(vi.mocked(client.control).mock.calls.every(([id]) => id === "c1")).toBe(true);
  }
  expect(renders.every((value) => !value.stopping && !value.stopError && !value.hasUsage)).toBe(true);
  expect(screen.queryByRole("button", { name: "Stop computer control" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(client.open).not.toHaveBeenCalled();
  expect(client.observe).not.toHaveBeenCalled();
});
