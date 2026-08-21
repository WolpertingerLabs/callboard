// @vitest-environment jsdom
/**
 * The dock's third busy state, and the lookup that has to survive not knowing
 * about it.
 *
 * A background-task hold keeps a session's subprocess alive past the end of a
 * turn so a `run_in_background` shell can finish. It registered nothing, so a
 * chat deliberately holding open rendered as idle and finished — the `wait`
 * tool and `onComplete` callbacks both had a row and this did not.
 *
 * The third test is about the *next* kind, not this one. Activities cross REST,
 * where there is no capability handshake to gate a new `ActivityKind` behind,
 * so this bundle can be handed a kind it has never heard of and must read as
 * vague rather than as "· undefined".
 *
 * What it does not and cannot cover: a tab running a bundle older than the
 * fallback. That code ships in the client, so the clients at risk from
 * `"holding"` are precisely the ones without it. See the note in
 * `shared/types/activity.ts` — the exposure is real, cosmetic, and self-heals
 * on reload.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatActivity } from "../api";
import ActivityDock from "./ActivityDock";

afterEach(cleanup);

const noop = async () => {};

function holding(overrides: Partial<ChatActivity> = {}): ChatActivity {
  return {
    id: "a1",
    chatId: "c1",
    kind: "holding",
    label: "2 background tasks",
    detail: "bc0j6hx72, bn5stt7dr",
    startedAt: Date.now(),
    expiresAt: Date.now() + 15 * 60_000,
    interruptible: false,
    ...overrides,
  };
}

describe("ActivityDock — background-task hold", () => {
  it("shows the hold, its tasks and its remaining window", () => {
    render(<ActivityDock activities={[holding()]} conditionWatch={null} awaitingChildren={0} onRelease={noop} />);
    expect(screen.getByText("2 background tasks")).toBeTruthy();
    expect(screen.getByText("· bc0j6hx72, bn5stt7dr")).toBeTruthy();
    expect(screen.getByText("· Holding the session open")).toBeTruthy();
    // Ceil of just-under-15m, from the same arithmetic every other kind uses.
    expect(screen.getByText(/15:00 left|14:59 left/)).toBeTruthy();
  });

  it("offers no release button — ending a hold kills the shells it protects", () => {
    render(<ActivityDock activities={[holding()]} conditionWatch={null} awaitingChildren={0} onRelease={noop} />);
    expect(screen.queryByText("End wait")).toBeNull();
  });

  it("falls back to a neutral verb for a kind added after this bundle was built", () => {
    // Forward compatibility for the kind *after* "holding": this bundle has
    // the fallback, so a daemon that grows a new kind cannot make it render
    // the literal string "undefined".
    //
    // Not a test of what an older tab does with "holding" — an older tab does
    // not have this code. That case is unmitigable from here and is documented
    // in shared/types/activity.ts rather than pretended away.
    const future = holding({ kind: "some_future_kind" as ChatActivity["kind"], label: "something" });
    render(<ActivityDock activities={[future]} conditionWatch={null} awaitingChildren={0} onRelease={noop} />);
    expect(screen.getByText("· Busy")).toBeTruthy();
    expect(screen.queryByText("· undefined")).toBeNull();
  });
});
