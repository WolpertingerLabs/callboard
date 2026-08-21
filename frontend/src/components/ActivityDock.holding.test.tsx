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
 * The second test is the compatibility half. Activities cross REST, where
 * there is no capability handshake to gate a new `ActivityKind` behind, so a
 * tab running an older bundle can be handed a kind it has never heard of. It
 * must read as vague, not as "· undefined".
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

  it("falls back to a neutral verb for a kind this bundle predates", () => {
    // What an old tab does against a newer daemon. Before the fallback this
    // rendered the literal string "undefined".
    const future = holding({ kind: "some_future_kind" as ChatActivity["kind"], label: "something" });
    render(<ActivityDock activities={[future]} conditionWatch={null} awaitingChildren={0} onRelease={noop} />);
    expect(screen.getByText("· Busy")).toBeTruthy();
    expect(screen.queryByText("· undefined")).toBeNull();
  });
});
