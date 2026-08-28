// @vitest-environment jsdom
/**
 * The half of the update the stream cannot deliver.
 *
 * `update_restarting` is the last frame this page can receive — the daemon
 * serving it is stopped moments later — so the transition from "restarting" to
 * "done" comes from polling a daemon that has come back on a *new* connection.
 * Two things about that are easy to get backwards, and both are pinned here:
 *
 * - **The stream rejecting is not a failure.** The daemon dies without closing
 *   the response, so the `fetch` read can reject with a network error at exactly
 *   the moment everything is working. A naive catch puts "the update could not
 *   be started" on screen during a successful update.
 * - **An early successful probe proves nothing.** The old daemon keeps serving
 *   between the helper spawning and the SIGTERM landing, so the poll waits for
 *   the version the daemon said it installed rather than for any answer at all.
 *
 * The api module is mocked whole; this suite is about the hook's control flow,
 * and `UpdateBanner.test.tsx` covers what each state renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SelfUpdateEvent } from "../../api";

const mocks = vi.hoisted(() => ({
  getSelfUpdateStatus: vi.fn(),
  startSelfUpdate: vi.fn(),
  readSelfUpdateStream: vi.fn(),
  probeDaemonVersion: vi.fn(),
}));

vi.mock("../../api", () => ({
  getSelfUpdateStatus: mocks.getSelfUpdateStatus,
  startSelfUpdate: mocks.startSelfUpdate,
  readSelfUpdateStream: mocks.readSelfUpdateStream,
  probeDaemonVersion: mocks.probeDaemonVersion,
}));

const { useSelfUpdate, RESTART_POLL_INTERVAL_MS, RESTART_POLL_TIMEOUT_MS, RUN_DEADLINE_MS } = await import("./UpdateBanner");

const COMMAND = "npm install -g @wolpertingerlabs/callboard";

/** The frames a daemon emits on its way out: npm done, version read, restarting. */
const RESTART_SEQUENCE: SelfUpdateEvent[] = [
  { type: "update_started", updateId: "u1", package: "@wolpertingerlabs/callboard", command: COMMAND, fromVersion: "1.0.0", startedAt: "now" },
  { type: "update_exit", updateId: "u1", ok: true, code: 0, signal: null, durationMs: 10 },
  {
    type: "update_verified",
    updateId: "u1",
    fromVersion: "1.0.0",
    installedVersion: "1.1.0",
    changed: true,
    summary: "v1.1.0 is installed. Restarting Callboard now.",
    restart: "pending",
    rollbackCommand: "npm install -g @wolpertingerlabs/callboard@1.0.0",
  },
  { type: "update_restarting", updateId: "u1", fromVersion: "1.0.0", installedVersion: "1.1.0", helper: "/g/bin/callboard.js", rollbackCommand: "npm install -g @wolpertingerlabs/callboard@1.0.0" },
];

