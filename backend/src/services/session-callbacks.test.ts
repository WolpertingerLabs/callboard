/**
 * Unit tests for the phone-home callback store's guarded registration.
 *
 * DATA_DIR is resolved from CALLBOARD_DATA_DIR when utils/paths.js first loads,
 * so the env var is set before the store module is imported (hence the
 * top-level dynamic import) — this file gets its own throwaway data dir, and
 * writes agent-settings.json into it to exercise the real limit lookups.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-session-callbacks-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { registerCompletionCallback, markChildComplete, getReadyForParent, removeCallbacks, countPending, setChatDepth, DEFAULT_MAX_CALLBACK_CHAIN_DEPTH } =
  await import("./session-callbacks.js");

const storePath = join(tmpRoot, "session-callbacks.json");
const settingsPath = join(tmpRoot, "agent-settings.json");

function setLimits(limits: { maxCallbackChainDepth?: number; maxPendingCallbacks?: number }): void {
  writeFileSync(settingsPath, JSON.stringify({ proxyMode: "local", ...limits }, null, 2));
}

beforeEach(() => {
  if (existsSync(storePath)) rmSync(storePath);
  if (existsSync(settingsPath)) rmSync(settingsPath);
});

afterEach(() => {
  if (existsSync(storePath)) rmSync(storePath);
  if (existsSync(settingsPath)) rmSync(settingsPath);
});

describe("registerCompletionCallback", () => {
  it("registers a callback at parent depth + 1 and preserves its kind", () => {
    const result = registerCompletionCallback({ childChatId: "child-1", parentChatId: "parent-1", kind: "continued" });

    expect(result.registered).toBe(true);
    expect(result.id).toBeTruthy();
    expect(countPending()).toBe(1);

    // Round-trips through disk: the delivery engine reads what we wrote.
    markChildComplete("child-1");
    const [ready] = getReadyForParent("parent-1");
    expect(ready.kind).toBe("continued");
    expect(ready.depth).toBe(1);
    expect(ready.status).toBe("ready");
  });

  it("inherits the parent's callback-chain depth", () => {
    setChatDepth("parent-1", 3);

    registerCompletionCallback({ childChatId: "child-1", parentChatId: "parent-1", kind: "spawned" });

    markChildComplete("child-1");
    expect(getReadyForParent("parent-1")[0].depth).toBe(4);
  });

  it("skips registration when there is no parent chat context", () => {
    const result = registerCompletionCallback({ childChatId: "child-1", parentChatId: undefined, kind: "continued" });

    expect(result.registered).toBe(false);
    expect(result.note).toMatch(/No parent chat context/);
    expect(countPending()).toBe(0);
  });

  it("skips registration past the chain-depth limit", () => {
    setChatDepth("parent-1", DEFAULT_MAX_CALLBACK_CHAIN_DEPTH);

    const result = registerCompletionCallback({ childChatId: "child-1", parentChatId: "parent-1", kind: "continued" });

    expect(result.registered).toBe(false);
    expect(result.note).toMatch(/depth limit reached/);
    // Wording tracks the tool: continue_chat sends a message, it does not start a session.
    expect(result.note).toMatch(/The message was sent/);
    expect(countPending()).toBe(0);
  });

  it("skips registration past the pending-callback limit", () => {
    setLimits({ maxPendingCallbacks: 1 });

    expect(registerCompletionCallback({ childChatId: "child-1", parentChatId: "parent-1", kind: "spawned" }).registered).toBe(true);
    const second = registerCompletionCallback({ childChatId: "child-2", parentChatId: "parent-1", kind: "spawned" });

    expect(second.registered).toBe(false);
    expect(second.note).toMatch(/Pending callback limit reached/);
    expect(second.note).toMatch(/The session was started/);
    expect(countPending()).toBe(1);
  });

  it("honours a limit of 0 as 'no new callbacks'", () => {
    setLimits({ maxCallbackChainDepth: 0, maxPendingCallbacks: 0 });

    expect(registerCompletionCallback({ childChatId: "child-1", parentChatId: "parent-1", kind: "spawned" }).registered).toBe(false);
    expect(countPending()).toBe(0);
  });

  it("can be rolled back by id when the send it was registered for fails", () => {
    const { id } = registerCompletionCallback({ childChatId: "child-1", parentChatId: "parent-1", kind: "continued" });
    expect(countPending()).toBe(1);

    removeCallbacks([id!]);

    expect(countPending()).toBe(0);
    // Nothing left to promote — the parent is not notified about a send that never happened.
    expect(markChildComplete("child-1")).toEqual([]);
    expect(getReadyForParent("parent-1")).toEqual([]);
  });
});
