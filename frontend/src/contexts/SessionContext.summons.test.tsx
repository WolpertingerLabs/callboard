// @vitest-environment jsdom
/**
 * Summon notifications and the `summonedChatIds` set, driven through the poll.
 *
 * The notification used to be fired from inside a `setState` updater, which
 * React is free to run more than once; it now fires from the poll itself. What
 * must not change is *when*: once per summon that newly appears, never again
 * while it stays. And a poll whose summons have the same membership must not
 * hand consumers a new Set — that is a re-render of every subscriber for nothing.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { SessionProvider, useSessionContext } from "./SessionContext";

let metadataVersion = 1;
let summons: Record<string, { message: string; urgency: "normal" | "urgent"; createdAt: string }> = {};

const notifications: { title: string; options?: NotificationOptions }[] = [];
class FakeNotification {
  static permission = "granted";
  constructor(title: string, options?: NotificationOptions) {
    notifications.push({ title, options });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  metadataVersion = 1;
  summons = {};
  notifications.length = 0;
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const body: Record<string, unknown> = { version: 1, metadataVersion };
      if (params.get("mv") !== String(metadataVersion)) body.activeSummons = summons;
      return { ok: true, json: async () => body } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function nextPoll() {
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  await settle();
}

function mount() {
  const sets: Set<string>[] = [];
  function Probe() {
    sets.push(useSessionContext().summonedChatIds);
    return null;
  }
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  return sets;
}

const urgent = (message: string) => ({ message, urgency: "urgent" as const, createdAt: "2026-01-01T00:00:00Z" });

it("notifies once per newly-appeared urgent summon, and not again while it stays", async () => {
  summons = { a: urgent("look at a") };
  const sets = mount();
  await settle();
  expect(notifications).toEqual([{ title: "Agent needs your attention", options: { body: "look at a", tag: "summon-a" } }]);
  expect([...sets.at(-1)!]).toEqual(["a"]);

  // Metadata moves for an unrelated reason; `a` is still summoned.
  metadataVersion = 2;
  await nextPoll();
  expect(notifications).toHaveLength(1);

  // A second summon appears beside it — only that one notifies.
  metadataVersion = 3;
  summons = { a: urgent("look at a"), b: urgent("look at b") };
  await nextPoll();
  expect(notifications.map((n) => n.options?.tag)).toEqual(["summon-a", "summon-b"]);
  expect([...sets.at(-1)!].sort()).toEqual(["a", "b"]);
});

it("does not notify for a normal-urgency summon, but still tracks it", async () => {
  summons = { a: { ...urgent("quiet"), urgency: "normal" } };
  const sets = mount();
  await settle();
  expect(notifications).toHaveLength(0);
  expect([...sets.at(-1)!]).toEqual(["a"]);
});

it("keeps the same Set when membership is unchanged", async () => {
  summons = { a: urgent("look at a") };
  const sets = mount();
  await settle();
  const before = sets.at(-1);

  metadataVersion = 2;
  await nextPoll();
  expect(sets.at(-1)).toBe(before);

  // Membership changes → a new Set.
  metadataVersion = 3;
  summons = {};
  await nextPoll();
  expect(sets.at(-1)).not.toBe(before);
  expect(sets.at(-1)!.size).toBe(0);
});
