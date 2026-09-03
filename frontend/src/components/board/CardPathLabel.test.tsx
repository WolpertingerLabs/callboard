/**
 * The label's contract is a layout one, and jsdom computes no layout — so
 * these assert the two things that survive without a layout engine: the split
 * point, and the flex rules that give the tail priority over the head. Getting
 * those wrong is what would silently turn middle truncation back into the
 * plain end-truncation everything else on the tile already does.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CardPathLabel from "./CardPathLabel";

afterEach(cleanup);

function parts(container: HTMLElement) {
  return [...container.querySelectorAll("span > span")].map((el) => el.textContent);
}

describe("CardPathLabel", () => {
  it("keeps the last two segments whole and lets the head shrink", () => {
    const { container } = render(<CardPathLabel path="/home/cybil/some/deep/proj/callboard/frontend" />);
    expect(parts(container)).toEqual(["/home/cybil/some/deep/proj/", "callboard/frontend"]);

    const [head, tail] = container.querySelectorAll<HTMLElement>("span > span");
    // 999 against the tail's 1: the head takes essentially all the shrinkage.
    expect(head.style.flex).toBe("0 999 auto");
    expect(head.style.textOverflow).toBe("ellipsis");
    expect(tail.style.flex).toBe("0 1 auto");
  });

  it("truncates a tail too long for the label instead of spilling out of it", () => {
    // A single-segment leaf: there is no head to give up, so the tail is the
    // only thing that can yield. Real remainders reach 82 characters, which at
    // 11px is wider than the 260px tile this sits in.
    const leaf = `/${"deeply-named-worktree".repeat(4)}`;
    const { container } = render(<CardPathLabel path={leaf} />);
    const root = container.firstElementChild as HTMLElement;
    const tail = root.querySelector<HTMLElement>("span")!;

    // jsdom lays nothing out, so the assertion is the CSS contract that makes
    // the escape impossible: a shrinkable, clippable tail inside a clipping
    // container. `flex: 0 0 auto` with no overflow rule is what used to spill.
    expect(root.style.overflow).toBe("hidden");
    expect(tail.style.flex).toBe("0 1 auto");
    expect(tail.style.minWidth).toBe("0");
    expect(tail.style.overflow).toBe("hidden");
    expect(tail.style.textOverflow).toBe("ellipsis");
  });

  it("renders tail-only when there is nothing to elide", () => {
    const { container } = render(<CardPathLabel path="/home/cybil" />);
    expect(parts(container)).toEqual(["/home/cybil"]);
  });

  it("strips a hoisted prefix but still hovers the full path", () => {
    render(<CardPathLabel path="/home/cybil/countinghouse.feat-analytics" prefix="/home/cybil" />);
    const label = screen.getByTitle("/home/cybil/countinghouse.feat-analytics");
    expect(label.textContent).toBe("countinghouse.feat-analytics");
  });

  it("titles the full path even when nothing was dropped", () => {
    render(<CardPathLabel path="/home/cybil/callboard" />);
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
  });

  it("can shrink, which is what makes the head ellipsize instead of overflowing", () => {
    const { container } = render(<CardPathLabel path="/a/b/c/d" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.display).toBe("flex");
    expect(root.style.minWidth).toBe("0");
  });
});
