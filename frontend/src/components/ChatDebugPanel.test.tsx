// @vitest-environment jsdom
/**
 * The responses debug panel, at the one place where its rendering makes a
 * claim: **a dash and a zero mean different things.**
 *
 * The panel is a diagnostics table, so "Cache write: 0" is read as a
 * measurement — the run wrote nothing to the prompt cache. For an engine that
 * reports no cache-write metric at all (OpenAI bills none, so a Codex rollout
 * has no such number anywhere) that sentence is something callboard made up.
 * The summary row therefore tracks *whether anything reported the figure*
 * separately from the total, and shows a dash when nothing did.
 *
 * The other half of the panel — which engines populate which fields in the first
 * place — is `backend/src/agents/adapters/debugPanelFields.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ParsedMessage } from "../api";
import ChatDebugPanel from "./ChatDebugPanel";

afterEach(cleanup);

/** One debug-panel row's worth of message. */
function row(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    role: "assistant",
    type: "text",
    content: "hello",
    timestamp: "2026-08-04T12:00:00.000Z",
    model: "some-model",
    generationKey: "g1",
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  };
}

/** The text of the summary chip whose label starts with `label`. */
function summary(label: string): string {
  const chip = screen
    .getAllByText((_, node) => node?.textContent?.startsWith(`${label}:`) === true)
    // The predicate matches ancestors too; the innermost node is the chip.
    .at(-1);
  return chip?.textContent ?? "";
}

describe("ChatDebugPanel summary totals", () => {
  it("shows a dash, not a zero, for a figure no row reported", () => {
    // A Codex-shaped chat: cache reads reported, cache writes not a thing OpenAI
    // has. "Cache write: 0" would state a fact nothing observed.
    render(<ChatDebugPanel messages={[row({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4992 } })]} />);
    expect(summary("Cache read")).toContain("4,992");
    expect(summary("Cache write")).toBe("Cache write: -");
  });

  it("shows a real zero when a row genuinely measured zero", () => {
    // The distinction that makes the dash mean anything: this engine counted,
    // and the answer was none.
    render(
      <ChatDebugPanel messages={[row({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })]} />,
    );
    expect(summary("Cache read")).toContain("0");
    expect(summary("Cache write")).toBe("Cache write: 0");
  });

  it("suppresses the cache hit rate rather than reporting a flat 0%", () => {
    // With no cache-read figure the denominator is just the input count, so the
    // rate would render "(0.0%)" — "the cache never hit" rather than "nobody
    // counted". The percentage only appears alongside a reported read.
    render(<ChatDebugPanel messages={[row()]} />);
    expect(summary("Cache read")).toBe("Cache read: -");
    expect(summary("Cache read")).not.toContain("%");

    cleanup();
    render(<ChatDebugPanel messages={[row({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 } })]} />);
    expect(summary("Cache read")).toContain("%");
  });

  it("still omits the cost chip entirely when no row carries a cost", () => {
    // Cost has always been all-or-nothing rather than dashed, because the chip
    // is conditional. Claude Code and Codex report no USD figure at all.
    render(<ChatDebugPanel messages={[row()]} />);
    expect(screen.queryByText(/Total cost/)).toBeNull();

    cleanup();
    render(<ChatDebugPanel messages={[row({ costUsd: 0.0033 })]} />);
    expect(summary("Total cost")).toContain("0.0033");
  });
});

describe("ChatDebugPanel rows", () => {
  it("renders the empty state when no assistant message carries usage", () => {
    // pi's shipped state: the parser set no usage, so the filter matched
    // nothing and the whole panel was this sentence.
    render(<ChatDebugPanel messages={[row({ usage: undefined })]} />);
    // getByText throws when absent, so reaching the assertion is the assertion.
    expect(screen.getByText(/No API response data available/).textContent).toContain("No API response data available");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("collapses one generation's several messages into a single row", () => {
    // A generation's thinking, prose and tool call share a grouping key and
    // duplicate its token counts; three rows would triple the reported usage.
    render(
      <ChatDebugPanel
        messages={[
          row({ type: "thinking", generationKey: "g1" }),
          row({ type: "tool_use", generationKey: "g1" }),
          row({ type: "text", generationKey: "g1", stopReason: "end_turn" }),
        ]}
      />,
    );
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2); // header + one data row
    // The single row reports the generation's usage once, not three times over.
    expect(summary("In")).toBe("In: 100");
    expect(summary("Out")).toBe("Out: 20");
  });

  it("splits distinct generations into distinct rows", () => {
    render(<ChatDebugPanel messages={[row({ generationKey: "g1" }), row({ generationKey: "g2" })]} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  });

  it("renders a dash for an unreported stop reason instead of blanking the cell", () => {
    // Codex reports none anywhere in its rollout; the Stop column must say so.
    render(<ChatDebugPanel messages={[row()]} />);
    const cells = within(screen.getByRole("table")).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toContain("-");
  });
});
