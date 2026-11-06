// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WORKTREE_CREATE_TIMEOUT_MS } from "shared/types/git.js";
import WorktreeCreationIndicator from "./WorktreeCreationIndicator";

const START = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Move the clock and let the indicator's tick land. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const elapsed = () => screen.getByTestId("worktree-creation-elapsed").textContent;
const remaining = () => screen.getByTestId("worktree-creation-remaining").textContent;
const bar = () => screen.getByTestId("worktree-creation-bar");

describe("WorktreeCreationIndicator", () => {
  it("says creation has started, at zero elapsed and the full budget left", () => {
    render(<WorktreeCreationIndicator startedAt={START} onCancel={() => {}} />);
    expect(screen.getByRole("status", { name: "Creating worktree" })).toBeTruthy();
    expect(screen.getByText("Creating worktree…")).toBeTruthy();
    expect(elapsed()).toBe("0s elapsed");
    expect(remaining()).toBe("1:00 left");
    expect(bar().style.width).toBe("0%");
  });

  it("measures against the shared 60s timeout the daemon kills git at", () => {
    expect(WORKTREE_CREATE_TIMEOUT_MS).toBe(60_000);
    render(<WorktreeCreationIndicator startedAt={START} onCancel={() => {}} />);
    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuemax")).toBe("60");
  });

  it("ticks: elapsed goes up, remaining goes down, the bar fills", () => {
    render(<WorktreeCreationIndicator startedAt={START} onCancel={() => {}} />);
    advance(15_000);
    expect(elapsed()).toBe("15s elapsed");
    expect(remaining()).toBe("45s left");
    expect(bar().style.width).toBe("25%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("15");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("45s of 1:00 left");
  });

  it("turns to the warning colour in the last quarter, and says it is timing out at the end", () => {
    render(<WorktreeCreationIndicator startedAt={START} onCancel={() => {}} />);
    advance(30_000);
    expect(bar().style.background).toBe("var(--accent)");
    advance(16_000);
    expect(bar().style.background).toBe("var(--warning)");
    advance(20_000);
    expect(elapsed()).toBe("1:06 elapsed");
    expect(remaining()).toBe("timing out…");
    // Clamped, not past the end.
    expect(bar().style.width).toBe("100%");
  });

  it("honours a different budget", () => {
    render(<WorktreeCreationIndicator startedAt={START} onCancel={() => {}} timeoutMs={10_000} />);
    advance(5_000);
    expect(remaining()).toBe("5s left");
    expect(bar().style.width).toBe("50%");
  });

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(<WorktreeCreationIndicator startedAt={START} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
