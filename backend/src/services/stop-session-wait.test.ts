/**
 * Session teardown is awaited, and a teardown that does not happen is reported.
 *
 * `stopSession` aborts, fires `closeQuery()` un-awaited, unregisters and
 * returns — correct for a user pressing Stop, wrong for an archive that is
 * about to move the directory the agent is working in. The subprocess can still
 * be alive with its cwd inside that worktree, which is the most realistic way
 * to end up with a half-removed directory.
 *
 * So the three outcomes the workspace lifecycle depends on are pinned here:
 * a run that unwinds is waited for, a run that ignores the abort reports
 * `timeout` (and is left registered rather than quietly dropped), and a CLI
 * session — whose process the server never owned — reports `unstoppable`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = mkdtempSync(join(tmpdir(), "callboard-stop-wait-"));
process.env.CALLBOARD_DATA_DIR = dataRoot;

const { sessionRegistry } = await import("./session-registry.js");
const { stopSessionAndWait } = await import("./claude.js");

afterEach(() => {
  for (const chatId of Object.keys(sessionRegistry.getAll())) sessionRegistry.unregister(chatId);
});

process.on("exit", () => rmSync(dataRoot, { recursive: true, force: true }));

/** A registered web session that unwinds `after` ms, or never when null. */
function registerSession(chatId: string, after: number | null): { emitter: EventEmitter; closed: () => boolean } {
  const emitter = new EventEmitter();
  const abortController = new AbortController();
  let closeCalled = false;
  sessionRegistry.register(chatId, {
    type: "web",
    abortController,
    emitter,
    closeQuery: async () => {
      closeCalled = true;
    },
  });
  if (after !== null) {
    abortController.signal.addEventListener("abort", () => {
      setTimeout(() => emitter.emit("event", { type: "done", content: "", reason: "aborted" }), after);
    });
  }
  return { emitter, closed: () => closeCalled };
}

describe("stopSessionAndWait", () => {
  it("waits for the run's terminal event rather than returning on the abort", async () => {
    const session = registerSession("chat-unwinds", 40);

    const started = Date.now();
    const outcome = await stopSessionAndWait("chat-unwinds", 2000);

    expect(outcome).toBe("stopped");
    // It really waited: `stopSession` would have returned immediately.
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(session.closed()).toBe(true);
    // Only once it is genuinely over does the session read as inactive.
    expect(sessionRegistry.get("chat-unwinds")).toBeUndefined();
  });

  it("reports timeout — and leaves the session registered — when the run ignores the abort", async () => {
    registerSession("chat-hangs", null);

    const outcome = await stopSessionAndWait("chat-hangs", 150);

    expect(outcome).toBe("timeout");
    // Not unregistered: the run is still there, and pretending otherwise would
    // hide from the UI exactly the thing the archive is refusing on.
    expect(sessionRegistry.get("chat-hangs")).toBeDefined();
  });

  it("reports a CLI session as unstoppable rather than claiming it stopped", async () => {
    sessionRegistry.register("chat-cli", { type: "cli" });
    expect(await stopSessionAndWait("chat-cli", 100)).toBe("unstoppable");
    expect(sessionRegistry.get("chat-cli")).toBeDefined();
  });

  it("reports not-running when there is no session", async () => {
    expect(await stopSessionAndWait("chat-absent", 100)).toBe("not-running");
  });
});
