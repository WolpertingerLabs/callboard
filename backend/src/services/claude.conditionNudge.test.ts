/**
 * The condition half of the nudge decision, driven through `sendMessage`.
 *
 * `nudge-decision.test.ts` covers `decideNudge` exhaustively, but only for the
 * `watchOpen` it is handed. What feeds it lives in `claude.ts`, and that is
 * where an exhausted watch was once counted as open: the `wait` tool had just
 * refused the agent with "calling wait again will keep being refused", and the
 * nudge then told it to call wait again to keep polling — up to `maxNudges`
 * contradictory turns, ending `condition_unresolved`.
 *
 * The provider here plays the CLI for a turn in which the agent polled a
 * condition: it leaves the watch in the state the `wait` tool would have, then
 * ends the turn. Whether the run re-prompts is read off the events.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-cond-nudge-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-cond-nudge-work-"));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { openOrContinueWatch, exhaustWatch, closeWatch } = await import("./chat-activity.js");

type WatchState = "open" | "exhausted";

/**
 * One scripted query per call. The first leaves a watch on the session in
 * `state`; any later query (a nudge) resolves it, so a run that nudges still
 * finishes and the assertion reports what happened instead of a timeout.
 */
function conditionProvider(sessionId: string, state: WatchState) {
  let queries = 0;
  const provider: AgentProvider = {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      const n = ++queries;
      void (async () => {
        for await (const _message of req.prompt as AsyncIterable<unknown>) {
          // Drain the prompt as the SDK does; content is irrelevant here.
        }
      })();
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
          yield { type: "session_started", sessionId };
          // By now the chat record exists and the run's tracking id is the
          // session id — the key the wait tool's getChatId() resolves to.
          if (n === 1) {
            // An exhausted watch stays in the map — it denies the condition a
            // fresh budget — which is why map presence must not mean "open".
            openOrContinueWatch(sessionId, "CI is green");
            if (state === "exhausted") exhaustWatch(sessionId);
          } else {
            closeWatch(sessionId, false);
          }
          yield { type: "text", content: "checked" };
          yield { type: "result", status: "success" };
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {},
      };
    },
    buildToolServer: () => ({ mock: true }),
  };
  return { provider, queryCount: () => queries };
}

async function run(provider: AgentProvider): Promise<StreamEvent[]> {
  setAgentProviderForTesting(provider);
  const emitter = await sendMessage({ prompt: "poll CI", folder: workDir, triggered: true });
  const events: StreamEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
    emitter.on("event", (e: StreamEvent) => {
      events.push(e);
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return events;
}

afterEach(() => {
  setAgentProviderForTesting(null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("condition watch — nudge decision at the claude.ts seam", () => {
  it("nudges when a turn ends with the watch still open", async () => {
    // The control: proves the harness reaches the nudge path at all, so the
    // exhausted case below cannot pass vacuously.
    const ctrl = conditionProvider("cond-open", "open");
    const events = await run(ctrl.provider);

    expect(events.filter((e) => e.type === "nudge")).toHaveLength(1);
    expect(ctrl.queryCount()).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(events.at(-1)!.reason).toBeUndefined();
  });

  it("ends normally when the watch was exhausted — the agent was already told to stop polling", async () => {
    const ctrl = conditionProvider("cond-exhausted", "exhausted");
    const events = await run(ctrl.provider);

    expect(events.filter((e) => e.type === "nudge")).toHaveLength(0);
    expect(ctrl.queryCount()).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(events.at(-1)!.reason).toBeUndefined();
  });
});
