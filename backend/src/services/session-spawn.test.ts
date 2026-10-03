import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitChatCreated, toPromptIterable, unattendedPermissions } from "./session-spawn.js";

const opts = { timeoutMs: 1000, timeoutMessage: "timed out", failMessage: "failed to start" };

afterEach(() => {
  vi.useRealTimers();
});

describe("awaitChatCreated", () => {
  it("resolves with the chat id and detaches its listener", async () => {
    const emitter = new EventEmitter();
    const pending = awaitChatCreated(emitter, opts);
    emitter.emit("event", { type: "text", content: "noise" });
    emitter.emit("event", { type: "chat_created", chatId: "chat-1" });
    await expect(pending).resolves.toBe("chat-1");
    expect(emitter.listenerCount("event")).toBe(0);
  });

  it("ignores a chat_created with no id", async () => {
    const emitter = new EventEmitter();
    const pending = awaitChatCreated(emitter, opts);
    emitter.emit("event", { type: "chat_created" });
    emitter.emit("event", { type: "chat_created", chatId: "chat-2" });
    await expect(pending).resolves.toBe("chat-2");
  });

  it("rejects with the error event's content, else the fallback message, and detaches", async () => {
    const a = new EventEmitter();
    const withContent = awaitChatCreated(a, opts);
    a.emit("event", { type: "error", content: "boom" });
    await expect(withContent).rejects.toThrow("boom");
    expect(a.listenerCount("event")).toBe(0);

    const b = new EventEmitter();
    const without = awaitChatCreated(b, opts);
    b.emit("event", { type: "error" });
    await expect(without).rejects.toThrow("failed to start");
  });

  it("rejects with the timeout message after timeoutMs and detaches", async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const pending = awaitChatCreated(emitter, opts);
    const assertion = expect(pending).rejects.toThrow("timed out");
    vi.advanceTimersByTime(1000);
    await assertion;
    expect(emitter.listenerCount("event")).toBe(0);
  });
});

describe("toPromptIterable", () => {
  it("yields exactly one plain-text user message", async () => {
    const out: unknown[] = [];
    for await (const m of toPromptIterable("hello")) out.push(m);
    expect(out).toEqual([{ type: "user", message: { role: "user", content: "hello" } }]);
  });
});

describe("unattendedPermissions", () => {
  it("allows every axis but computer control, as a fresh object each call", () => {
    const p = unattendedPermissions();
    expect(p).toEqual({ fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "deny" });
    expect(unattendedPermissions()).not.toBe(p);
  });
});
