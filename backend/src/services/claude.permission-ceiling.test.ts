/**
 * The permission ceiling at the `claude.ts` seam: the callboard-tools server a
 * real session builds must carry that session's own policy, so the children
 * `start_chat_session` starts are capped by it.
 *
 * The tool-level tests (callboard-tools.start-chat / continue-chat) hand the
 * spec a getter by hand. Only this file fails when `getPermissions` is not
 * wired in `sendMessage` — and that failure mode is not cosmetic: the tools
 * fail closed to ask-everything, so every unattended agent's children would
 * start blocking on prompts nobody is there to answer.
 *
 * Harness: the recording provider from `claude.binaryOverrides.test.ts`, with
 * `buildToolServer` keeping the specs it is handed.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery } from "../agents/ports/AgentProvider.js";
import type { ToolDefinition, ToolServerSpec } from "../agents/ports/tools.js";
import type { DefaultPermissions, StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-perm-ceiling-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-perm-ceiling-work-"));

const { sendMessage } = await import("./claude.js");
const { setCallboardMessageSender } = await import("./callboard-tools.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { unattendedPermissions } = await import("./session-spawn.js");

/** A provider that keeps every tool-server spec it is asked to build, then completes the turn. */
function recordingProvider() {
  const specs: ToolServerSpec[] = [];
  const provider: AgentProvider = {
    kind: "mock",
    query(req): AgentQuery {
      let ended = false;
      const waiter: { wake: (() => void) | null } = { wake: null };
      const nudge = () => {
        const w = waiter.wake;
        waiter.wake = null;
        w?.();
      };
      const queued: AgentEvent[] = [
        { type: "session_started", sessionId: "s-ceiling" },
        { type: "text", content: "ok" },
        { type: "result", status: "success" },
      ];
      void (async () => {
        for await (const _message of req.prompt as AsyncIterable<unknown>) {
          // content irrelevant here
        }
        ended = true;
        nudge();
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queued.length > 0) yield queued.shift()!;
            if (ended) return;
            await new Promise<void>((resolve) => {
              waiter.wake = resolve;
            });
          }
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {
          ended = true;
          nudge();
        },
      };
    },
    buildToolServer: (spec: ToolServerSpec) => {
      specs.push(spec);
      return { mock: true };
    },
  };
  return { provider, specs };
}

/**
 * Run one parent turn with `defaultPermissions`, then call the
 * start_chat_session tool its session was built with, and return what the
 * child would have been started with.
 */
async function childPermissionsFor(parent: DefaultPermissions): Promise<DefaultPermissions> {
  const { provider, specs } = recordingProvider();
  setAgentProviderForTesting(provider, "claude-code");
  const emitter = await sendMessage({ prompt: "hello", folder: workDir, defaultPermissions: parent, triggered: true } as any);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const spec = specs.find((s) => s.name === "callboard-tools");
  const tool = spec?.tools.find((t) => t.name === "start_chat_session") as ToolDefinition<any> | undefined;
  if (!tool) throw new Error("callboard-tools start_chat_session was not built");

  // Stand in for sendMessage only for the child, after the parent's real turn.
  const sent: any[] = [];
  setCallboardMessageSender(async (opts) => {
    sent.push(opts);
    const child = new EventEmitter();
    setTimeout(() => child.emit("event", { type: "chat_created", chatId: "child" }), 0);
    return child;
  });
  await tool.handler({ prompt: "child task", folder: workDir });
  expect(sent).toHaveLength(1);
  return sent[0].defaultPermissions;
}

afterEach(() => {
  setAgentProviderForTesting(null);
  setCallboardMessageSender(sendMessage as any);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("sendMessage wires the session's own policy in as the spawn ceiling", () => {
  it("an ask parent's child is capped at the parent's policy", async () => {
    const parent: DefaultPermissions = { fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "deny", computerControl: "deny" };
    expect(await childPermissionsFor(parent)).toEqual(parent);
  });

  it("an unattended allow-all parent (agent, cron, trigger, job) still gets an allow-all child", async () => {
    expect(await childPermissionsFor(unattendedPermissions())).toEqual(unattendedPermissions());
  });

  it("computer control stays denied for the child of a parent that allows it", async () => {
    expect(await childPermissionsFor({ ...unattendedPermissions(), computerControl: "allow" })).toEqual(unattendedPermissions());
  });
});
