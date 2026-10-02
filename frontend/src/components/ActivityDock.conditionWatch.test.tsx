// @vitest-environment jsdom
/**
 * The between-polls line for a condition watch, and the watch that is no
 * longer being polled.
 *
 * Between two `wait` cycles `GET /activity` returns no activities and the
 * watch, still open: the agent is doing its check. The dock's early return
 * only looked at activities and awaited children, so that state rendered
 * nothing and the row blinked out for every check — unless the chat happened
 * to also be awaiting a spawned chat, the one case the line ever appeared in.
 *
 * Once `wait` refuses further attempts the backend keeps the watch, marked
 * `exhausted`, purely so re-naming the same condition cannot mint a fresh
 * budget. It is not an open obligation (`hasOpenConditionWatch` says no, and
 * #466 stopped nudging on it), so a line reading "Checking: … (attempt 10/10)"
 * claimed work nobody was doing — for as long as the session lived.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatActivity, ConditionWatch } from "../api";
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

function conditionWait(): ChatActivity {
  return {
    id: "a1",
    chatId: "c1",
    kind: "wait",
    label: "Waiting on CI",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    interruptible: true,
    condition: { text: "CI to finish", attempt: 4, maxAttempts: 10 },
  };
}

describe("ActivityDock — condition watch", () => {
  it("keeps the row up between polls for an open watch on its own", () => {
    render(<ActivityDock activities={[]} conditionWatch={watch()} awaitingChildren={0} onRelease={noop} />);
    expect(screen.getByText(/Checking: CI to finish \(attempt 3\/10\)/)).toBeTruthy();
  });

  it("lets a long check line wrap beside the dot rather than below it", () => {
    // As one flex item with an auto basis, a line too long for the space next
    // to the dot wrapped whole, leaving the dot alone on the first line (63px
    // vs 48px at 320–390px in Chromium). A zero basis keeps it on the dot's line.
    render(<ActivityDock activities={[]} conditionWatch={watch()} awaitingChildren={0} onRelease={noop} />);
    const line = screen.getByText(/Checking:/);
    expect(line.style.flexBasis).toMatch(/^0(px)?$/);
    expect(line.style.flexGrow).toBe("1");
    expect(line.style.minWidth).toMatch(/^0(px)?$/);
  });

  it("shows an open watch between polls alongside awaited children", () => {
    render(<ActivityDock activities={[]} conditionWatch={watch()} awaitingChildren={1} onRelease={noop} />);
    expect(screen.getByText(/Checking: CI to finish \(attempt 3\/10\)/)).toBeTruthy();
    expect(screen.getByText("Awaiting 1 spawned chat")).toBeTruthy();
  });

  it("renders nothing for an exhausted watch with nothing else going on", () => {
    const { container } = render(
      <ActivityDock activities={[]} conditionWatch={watch({ attempts: 10, exhausted: true })} awaitingChildren={0} onRelease={noop} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("does not claim to be checking a watch whose attempts are used up", () => {
    render(<ActivityDock activities={[]} conditionWatch={watch({ attempts: 10, exhausted: true })} awaitingChildren={1} onRelease={noop} />);
    expect(screen.queryByText(/CI to finish/)).toBeNull();
    // The rest of the row is unaffected.
    expect(screen.getByText("Awaiting 1 spawned chat")).toBeTruthy();
  });

  it("takes the row down when the watch closes, is exhausted, or the session clears it", () => {
    const { container, rerender } = render(<ActivityDock activities={[]} conditionWatch={watch()} awaitingChildren={0} onRelease={noop} />);
    expect(container.firstChild).not.toBeNull();

    // wait_condition_met, or session teardown: the server drops the watch.
    rerender(<ActivityDock activities={[]} conditionWatch={null} awaitingChildren={0} onRelease={noop} />);
    expect(container.firstChild).toBeNull();

    rerender(<ActivityDock activities={[]} conditionWatch={watch()} awaitingChildren={0} onRelease={noop} />);
    rerender(<ActivityDock activities={[]} conditionWatch={watch({ attempts: 10, exhausted: true })} awaitingChildren={0} onRelease={noop} />);
    expect(container.firstChild).toBeNull();
  });

  it("stays one row through a wait → check → wait cycle", () => {
    const { container, rerender } = render(<ActivityDock activities={[conditionWait()]} conditionWatch={watch()} awaitingChildren={0} onRelease={noop} />);
    const row = container.firstChild;
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(screen.getByText(/waiting for: CI to finish \(attempt 4\/10\)/)).toBeTruthy();

    rerender(<ActivityDock activities={[]} conditionWatch={watch({ attempts: 4 })} awaitingChildren={0} onRelease={noop} />);
    // The same elements, not a remount: nothing for the layout to reflow
    // around, and the dot's bounce does not restart on every swap.
    expect(container.firstChild).toBe(row);
    expect(container.querySelector('[aria-hidden="true"]')).toBe(dot);
    expect(screen.getByText(/Checking: CI to finish \(attempt 4\/10\)/)).toBeTruthy();
  });
});