/** Replay `events` into the caller's handler, then end the stream the given way. */
function streamThat(events: SelfUpdateEvent[], ending: "resolve" | "reject" = "resolve") {
  return async (_id: string, onEvent: (e: SelfUpdateEvent) => void) => {
    for (const event of events) onEvent(event);
    if (ending === "reject") throw new TypeError("network error");
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.getSelfUpdateStatus.mockResolvedValue({ capability: { oneClick: true }, version: "1.0.0", package: "@wolpertingerlabs/callboard", command: COMMAND });
  mocks.startSelfUpdate.mockResolvedValue({ updateId: "u1", package: "@wolpertingerlabs/callboard", command: COMMAND, fromVersion: "1.0.0" });
  mocks.readSelfUpdateStream.mockImplementation(streamThat(RESTART_SEQUENCE));
  mocks.probeDaemonVersion.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

type Hook = ReturnType<typeof render>;

/** Start an update and let every already-resolved promise settle. */
async function startAndSettle(hook: Hook) {
  await act(async () => {
    hook.result.current.start();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function render() {
  return renderHook(() => useSelfUpdate("1.0.0"));
}

describe("the poll that replaces the stream", () => {
  it("reports the new version once the daemon answers on it", async () => {
    const hook = render();
    await startAndSettle(hook);
    expect(hook.result.current.run?.phase).toBe("restarting");

    // Down, then up on the new version.
    mocks.probeDaemonVersion.mockResolvedValueOnce(undefined).mockResolvedValue("1.1.0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS * 3);
    });

    expect(hook.result.current.run?.phase).toBe("done");
    expect(hook.result.current.run?.verdict).toMatchObject({ tone: "ok" });
    expect(hook.result.current.run?.verdict?.text).toContain("v1.1.0");
  });

  it("does not accept the old daemon still answering as a finished restart", async () => {
    const hook = render();
    await startAndSettle(hook);

    // The pre-restart process is still serving for a beat after the helper is
    // spawned. Answering "1.0.0" is not evidence that anything restarted.
    mocks.probeDaemonVersion.mockResolvedValue("1.0.0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS * 3);
    });
    expect(hook.result.current.run?.phase).toBe("restarting");
  });

  it("treats the stream dying mid-restart as the expected path, not a failure", async () => {
    // The daemon is killed without closing the response, so the read rejects.
    mocks.readSelfUpdateStream.mockImplementation(streamThat(RESTART_SEQUENCE, "reject"));
    const hook = render();
    await startAndSettle(hook);

    expect(hook.result.current.run?.phase).toBe("restarting");
    expect(hook.result.current.run?.verdict).toBeUndefined();

    mocks.probeDaemonVersion.mockResolvedValue("1.1.0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS * 2);
    });
    expect(hook.result.current.run?.verdict).toMatchObject({ tone: "ok" });
  });

  it("gives up loudly, with the way back, when the daemon never comes home", async () => {
    const hook = render();
    await startAndSettle(hook);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_TIMEOUT_MS + RESTART_POLL_INTERVAL_MS);
    });

    expect(hook.result.current.run?.phase).toBe("done");
    const verdict = hook.result.current.run?.verdict;
    expect(verdict).toMatchObject({ tone: "error" });
    // The one moment a user genuinely needs the rollback command: whatever is
    // happening, this daemon is not answering.
    expect(verdict?.text).toContain("npm install -g @wolpertingerlabs/callboard@1.0.0");
    expect(verdict?.text).toContain("callboard logs");
  });

  it("reports a refused start with the server's own sentence, and never polls", async () => {
    mocks.startSelfUpdate.mockRejectedValue(new Error("Callboard is already updating itself."));
    const hook = render();
    await startAndSettle(hook);

    expect(hook.result.current.run).toMatchObject({ phase: "done", verdict: { tone: "error", text: "Callboard is already updating itself." } });
    expect(mocks.probeDaemonVersion).not.toHaveBeenCalled();
  });

  it("stops at a refused restart without polling for a daemon that is not restarting", async () => {
    mocks.readSelfUpdateStream.mockImplementation(
      streamThat([
        RESTART_SEQUENCE[0],
        RESTART_SEQUENCE[1],
        {
          type: "update_verified",
          updateId: "u1",
          fromVersion: "1.0.0",
          installedVersion: "1.1.0",
          changed: true,
          summary: "installed, not restarted",
          restart: "refused",
          restartRefusal: "1 chat is still streaming",
          rollbackCommand: "npm install -g @wolpertingerlabs/callboard@1.0.0",
        },
      ]),
    );
    const hook = render();
    await startAndSettle(hook);

    expect(hook.result.current.run).toMatchObject({ phase: "done", verdict: { tone: "warn" } });
    expect(mocks.probeDaemonVersion).not.toHaveBeenCalled();
  });
});

// ── Streams that end somewhere they should not ──────────────────────

