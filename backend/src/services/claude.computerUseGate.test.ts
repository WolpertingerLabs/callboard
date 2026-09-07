/**
 * The managed computer tools must reach `canUseTool` on Claude Code.
 *
 * `allowedTools` entries are auto-approved by the Agent SDK *before* the
 * `canUseTool` callback fires (the `[PERM-DIAG]` log history never shows an
 * `mcp__callboard-tools__*` decision for exactly that reason). The first cut
 * of #414 pushed `mcp__computer_use__*` onto that list, which made the chat's
 * `computerControl: deny` unenforceable at this layer: the categorizer's
 * computerControl arm and `decidePermission`'s deny were dead code, and only
 * the service's own authorizer stood between a denied chat and the browser.
 *
 * This observes what `sendMessage` actually hands the provider, the same seam
 * `claude.binaryOverrides.test.ts` established: the server is registered, and
 * it is NOT allow-listed. Re-adding the push fails here and nowhere else.
 */
import { afterAll, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-cu-gate-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-cu-gate-work-"));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");

function recordingProvider() {
  const requests: AgentQueryRequest[] = [];
  const provider: AgentProvider = {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      requests.push(req);
      let ended = false;
      const waiter: { wake: (() => void) | null } = { wake: null };
      const nudge = () => {
        const w = waiter.wake;
        waiter.wake = null;
        w?.();
      };
      const queued: AgentEvent[] = [
        { type: "session_started", sessionId: `s-${requests.length}` },
        { type: "text", content: "ok" },
        { type: "result", status: "success" },
      ];
      void (async () => {
        for await (const _message of req.prompt as AsyncIterable<unknown>) {
          // drain
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
    // Tag each built server with its spec name so the options can be inspected.
    buildToolServer: (spec: ToolServerSpec) => ({ mock: spec.name }),
  };
  return { provider, requests };
}

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

it("registers the computer_use server without allow-listing it, so every cu_* call reaches canUseTool", async () => {
  const ctrl = recordingProvider();
  setAgentProviderForTesting(ctrl.provider, "claude-code");
  const emitter = await sendMessage({ prompt: "hello", folder: workDir } as never);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const options = ctrl.requests[0].options as { mcpServers?: Record<string, unknown>; allowedTools?: string[] };
  expect(options.mcpServers?.computer_use).toEqual({ mock: "computer_use" });
  const allowed = options.allowedTools ?? [];
  // The other in-process servers are still auto-approved; that is their contract.
  expect(allowed).toContain("mcp__callboard-tools__*");
  expect(allowed.filter((pattern) => /computer_use/.test(pattern))).toEqual([]);
});
