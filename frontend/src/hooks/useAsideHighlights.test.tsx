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

function Transcript({
  asides,
  activeIds,
  body = "alpha beta gamma",
  msgs = messages,
}: {
  asides: AsideEntry[];
  activeIds: string[];
  body?: string;
  msgs?: ParsedMessage[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useAsideHighlights({ containerRef: ref, messages: msgs, asides, activeIds, enabled: true });
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

it("paints every aside's passages, and the active one in the active highlight instead — never both", async () => {
  const asides = [aside("a", "alpha"), aside("b", "gamma")];
  const { rerender } = render(<Transcript asides={asides} activeIds={[]} />);
  await flush();
  expect(painted(ASIDE_HIGHLIGHT)).toEqual(["alpha", "gamma"]);
  expect(registry.has(ASIDE_HIGHLIGHT_ACTIVE)).toBe(false);

  rerender(<Transcript asides={asides} activeIds={["b"]} />);
  await flush();
  expect(painted(ASIDE_HIGHLIGHT_ACTIVE)).toEqual(["gamma"]);
  // Not stacked: one wash over the text — the one the theme contrast check measures.
  expect(painted(ASIDE_HIGHLIGHT)).toEqual(["alpha"]);
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
  const { unmount } = render(<Transcript asides={[aside("a", "alpha"), aside("b", "gamma")]} activeIds={["a"]} />);
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

it("does not re-find passages for changes outside quoted bubbles, nor for an equal transcript refetched", async () => {
  const asides = [aside("a", "alpha")];
  const { container, rerender } = render(<Transcript asides={asides} activeIds={[]} />);
  await flush();
  const first = registry.get(ASIDE_HIGHLIGHT)!.ranges[0];

  // A reply streaming in elsewhere, and the same transcript fetched again.
  const streaming = document.createElement("div");
  streaming.textContent = "streaming…";
  container.firstElementChild!.appendChild(streaming);
  streaming.textContent = "streaming… more";
  rerender(<Transcript asides={asides} activeIds={["a"]} msgs={messages.map((m) => ({ ...m }))} />);
  await flush();
  // Repainted (the emphasis), from the same ranges.
  expect(registry.get(ASIDE_HIGHLIGHT_ACTIVE)!.ranges[0]).toBe(first);

  // A change inside the quoted bubble does re-find them.
  rerender(<Transcript asides={asides} activeIds={["a"]} msgs={messages.map((m) => ({ ...m }))} body="alpha beta gamma delta" />);
  await flush();
  expect(registry.get(ASIDE_HIGHLIGHT_ACTIVE)!.ranges[0]).not.toBe(first);
  expect(painted(ASIDE_HIGHLIGHT_ACTIVE)).toEqual(["alpha"]);
});

it("does not re-find anything on streamed changes elsewhere while a quote's text is simply gone", async () => {
  // "zzz" was compressed away: its bubble is there, its text is not.
  const asides = [aside("a", "alpha"), aside("gone", "zzz")];
  const { container, rerender } = render(<Transcript asides={asides} activeIds={[]} />);
  await flush();
  const first = registry.get(ASIDE_HIGHLIGHT)!.ranges[0];
  // A reply streaming in elsewhere: nodes added, text changed, again and again.
  const streaming = document.createElement("div");
  container.firstElementChild!.appendChild(streaming);
  for (let i = 0; i < 5; i++) {
    const p = document.createElement("p");
    p.textContent = `token ${i}`;
    streaming.appendChild(p);
    await flush();
  }
  rerender(<Transcript asides={asides} activeIds={["a"]} />);
  await flush();
  // Repainted for the emphasis from the same ranges: never re-found.
  expect(registry.get(ASIDE_HIGHLIGHT_ACTIVE)!.ranges[0]).toBe(first);
});

it("finds a quote whose bubble renders late, once that bubble is added — and only for that", async () => {
  const late = (chatId: string, text: string): AsideEntry => ({ ...aside(chatId, text), quotes: [{ timestamp: "t2", role: "assistant", text }] });
  const msgs: ParsedMessage[] = [...messages, { role: "assistant", type: "text", content: "", timestamp: "t2" }];
  const asides = [aside("a", "alpha"), late("b", "omega")];
  const { container } = render(<Transcript asides={asides} activeIds={[]} msgs={msgs} />);
  await flush();
  expect(painted(ASIDE_HIGHLIGHT)).toEqual(["alpha"]);
  const first = registry.get(ASIDE_HIGHLIGHT)!.ranges[0];

  // Something else added: not the awaited bubble, nothing re-found.
  const other = document.createElement("div");
  other.textContent = "unrelated";
  container.firstElementChild!.appendChild(other);
  await flush();
  expect(registry.get(ASIDE_HIGHLIGHT)!.ranges[0]).toBe(first);

  // The awaited bubble arrives.
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-message-index", "2");
  wrapper.innerHTML = "<div data-quote-content>the omega point</div>";
  container.firstElementChild!.appendChild(wrapper);
  await flush();
  expect(painted(ASIDE_HIGHLIGHT)).toEqual(["alpha", "omega"]);
});