describe("a stream that ends before Callboard reported anything", () => {
  /** npm started, and then the connection went — no exit, no verdict. */
  const HALFWAY = [RESTART_SEQUENCE[0], { type: "update_output", stream: "stdout", line: "reify:lodash" } as SelfUpdateEvent];

  it("says the connection ended, as a warning, when the read rejects mid-install", async () => {
    // A Wi-Fi drop, a laptop waking up, a SIGKILLed daemon. This used to
    // rethrow — the guard let anything but `restarting` through — and the
    // outer catch rendered `err.message`, so the entire account of a global
    // npm install running on the user's machine was "Failed to fetch".
    mocks.readSelfUpdateStream.mockImplementation(streamThat(HALFWAY, "reject"));
    const hook = render();
    await startAndSettle(hook);

    expect(hook.result.current.run?.phase).toBe("done");
    expect(hook.result.current.run?.verdict?.tone).toBe("warn");
    expect(hook.result.current.run?.verdict?.text).toContain("ended before Callboard reported a result");
    expect(hook.result.current.run?.verdict?.text).not.toContain("network error");
    expect(mocks.probeDaemonVersion).not.toHaveBeenCalled();
  });

  it("says the same thing when the read resolves cleanly at a non-terminal phase", async () => {
    mocks.readSelfUpdateStream.mockImplementation(streamThat(HALFWAY));
    const hook = render();
    await startAndSettle(hook);
    expect(hook.result.current.run).toMatchObject({ phase: "done", verdict: { tone: "warn" } });
  });

  it("does not overwrite a terminal verdict with a socket error that arrives after it", async () => {
    // npm refused, the daemon said so, *then* the connection dropped. The
    // accurate sentence is the one npm's exit carried, and the vaguer one
    // must not replace it.
    mocks.readSelfUpdateStream.mockImplementation(
      streamThat(
        [RESTART_SEQUENCE[0], { type: "update_exit", updateId: "u1", ok: false, code: 1, signal: null, durationMs: 10, refusal: "npm exited 1: EACCES on /usr/lib." }],
        "reject",
      ),
    );
    const hook = render();
    await startAndSettle(hook);

    expect(hook.result.current.run).toMatchObject({ phase: "done", verdict: { tone: "error" } });
    expect(hook.result.current.run?.verdict?.text).toBe("npm exited 1: EACCES on /usr/lib.");
  });
});

describe("a stream that never ends at all", () => {
  it("gives up on its own deadline rather than sitting in `installing` forever", async () => {
    // A reverse proxy that buffers, a half-open TCP connection, a lost FIN.
    // Nothing rejects and nothing resolves, so without a bound the phase stays
    // where it is with the button disabled and no way out but a reload — which
    // discards the run.
    mocks.readSelfUpdateStream.mockImplementation(
      async (_id: string, onEvent: (e: SelfUpdateEvent) => void, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          onEvent(RESTART_SEQUENCE[0]);
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const hook = render();
    await startAndSettle(hook);
    expect(hook.result.current.run?.phase).toBe("installing");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 1_000);
    });

    expect(hook.result.current.run?.phase).toBe("done");
    expect(hook.result.current.run?.verdict?.tone).toBe("warn");
    expect(hook.result.current.run?.verdict?.text).toContain("stopped reporting");
  });

  it("runs the restart poll when the deadline fires during the restart, rather than giving up", async () => {
    // The deadline spans the restart phase — the route deliberately keeps the
    // response open past `update_restarting` so `update_restart_failed` can
    // still arrive — so it *can* fire there, and firing there used to report
    // "Callboard stopped reporting on this update 11 minutes ago" for a daemon
    // that was restarting exactly as designed. The poll is the only instrument
    // that can tell the difference, and it was the one thing being skipped.
    mocks.readSelfUpdateStream.mockImplementation(
      async (_id: string, onEvent: (e: SelfUpdateEvent) => void, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          for (const event of RESTART_SEQUENCE) onEvent(event);
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const hook = render();
    await startAndSettle(hook);
    expect(hook.result.current.run?.phase).toBe("restarting");

    mocks.probeDaemonVersion.mockResolvedValue("1.1.0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + RESTART_POLL_INTERVAL_MS * 2);
    });

    expect(hook.result.current.run?.verdict).toMatchObject({ tone: "ok" });
    expect(hook.result.current.run?.verdict?.text).toContain("v1.1.0");
    expect(hook.result.current.run?.verdict?.text).not.toContain("stopped reporting");
  });

  it("still gives up when the deadline fires and the daemon is not restarting", async () => {
    // The other half. Aborting the read must not be mistaken for the component
    // unmounting, and expiry in a non-restart phase is still a dead socket.
    mocks.readSelfUpdateStream.mockImplementation(
      async (_id: string, onEvent: (e: SelfUpdateEvent) => void, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          onEvent(RESTART_SEQUENCE[0]);
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const hook = render();
    await startAndSettle(hook);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS + 1_000);
    });
    expect(hook.result.current.run?.verdict?.text).toContain("stopped reporting");
    expect(mocks.probeDaemonVersion).not.toHaveBeenCalled();
  });

  it("closes the server's own restart deadline out as an ordinary stream ending", async () => {
    // `GET .../stream` now closes the response itself a few seconds after
    // `update_restarting`, so a hung restart does not hold a listener forever.
    // From here that is indistinguishable from the socket dying with the
    // daemon, which is the point: this page classifies on the phase, and the
    // phase is `restarting` either way.
    mocks.readSelfUpdateStream.mockImplementation(streamThat(RESTART_SEQUENCE));
    const hook = render();
    await startAndSettle(hook);
    expect(hook.result.current.run?.phase).toBe("restarting");

    mocks.probeDaemonVersion.mockResolvedValue("1.1.0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS * 2);
    });
    expect(hook.result.current.run?.verdict).toMatchObject({ tone: "ok" });
  });
});

