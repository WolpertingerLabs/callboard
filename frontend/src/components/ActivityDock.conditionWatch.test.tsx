// @vitest-environment jsdom
/**
 * The between-polls line for a condition watch, and the watch that is no
 * longer being polled.
 *
 * Once `wait` refuses further attempts the backend keeps the watch, marked
 * `exhausted`, purely so re-naming the same condition cannot mint a fresh
 * budget. It is not an open obligation (`hasOpenConditionWatch` says no, and
 * #466 stopped nudging on it), so a line reading "Checking: … (attempt 10/10)"
 * claimed work nobody was doing — for as long as the session lived.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ConditionWatch } from "../api";
import ActivityDock from "./ActivityDock";

afterEach(cleanup);

const noop = async () => {};

function watch(overrides: Partial<ConditionWatch> = {}): ConditionWatch {
  return {
    id: "w1",
    chatId: "c1",
    text: "CI to finish",
    attempts: 3,
    maxAttempts: 10,
    firstStartedAt: Date.now() - 60_000,
    lastCheckedAt: Date.now(),
    ...overrides,
  };
}

describe("ActivityDock — condition watch", () => {
  it("shows an open watch between polls", () => {
    render(<ActivityDock activities={[]} conditionWatch={watch()} awaitingChildren={1} onRelease={noop} />);
    expect(screen.getByText(/Checking: CI to finish \(attempt 3\/10\)/)).toBeTruthy();
  });

  it("does not claim to be checking a watch whose attempts are used up", () => {
    render(<ActivityDock activities={[]} conditionWatch={watch({ attempts: 10, exhausted: true })} awaitingChildren={1} onRelease={noop} />);
    expect(screen.queryByText(/CI to finish/)).toBeNull();
    // The rest of the row is unaffected.
    expect(screen.getByText("Awaiting 1 spawned chat")).toBeTruthy();
  });
});
