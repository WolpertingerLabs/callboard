/**
 * The single hop that decides which binary executes — tested at the `claude.ts`
 * seam, because that is where it lives and nowhere else covers it.
 *
 * ## Why this file exists
 *
 * Review mutation-tested the first cut of this feature by deleting the two
 * wiring lines and running the suite. Both passed:
 *
 * - remove `queryOpts.options.pathToClaudeCodeExecutable` → 2495 passed, 0 failed
 * - remove `queryOpts.options.codex.pathOverride` → 2990 passed, 0 failed
 *
 * Every unit next door was green in both runs — the resolvers resolved, the
 * options adapter mapped `pathOverride` onto `codexPathOverride`, the status
 * card rendered an override "in effect" — while the value never reached a
 * chat. That is this feature's own thesis reproduced inside its test suite: a
 * card asserting something nothing checked, with the check one hop away from
 * the assertion.
 *
 * So these tests observe what `sendMessage` actually hands the provider. They
 * are the only tests in the tree that fail when either line is deleted, and
 * that property is the point of them — see the assertions' comments, which name
 * the mutation each one catches.
 *
 * The harness is the one `claude.backgroundHold.test.ts` established: a
 * provider injected through the factory, playing the SDK's part by draining the
 * prompt and ending the stream when it returns. Here it also records the
 * `AgentQueryRequest` it was handed, which is the whole observation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-binary-override-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-binary-override-work-"));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { updateAgentSettings } = await import("./agent-settings.js");
const { resetClaudeBinaryCache } = await import("./claude-binary.js");

/** An executable that exists and does nothing — enough to pass the resolver's checks. */
function fakeBinary(name: string): string {
  const dir = join(dataDir, "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/** A provider that records what it was asked to run, then completes the turn. */
function recordingProvider() {
  const requests: AgentQueryRequest[] = [];

  const provider: AgentProvider = {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      requests.push(req);
      let ended = false;
      // Typed through a holder so TypeScript does not narrow it to `null` on
      // the strength of the initialiser — it is reassigned from inside the
      // async iterator below, which the checker cannot see.
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
      // Drain the prompt the way the SDK does; when it returns, the turn is over.
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
    buildToolServer: () => ({ mock: true }),
  };

  return { provider, requests };
}

/** Run one turn to completion and hand back the options the provider was given. */
async function optionsForOneTurn(provider: AgentProvider, requests: AgentQueryRequest[], sendOpts: Record<string, unknown>): Promise<any> {
  setAgentProviderForTesting(provider, (sendOpts.provider as any) ?? "claude-code");
  const emitter = await sendMessage({ prompt: "hello", folder: workDir, ...sendOpts } as any);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  expect(requests.length).toBeGreaterThan(0);
  return requests[0].options as any;
}

beforeEach(() => {
  updateAgentSettings({ pathToClaudeCodeExecutable: undefined, codexPathOverride: undefined });
  resetClaudeBinaryCache();
});

afterEach(() => {
  setAgentProviderForTesting(null);
  updateAgentSettings({ pathToClaudeCodeExecutable: undefined, codexPathOverride: undefined });
  resetClaudeBinaryCache();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("Claude Code — pathToClaudeCodeExecutable reaches the chat", () => {
  it("hands the configured binary to the Agent SDK", async () => {
    // Deleting `queryOpts.options.pathToClaudeCodeExecutable` from claude.ts
    // fails exactly here and, before this file existed, nowhere at all.
    const bin = fakeBinary("my-claude");
    updateAgentSettings({ pathToClaudeCodeExecutable: bin });
    resetClaudeBinaryCache();

    const ctrl = recordingProvider();
    const options = await optionsForOneTurn(ctrl.provider, ctrl.requests, {});
    expect(options.pathToClaudeCodeExecutable).toBe(bin);
  });

  it("omits the key when a configured path is rejected, rather than passing something unspawnable", async () => {
    // The fallback has to be observable at this seam too: the resolver refusing
    // a bad path is only useful if the refusal is what the SDK actually gets.
    const notExecutable = join(dataDir, "bin", "unrunnable");
    mkdirSync(join(dataDir, "bin"), { recursive: true });
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    updateAgentSettings({ pathToClaudeCodeExecutable: notExecutable });
    resetClaudeBinaryCache();

    const ctrl = recordingProvider();
    const options = await optionsForOneTurn(ctrl.provider, ctrl.requests, {});
    expect(options.pathToClaudeCodeExecutable).not.toBe(notExecutable);
  });

  it("picks up a changed setting on the next chat, with no cache reset in between", async () => {
    // The memoisation finding, at the seam that matters. The override is read
    // fresh on every resolution, so a second chat sees the second path —
    // nothing here calls `resetClaudeBinaryCache`, deliberately.
    const first = fakeBinary("claude-first");
    const second = fakeBinary("claude-second");

    updateAgentSettings({ pathToClaudeCodeExecutable: first });
    resetClaudeBinaryCache();
    const a = recordingProvider();
    expect((await optionsForOneTurn(a.provider, a.requests, {})).pathToClaudeCodeExecutable).toBe(first);

    updateAgentSettings({ pathToClaudeCodeExecutable: second });
    const b = recordingProvider();
    expect((await optionsForOneTurn(b.provider, b.requests, {})).pathToClaudeCodeExecutable).toBe(second);
  });
});

describe("Codex — codexPathOverride reaches the chat", () => {
  it("puts the configured binary on the codex extras the options adapter reads", async () => {
    // Deleting `...(codexBinary && { pathOverride: codexBinary })` from
    // claude.ts fails exactly here. `optionsAdapter.test.ts` covers the next
    // hop — extras.pathOverride → CodexOptions.codexPathOverride — and passed
    // happily while this one was severed.
    const bin = fakeBinary("my-codex");
    updateAgentSettings({ codexPathOverride: bin });

    const ctrl = recordingProvider();
    const options = await optionsForOneTurn(ctrl.provider, ctrl.requests, { provider: "codex" });
    expect(options.codex?.pathOverride).toBe(bin);
  });

  it("leaves pathOverride absent when nothing is configured", async () => {
    // Absent, not empty: the SDK branches on truthiness to decide whether to
    // resolve its own bundled binary, and this is the default every Codex chat
    // took before Phase 4.
    const ctrl = recordingProvider();
    const options = await optionsForOneTurn(ctrl.provider, ctrl.requests, { provider: "codex" });
    expect(options.codex).toBeDefined();
    expect(options.codex.pathOverride).toBeUndefined();
  });

  it("omits it when the configured path does not exist", async () => {
    updateAgentSettings({ codexPathOverride: join(dataDir, "bin", "no-such-codex") });

    const ctrl = recordingProvider();
    const options = await optionsForOneTurn(ctrl.provider, ctrl.requests, { provider: "codex" });
    expect(options.codex.pathOverride).toBeUndefined();
  });

  it("does not leak the Codex override onto a Claude Code chat, or vice versa", async () => {
    // Two fields, two engines, one settings file. Crossing them would be a
    // quieter version of the same bug: a card that reports per engine while the
    // wiring does not.
    const claudeBin = fakeBinary("x-claude");
    const codexBin = fakeBinary("x-codex");
    updateAgentSettings({ pathToClaudeCodeExecutable: claudeBin, codexPathOverride: codexBin });
    resetClaudeBinaryCache();

    const a = recordingProvider();
    const claudeOptions = await optionsForOneTurn(a.provider, a.requests, {});
    expect(claudeOptions.pathToClaudeCodeExecutable).toBe(claudeBin);
    expect(claudeOptions.codex).toBeUndefined();

    const b = recordingProvider();
    const codexOptions = await optionsForOneTurn(b.provider, b.requests, { provider: "codex" });
    expect(codexOptions.codex.pathOverride).toBe(codexBin);
  });
});