// ── Re-entrancy, unmount, and picking a run back up ─────────────────

describe("the hook's own guards", () => {
  it("ignores a second `start()` while one is running, without touching the network", async () => {
    // The view disables the button, which is tested next door — this is the
    // guard underneath it, which is what stops a caller that has its own idea
    // of when to press.
    let release: (() => void) | undefined;
    mocks.readSelfUpdateStream.mockImplementation(async () => new Promise<void>((resolve) => (release = resolve)));
    const hook = render();
    await startAndSettle(hook);
    expect(mocks.startSelfUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      hook.result.current.start();
      hook.result.current.start();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.startSelfUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("stops polling when the component goes away mid-restart", async () => {
    const hook = render();
    await startAndSettle(hook);
    expect(hook.result.current.run?.phase).toBe("restarting");

    hook.unmount();
    const callsAtUnmount = mocks.probeDaemonVersion.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS * 5);
    });
    expect(mocks.probeDaemonVersion.mock.calls.length).toBe(callsAtUnmount);
  });
});

describe("attaching to an update this page did not start", () => {
  it("picks up the run named by activeUpdateId on mount", async () => {
    // `Settings.tsx` unmounts the About tab on a tab change, so a remount
    // during a live update is one click away. Coming back to an idle banner
    // with an enabled button meant a 409 on a page showing no update, and a
    // daemon that might restart with nothing on screen.
    mocks.getSelfUpdateStatus.mockResolvedValue({
      capability: { oneClick: true },
      version: "1.0.0",
      package: "@wolpertingerlabs/callboard",
      command: COMMAND,
      activeUpdateId: "u1",
    });
    const hook = render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.startSelfUpdate).not.toHaveBeenCalled();
    expect(mocks.readSelfUpdateStream).toHaveBeenCalledWith("u1", expect.any(Function), expect.anything());
    // The replayed transcript drives it the rest of the way, exactly as if
    // this page had started it.
    expect(hook.result.current.run?.phase).toBe("restarting");

    mocks.probeDaemonVersion.mockResolvedValue("1.1.0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS * 2);
    });
    expect(hook.result.current.run?.verdict).toMatchObject({ tone: "ok" });
  });

  it("does nothing when there is no update in flight", async () => {
    const hook = render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.readSelfUpdateStream).not.toHaveBeenCalled();
    expect(hook.result.current.run).toBeNull();
  });
});
