// @vitest-environment jsdom
/**
 * `awaitingChatIds` — the poll's `awaitingInput`, which paints the sidebar's
 * yellow "waiting on you" dot. Replaced together with `sessions` (same
 * version), and empty against a daemon that never sends the field.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { SessionProvider, useSessionContext } from "./SessionContext";

let version = 1;
let awaitingInput: string[] | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  version = 1;
  awaitingInput = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const body: Record<string, unknown> = { version, metadataVersion: 1 };
      if (params.get("v") !== String(version)) {
        body.sessions = { a: { type: "web", startedAt: 1 } };
        if (awaitingInput !== undefined) body.awaitingInput = awaitingInput;
      }
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
  const seen: Set<string>[] = [];
  function Probe() {
    seen.push(useSessionContext().awaitingChatIds);
    return null;
  }
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  return seen;
}

it("reads awaitingInput into a set, and follows it when the version moves", async () => {
  awaitingInput = ["a", "b"];
  const seen = mount();
  await settle();
  expect([...seen.at(-1)!].sort()).toEqual(["a", "b"]);

  awaitingInput = [];
  version = 2;
  await nextPoll();
  expect(seen.at(-1)!.size).toBe(0);
});

it("is empty when the daemon does not send the field", async () => {
  const seen = mount();
  await settle();
  await nextPoll();
  expect(seen.at(-1)!.size).toBe(0);
});
