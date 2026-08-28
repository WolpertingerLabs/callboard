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

const { useSelfUpdate, RESTART_POLL_INTERVAL_MS, RESTART_POLL_TIMEOUT_MS } = await import("./UpdateBanner");

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
