/**
 * The highlight painter against a stand-in for the CSS Custom Highlight API
 * (jsdom has none): which names it sets, with which ranges, how the active
 * aside is emphasised, that a transcript change repaints, that it clears up,
 * and that it does nothing where the API is missing.
 */
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ParsedMessage } from "../api";
import type { AsideEntry } from "../utils/asideHighlights";
import { ASIDE_HIGHLIGHT, ASIDE_HIGHLIGHT_ACTIVE, asideAtPoint, asideHighlightsSupported, useAsideHighlights } from "./useAsideHighlights";

class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
let registry: Map<string, FakeHighlight>;

beforeEach(() => {
  registry = new Map();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const messages: ParsedMessage[] = [
  { role: "user", type: "text", content: "", timestamp: "t0" },
  { role: "assistant", type: "text", content: "", timestamp: "t1" },
];
const aside = (chatId: string, text: string): AsideEntry => ({
  chatId,
  title: chatId,
  status: "stopped",
  provider: "claude-code",
  createdAt: "",
  updatedAt: "",
  quotes: [{ timestamp: "t1", role: "assistant", text }],
});

function Transcript({ asides, activeIds, body = "alpha beta gamma" }: { asides: AsideEntry[]; activeIds: string[]; body?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useAsideHighlights({ containerRef: ref, messages, asides, activeIds, enabled: true });
  return (
    <div ref={ref}>
      <div data-message-index="0">
        <div data-quote-content="">question</div>
      </div>
      <div data-message-index="1">
        <div data-quote-content="">{body}</div>
      </div>
    </div>
  );
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));
const painted = (name: string) => registry.get(name)?.ranges.map((r) => r.toString());

it("paints every aside's passages, and the active one again on top", async () => {
  const asides = [aside("a", "alpha"), aside("b", "gamma")];
  const { rerender } = render(<Transcript asides={asides} activeIds={[]} />);
  await flush();
  expect(painted(ASIDE_HIGHLIGHT)).toEqual(["alpha", "gamma"]);
  expect(registry.has(ASIDE_HIGHLIGHT_ACTIVE)).toBe(false);

  rerender(<Transcript asides={asides} activeIds={["b"]} />);
  await flush();
  expect(painted(ASIDE_HIGHLIGHT_ACTIVE)).toEqual(["gamma"]);
  expect(registry.get(ASIDE_HIGHLIGHT_ACTIVE)!.priority).toBeGreaterThan(registry.get(ASIDE_HIGHLIGHT)!.priority);
});

it("re-finds the passages when the transcript re-renders", async () => {
  const asides = [aside("a", "delta")];
  const { rerender } = render(<Transcript asides={asides} activeIds={[]} />);
  await flush();
  expect(registry.has(ASIDE_HIGHLIGHT)).toBe(false); // not there yet: nothing painted
  rerender(<Transcript asides={asides} activeIds={[]} body="now with delta in it" />);
  await flush();
  expect(painted(ASIDE_HIGHLIGHT)).toEqual(["delta"]);
});

it("clears its highlights on unmount", async () => {
  const { unmount } = render(<Transcript asides={[aside("a", "alpha")]} activeIds={["a"]} />);
  await flush();
  expect(registry.size).toBe(2);
  unmount();
  expect(registry.size).toBe(0);
});

it("does nothing where the Highlight API is missing", async () => {
  vi.stubGlobal("CSS", {});
  expect(asideHighlightsSupported()).toBe(false);
  render(<Transcript asides={[aside("a", "alpha")]} activeIds={["a"]} />);
  await flush();
  expect(registry.size).toBe(0);
});

it("hit-tests a point against the painted ranges", () => {
  const range = { getClientRects: () => [{ left: 10, right: 50, top: 10, bottom: 20 }] } as unknown as Range;
  const ranges = new Map([["a", [range]]]);
  expect(asideAtPoint(ranges, 20, 15)).toBe("a");
  expect(asideAtPoint(ranges, 60, 15)).toBeNull();
});
