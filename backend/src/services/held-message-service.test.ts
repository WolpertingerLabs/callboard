import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/paths.js";
import { sessionRegistry } from "./session-registry.js";
import { heldMessageService, PAUSE_REASON_BLOCKED, PAUSE_REASON_RESTARTED, isValidHeldChatId } from "./held-message-service.js";

let n = 0;
const freshChat = () => `held-svc-${++n}`;

describe("heldMessageService", () => {
  it("lists items in the order they were added, with the given settings", () => {
    const chat = freshChat();
    const a = heldMessageService.add(chat, { text: "one", model: "opus", effort: "high", maxTurns: 5, activePlugins: ["p"] });
    const b = heldMessageService.add(chat, { text: "two", images: [{ id: "00000000-0000-4000-8000-000000000001", originalName: "x.png" }] });
    const list = heldMessageService.list(chat);
    expect(list.map((m) => m.id)).toEqual([a.id, b.id]);
    expect(list[0]).toMatchObject({ chatId: chat, text: "one", state: "queued", model: "opus", effort: "high", maxTurns: 5, activePlugins: ["p"] });
    expect(list[1]!.images).toHaveLength(1);
  });

  it("take removes and returns the item atomically; a second take is not_found", () => {
    const chat = freshChat();
    const a = heldMessageService.add(chat, { text: "one" });
    heldMessageService.add(chat, { text: "two" });
    const first = heldMessageService.take(chat, a.id);
    expect(first).toMatchObject({ ok: true, item: { id: a.id, text: "one" } });
    expect(heldMessageService.take(chat, a.id)).toEqual({ ok: false, reason: "not_found" });
    expect(heldMessageService.list(chat).map((m) => m.text)).toEqual(["two"]);
  });

  it("refuses to take or remove an item that is delivering", () => {
    const chat = freshChat();
    const a = heldMessageService.add(chat, { text: "one" });
    expect(heldMessageService.claimNext(chat)?.id).toBe(a.id);
    expect(heldMessageService.take(chat, a.id)).toEqual({ ok: false, reason: "delivering" });
    expect(heldMessageService.remove(chat, a.id)).toEqual({ ok: false, reason: "delivering" });
    expect(heldMessageService.list(chat)[0]!.state).toBe("delivering");
  });

  it("claims one item at a time, first queued first, skipping paused ones", () => {
    const chat = freshChat();
    const a = heldMessageService.add(chat, { text: "one" });
    heldMessageService.pause(chat, "stopped");
    const b = heldMessageService.add(chat, { text: "two" });
    const c = heldMessageService.add(chat, { text: "three" });
    expect(heldMessageService.claimNext(chat)?.id).toBe(b.id);
    // One in flight: nothing else is claimed until it resolves.
    expect(heldMessageService.claimNext(chat)).toBeUndefined();
    heldMessageService.removeDelivered(chat, b.id);
    expect(heldMessageService.claimNext(chat)?.id).toBe(c.id);
    expect(heldMessageService.list(chat).find((m) => m.id === a.id)?.state).toBe("paused");
  });

  it("pause and resume move queued ↔ paused, and resume re-queues failed items", () => {
    const chat = freshChat();
    const a = heldMessageService.add(chat, { text: "one" });
    const b = heldMessageService.add(chat, { text: "two" });
    expect(heldMessageService.pause(chat, "You stopped the run.")).toBe(2);
    expect(heldMessageService.list(chat).every((m) => m.state === "paused" && m.reason === "You stopped the run.")).toBe(true);
    expect(heldMessageService.resume(chat)).toBe(2);
    expect(heldMessageService.list(chat).every((m) => m.state === "queued" && m.reason === undefined)).toBe(true);

    heldMessageService.claimNext(chat);
    heldMessageService.markFailed(chat, a.id, "branch moved");
    const after = heldMessageService.list(chat);
    expect(after[0]).toMatchObject({ id: a.id, state: "failed", reason: "branch moved" });
    // What was queued behind a failure is paused, so it cannot overtake it.
    expect(after[1]).toMatchObject({ id: b.id, state: "paused", reason: PAUSE_REASON_BLOCKED });
    expect(heldMessageService.resume(chat)).toBe(2);
    expect(heldMessageService.claimNext(chat)?.id).toBe(a.id);
  });

  it("pauseAllOnBoot pauses queued and delivering items in every chat, leaving failed ones", () => {
    const one = freshChat();
    const two = freshChat();
    heldMessageService.add(one, { text: "a" });
    heldMessageService.add(one, { text: "b" });
    heldMessageService.claimNext(one);
    const f = heldMessageService.add(two, { text: "c" });
    heldMessageService.claimNext(two);
    heldMessageService.markFailed(two, f.id, "nope");

    expect(heldMessageService.pauseAllOnBoot()).toBeGreaterThanOrEqual(2);
    expect(heldMessageService.list(one).map((m) => [m.state, m.reason])).toEqual([
      ["paused", PAUSE_REASON_RESTARTED],
      ["paused", PAUSE_REASON_RESTARTED],
    ]);
    expect(heldMessageService.list(two)[0]).toMatchObject({ state: "failed", reason: "nope" });
  });

  it("refuses path-traversal chat ids", () => {
    expect(isValidHeldChatId("../victim")).toBe(false);
    expect(isValidHeldChatId("a/b")).toBe(false);
    expect(isValidHeldChatId("")).toBe(false);
    expect(isValidHeldChatId("6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab")).toBe(true);
    expect(() => heldMessageService.add("../victim", { text: "x" })).toThrow(/Invalid chat id/);
    expect(heldMessageService.list("../victim")).toEqual([]);
    expect(existsSync(join(DATA_DIR, "victim.json"))).toBe(false);
  });

  it("deleteAll drops the chat's file", () => {
    const chat = freshChat();
    heldMessageService.add(chat, { text: "a" });
    expect(readdirSync(join(DATA_DIR, "held"))).toContain(`${chat}.json`);
    heldMessageService.deleteAll(chat);
    expect(heldMessageService.list(chat)).toEqual([]);
    expect(readdirSync(join(DATA_DIR, "held"))).not.toContain(`${chat}.json`);
  });

  it("signals clients on every write, and not when nothing changed (#3)", () => {
    const chat = freshChat();
    const spy = vi.spyOn(sessionRegistry, "notifyMetadata");
    try {
      const a = heldMessageService.add(chat, { text: "a" });
      heldMessageService.claimNext(chat);
      heldMessageService.markFailed(chat, a.id, "nope");
      heldMessageService.resume(chat);
      heldMessageService.take(chat, a.id);
      expect(spy.mock.calls).toHaveLength(5);
      expect(spy.mock.calls.every(([id, data]) => id === chat && JSON.stringify(data) === '{"heldMessages":true}')).toBe(true);

      spy.mockClear();
      heldMessageService.deleteAll(chat); // already empty
      heldMessageService.pause(chat, "x"); // nothing queued
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("sets an unreadable file aside instead of letting the next add overwrite it (#6)", () => {
    const chat = freshChat();
    const dir = join(DATA_DIR, "held");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${chat}.json`), "{ not json");

    expect(heldMessageService.list(chat)).toEqual([]);
    const aside = readdirSync(dir).filter((f) => f.startsWith(`${chat}.json.corrupt-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe("{ not json");

    heldMessageService.add(chat, { text: "fresh" });
    expect(heldMessageService.list(chat).map((m) => m.text)).toEqual(["fresh"]);
    // The boot scan only reads *.json, so the set-aside copy is left alone.
    expect(() => heldMessageService.pauseAllOnBoot()).not.toThrow();
    expect(readdirSync(dir)).toContain(aside[0]);
  });

  it("does not set a file aside for a read error that is not bad content, and refuses to write over it (round 2 #4)", () => {
    const chat = freshChat();
    const dir = join(DATA_DIR, "held");
    // A directory where the file should be: readFileSync fails with EISDIR,
    // standing in for EMFILE / EACCES without needing root to provoke them.
    mkdirSync(join(dir, `${chat}.json`), { recursive: true });

    expect(heldMessageService.list(chat)).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.startsWith(`${chat}.json.corrupt-`))).toEqual([]);
    expect(existsSync(join(dir, `${chat}.json`))).toBe(true);
    // A read-modify-write must not replace what it could not read.
    expect(() => heldMessageService.add(chat, { text: "x" })).toThrow(/could not be read/);
    expect(() => heldMessageService.pauseAllOnBoot()).not.toThrow();
  });
});
