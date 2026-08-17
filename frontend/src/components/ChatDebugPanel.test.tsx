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
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

/**
 * The text of the single row's cell under the column headed `header`.
 *
 * By column, not by "some cell somewhere says this": a bare row renders nine
 * dashes, so `cells).toContain("-")` passes if the cell under test renders
 * literally anything.
 */
function cell(header: string): string {
  const table = within(screen.getByRole("table"));
  const columns = table.getAllByRole("columnheader").map((h) => (h.textContent ?? "").replace(/[▲▼]/g, "").trim());
  const index = columns.indexOf(header);
  if (index < 0) throw new Error(`no column headed "${header}" — columns are: ${columns.join(", ")}`);
  return table.getAllByRole("cell")[index]?.textContent ?? "";
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

  it("computes the cache hit rate over the rows that reported a cache figure", () => {
    // A chat can span engines — forks across harnesses are supported — and rows
    // from an engine that reports no cache metric are not evidence of a cache
    // miss. Folding their input into the denominator dilutes the rate towards
    // zero: two Codex-shaped rows at 5k in / 4k cache read are 44.4%, and the
    // two Cline-shaped rows below reported nothing.
    render(
      <ChatDebugPanel
        messages={[
          row({ generationKey: "g1", usage: { input_tokens: 5000, output_tokens: 20, cache_read_input_tokens: 4000 } }),
          row({ generationKey: "g2", usage: { input_tokens: 5000, output_tokens: 20, cache_read_input_tokens: 4000 } }),
          row({ generationKey: "g3", usage: { input_tokens: 5000, output_tokens: 20 } }),
          row({ generationKey: "g4", usage: { input_tokens: 5000, output_tokens: 20 } }),
        ]}
      />,
    );
    // 8000 / (10000 + 8000) = 44.4%. Over every row it would be 8000 / 28000 = 28.6%.
    expect(summary("Cache read")).toContain("44.4%");
  });

  it("counts a compaction's own API call towards the totals", () => {
    // pi's compaction entries carry the usage of the call that wrote the summary
    // — real spend on a real call, on a system-role marker rather than an
    // assistant message. Filtering to assistants made "Total cost" short by
    // every compaction in a long chat.
    render(
      <ChatDebugPanel
        messages={[
          row({ generationKey: "g1", costUsd: 0.01 }),
          {
            role: "system",
            type: "system",
            subtype: "compact_boundary",
            content: "summary",
            timestamp: "2026-08-04T12:00:10.000Z",
            generationKey: "c1",
            usage: { input_tokens: 40000, output_tokens: 800 },
            costUsd: 0.12,
          },
        ]}
      />,
    );
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3); // header + two
    expect(summary("Total cost")).toContain("0.13");
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
    expect(cell("Stop")).toBe("-");
    // And a reported one is shown as-is, so the assertion above is about the
    // Stop column rather than about the nine other cells that also dash.
    cleanup();
    render(<ChatDebugPanel messages={[row({ stopReason: "end_turn" })]} />);
    expect(cell("Stop")).toBe("end_turn");
  });
});

/**
 * The row cells, where the dash-vs-zero distinction actually reaches a user.
 *
 * The summary chips implemented it; the table below them did not. `fmtTok`
 * returned `-` for both `null` and `0`, so four parsers' worth of machinery for
 * keeping "the engine does not report this" apart from "it reported none"
 * collapsed in the last function before the DOM.
 */
describe("ChatDebugPanel row cells", () => {
  it("renders a measured zero as 0, not as a dash", () => {
    // Cline's turn 2 in `debugPanelFields.test.ts` really does produce
    // `cache_creation_input_tokens: 0` — 40 cumulative minus 40 cumulative, a
    // turn that wrote nothing new. A real pi generation on this machine reports
    // `cacheRead: 0` the same way. Rendered as `-` it was byte-identical to a
    // Codex row, where OpenAI reports no cache-write metric at all.
    render(<ChatDebugPanel messages={[row({ usage: { input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })]} />);
    expect(cell("Cache W")).toBe("0");
    expect(cell("Cache R")).toBe("0");
    // `input_tokens: 0` is real on a fully-cached Anthropic turn.
    expect(cell("In")).toBe("0");
  });

  it("still renders a dash for a figure the engine never reported", () => {
    // The other half: without this the zero above would just mean the panel
    // stopped distinguishing anything at all.
    render(<ChatDebugPanel messages={[row({ usage: { input_tokens: 100, output_tokens: 20 } })]} />);
    expect(cell("Cache W")).toBe("-");
    expect(cell("Cache R")).toBe("-");
    expect(cell("In")).toBe("100");
  });

  it("sorts unreported figures to the end instead of treating them as zero", () => {
    // `?? 0` in the comparator re-collapsed in the sort exactly what the cells
    // preserve: a row whose engine reports no cache-write metric interleaved
    // with the rows that measured zero. Ascending by Cache W, the two measured
    // values come first in order and the dash lands last.
    render(
      <ChatDebugPanel
        messages={[
          row({ generationKey: "g1", model: "unreported", usage: { input_tokens: 1, output_tokens: 1 } }),
          row({ generationKey: "g2", model: "measured-five", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5 } }),
          row({ generationKey: "g3", model: "measured-zero", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0 } }),
        ]}
      />,
    );
    const table = within(screen.getByRole("table"));
    fireEvent.click(table.getAllByRole("columnheader").find((h) => (h.textContent ?? "").startsWith("Cache W"))!);

    const modelColumn = table
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell")[2].textContent);
    expect(modelColumn).toEqual(["measured-zero", "measured-five", "unreported"]);
  });

  it("colours a clean Cline loop finish as success, not as an unrecognised value", () => {
    // The Stop column knew three Anthropic values, so every Cline row — whose
    // reason describes the agent loop, deliberately not relabelled — rendered
    // the same muted grey, a clean `loop:completed` indistinguishable from a
    // `loop:mistake_limit`.
    render(<ChatDebugPanel messages={[row({ stopReason: "loop:completed" })]} />);
    const clean = within(screen.getByRole("table")).getAllByRole("cell")[4].querySelector("span")!;

    cleanup();
    render(<ChatDebugPanel messages={[row({ stopReason: "loop:max_iterations" })]} />);
    const capped = within(screen.getByRole("table")).getAllByRole("cell")[4].querySelector("span")!;

    expect(clean.style.color).not.toBe(capped.style.color);
    expect(clean.style.color).toContain("--success");
    // `max_iterations` is the direct analogue of `max_tokens` and gets its colour.
    expect(capped.style.color).toContain("--danger");
  });
});
