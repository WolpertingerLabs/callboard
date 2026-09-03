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
    expect(head.style.flex).toBe("0 1 auto");
    expect(head.style.textOverflow).toBe("ellipsis");
    expect(tail.style.flex).toBe("0 0 auto");
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
