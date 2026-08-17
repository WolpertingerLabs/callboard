/**
 * Per-engine field coverage for the responses debug panel.
 *
 * `ChatDebugPanel` is a pure derivation over `ParsedMessage[]` — there is no
 * endpoint behind it — so *which engine's transcript parser sets which field* is
 * the only thing that decides what a user sees. That makes this a class of bug
 * with no other guard: a parser that omits `usage` does not render a sparse
 * table, it renders **no table at all**, because the panel's row filter is
 * `role === "assistant" && usage`. pi shipped in exactly that state.
 *
 * ## What this file is
 *
 * A matrix — engines down the side, panel fields across — where every cell is an
 * explicit claim about one engine:
 *
 *   {@link every}       every row carries the field
 *   {@link some}        some rows do, with a note saying which don't and why
 *   {@link unavailable} no row does, **and the reason it cannot**
 *
 * The third state is the point of the whole file. A blank column in a
 * diagnostics panel is either a bug callboard should fix or a fact about the
 * engine, and those two look identical from the UI. Writing the reason into the
 * cell is what makes the difference reviewable — and makes silently *starting*
 * to populate a field fail here, so the reason gets revisited rather than
 * quietly rotting.
 *
 * ## Fixtures, not the developer's home directory
 *
 * The probe this replaces read real transcripts out of `~`, which is how the
 * numbers were originally established but is not something a test can do: three
 * of the five engines have no sessions on any given machine, and the two that do
 * would make the assertions depend on whatever the developer last ran. Each
 * fixture below is instead written in its engine's real on-disk shape, and each
 * says where that shape was verified against.
 *
 * Where an engine has a translation layer between the wire and the transcript
 * (ACP and Cline write callboard's own normalized `AgentEvent`s), the fixture
 * feeds *engine-native* input through the adapter's real translation functions
 * rather than hand-writing the normalized form — otherwise this would test the
 * parser against a transcript no adapter would ever produce.
 *
 * ## Calibration
 *
 * The two engines that do have local history were measured through their real
 * parsers before these cells were written — 20 largest files each, 2026-08-17:
 *
 *     codex        343 rows | model 343  stop    0  group 343  reqId 343
 *                           | cacheR 343 cacheW  0  cost   0  speed   0
 *     claude-code 7199 rows | model 7199 stop 7196  group 7198 reqId 7198
 *                           | cacheR 7199 cacheW 7199 cost 0  speed 7195
 *
 * Every Codex zero is exact, not rounded — over 343 rows drawn from rollouts up
 * to 1.9 MB, not the 3 rows a single short session gives. Claude Code's small
 * shortfalls are the API itself: a handful of entries carry `stop_reason: null`
 * (a streamed partial) or no `requestId`, so the `every()` cells below describe
 * what the parser does with what the engine sends, not a guarantee that the
 * engine always sends it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";

// Before anything reads `paths.ts` — the ACP/Cline/pi roots are all derived from
// DATA_DIR, which is captured at module load. See #302.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-debug-panel-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { parseMessages } = await import("./claude-code/sessionParser.js");
const { parseCodexRollout } = await import("./codex/sessionParser.js");
const { parsePiSession } = await import("./pi/sessionParser.js");
const { parseAcpTranscript } = await import("./acp/sessionParser.js");
const { AcpTranscriptWriter } = await import("./acp/transcript.js");
const { buildAcpUsage, mapStopReason, translateAcpUpdate, AcpToolCallBuffer } = await import("./acp/messageAdapter.js");
const { parseClineTranscript } = await import("./cline/sessionParser.js");
const { ClineTranscriptWriter } = await import("./cline/transcript.js");
const { buildTerminalResult, recordTerminalSignal, translateClineEvent } = await import("./cline/messageAdapter.js");
const { CURRENT_SESSION_VERSION } = await import("@earendil-works/pi-coding-agent");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── The fields the panel reads ──────────────────────────────────────

/**
 * Each key is a column (or the row filter) of the responses debug panel, and the
 * predicate is how the panel itself decides whether that cell has anything in
 * it. Kept verbatim from `ChatDebugPanel.tsx` — if a predicate here drifts from
 * the panel's, this file measures something the user never sees.
 */
const PROBES = {
  /**
   * The row filter. No usage ⇒ no row at all ⇒ an empty panel.
   *
   * Necessarily `every()` for every engine, because this predicate *is* the
   * filter {@link panelRows} applies — the assertion with content is
   * `assertRow`'s "no rows at all" check, which is what fails when a parser
   * stops populating usage.
   */
  usage: (m: ParsedMessage) => m.usage != null,
  /** Model column + the model filter dropdown. */
  model: (m: ParsedMessage) => m.model != null,
  /** Stop column, the "All stop reasons" filter, AND the canonical-entry picker. */
  stopReason: (m: ParsedMessage) => m.stopReason != null,
  /**
   * Row grouping — an engine that emits several messages per generation needs a
   * key, so its blocks collapse to one row instead of multiplying its usage.
   *
   * An engine that emits **one** message per generation needs none: the panel's
   * `__ungrouped_N` fallback already numbers rows per message. That is why acp
   * and cline are `unavailable` here rather than carrying a positional key.
   */
  grouping: (m: ParsedMessage) => (m.generationKey ?? m.requestId) != null,
  /** Req ID column — the engine's own id, never a synthesized one. */
  requestId: (m: ParsedMessage) => m.requestId != null,
  /** Cache R column + the cache-read total and hit rate. */
  cacheRead: (m: ParsedMessage) => m.usage?.cache_read_input_tokens != null,
  /** Cache W column + the cache-write total. */
  cacheWrite: (m: ParsedMessage) => m.usage?.cache_creation_input_tokens != null,
  /** Cost column + "Total cost". */
  cost: (m: ParsedMessage) => m.costUsd != null,
  // `msPerOutputToken` is deliberately NOT a probe. The panel recomputes it for
  // every row from the wall-clock gap to the previous row, overwriting whatever
  // a parser set, so no parser's value is user-visible and a cell here would
  // assert an implementation detail — one that moved whenever a fixture's
  // timestamps did. The ms/tok column needs only `timestamp` and `output_tokens`,
  // both covered below.
  /** Speed column. */
  speed: (m: ParsedMessage) => m.speed != null,
  /** Time column, the inter-response deltas, and p95. */
  timestamp: (m: ParsedMessage) => m.timestamp != null,
} as const;

type Field = keyof typeof PROBES;

// ── Cell vocabulary ─────────────────────────────────────────────────

type Cell = { kind: "every" } | { kind: "some"; note: string } | { kind: "none"; because: string };

/** Every row carries this field. */
const every = (): Cell => ({ kind: "every" });
/** Some rows carry it; `note` says which do not, and why that is correct. */
const some = (note: string): Cell => ({ kind: "some", note });
/** No row carries it, because the engine does not report it. `because` says why. */
const unavailable = (because: string): Cell => ({ kind: "none", because });

/** Reasons repeated across engines, named once so they read as one decision. */
const NO_ANTHROPIC_CONCEPT = "an Anthropic-only service field; no other vendor has the concept, let alone the datum";
const NO_KEY_NEEDED =
  "one message per turn carries the usage, so the panel's own `__ungrouped_N` fallback already gives each turn its own row. " +
  "A positional key was added here and removed again: it changed the row count from N to N.";

// ── The matrix ──────────────────────────────────────────────────────

const MATRIX: Record<string, Record<Field, Cell>> = {
  "claude-code": {
    usage: every(),
    model: every(),
    stopReason: every(),
    grouping: every(),
    requestId: every(),
    cacheRead: every(),
    cacheWrite: every(),
    cost: unavailable(
      "the Agent SDK writes no cost field anywhere in its JSONL — a key census over the local session logs found none. " +
        "Multiplying tokens by a price table would be a guess wearing a cost's clothing.",
    ),
    speed: every(),
    timestamp: every(),
  },

  codex: {
    usage: every(),
    model: every(),
    stopReason: unavailable(
      "a rollout carries no stop reason in any line type — verified by a census of every `event_msg` and `response_item` " +
        "kind across the 361 rollouts on the development machine. The turn-level `task_complete` says a turn ended, not " +
        "why the model yielded, and inferring `tool_use` from 'this generation was followed by a function_call' would " +
        "print callboard's inference in an engine's column.",
    ),
    grouping: every(),
    requestId: every(),
    cacheRead: every(),
    cacheWrite: unavailable("OpenAI bills no prompt-cache writes and reports no such metric; `token_count` has `cached_input_tokens` and no counterpart"),
    cost: unavailable("a rollout records no price; a subscription run is not billed per call"),
    speed: unavailable(NO_ANTHROPIC_CONCEPT),
    timestamp: every(),
  },

  acp: {
    usage: every(),
    model: every(),
    stopReason: every(),
    grouping: unavailable(NO_KEY_NEEDED),
    requestId: unavailable(
      "ACP mints no request id — neither the protocol nor `PromptResponse` has one. An id callboard invented would " +
        "look like one a user could quote to a vendor's support, and none is needed for grouping.",
    ),
    cacheRead: some(
      "`cachedReadTokens` is `number | null | undefined` in the ACP schema and only some vendors fill it. OpenCode does; " +
        "the fixture's third turn is a vendor that reports neither cache figure, and its row's Cache R/W columns are blank. " +
        "`every()` here would have told a maintainer that a blank column must be a callboard regression.",
    ),
    cacheWrite: some("as `cacheRead` — both are optional in the schema and a vendor may report neither"),
    cost: some(
      "cost rides on a separate `usage_update` beacon, not on `PromptResponse`, so a turn where the agent sent none has " +
        "no cost — and after such a gap the next turn's step spans two turns and is dashed rather than misattributed",
    ),
    speed: unavailable(NO_ANTHROPIC_CONCEPT),
    timestamp: every(),
  },

  cline: {
    usage: every(),
    model: every(),
    stopReason: some(
      "`buildTerminalResult` takes it from the `done` event, and a loop that ends on an unrecoverable error never emits " +
        "one — so a turn can carry usage (a row) with no finish reason. The fixture's last turn is that shape.",
    ),
    grouping: unavailable(NO_KEY_NEEDED),
    requestId: unavailable("no id reaches callboard: neither Cline's `usage` nor its `done` event carries one."),
    cacheRead: some(
      "`totalCacheReadTokens` is optional, and Cline's own emitter sends it as `total === 0 ? undefined : total` " +
        "(`@cline/core/dist/index.js`), so it is absent on every turn before the first cache hit — and a turn whose step " +
        "spans a turn that omitted it is dashed rather than credited the span",
    ),
    cacheWrite: some("as `cacheRead` — `totalCacheWriteTokens` is optional and zero-suppressed by the same emitter"),
    cost: every(),
    speed: unavailable(NO_ANTHROPIC_CONCEPT),
    timestamp: every(),
  },

  pi: {
    usage: every(),
    model: some("a compaction entry records the usage of the call that wrote the summary, but no model for it — see `summaryMetrics`"),
    stopReason: some("as `model`: a compaction row is a real API call with no stop reason recorded, so its Stop column is blank"),
    grouping: every(),
    requestId: some("as `model`: pi records no `responseId` for a compaction's own call"),
    cacheRead: every(),
    cacheWrite: every(),
    cost: every(),
    speed: unavailable(NO_ANTHROPIC_CONCEPT),
    timestamp: every(),
  },
};

// ── The panel's own row derivation, mirrored ────────────────────────

/**
 * The assistant messages the panel would turn into rows.
 *
 * Steps 1 and 2 of `ChatDebugPanel`'s `allRows` memo, kept in the same order:
 * filter to assistant messages carrying usage, then group. Coverage is measured
 * over these — measuring over *all* parsed messages would count user turns and
 * tool results, which the panel never shows.
 */
function panelRows(messages: ParsedMessage[]): ParsedMessage[] {
  // Assistant messages, and system markers recording an API call the assistant
  // did not speak for — pi's compaction summaries. Kept verbatim from the panel.
  return messages.filter((m) => (m.role === "assistant" || m.role === "system") && m.usage);
}

/** Distinct grouping keys among the rows — one debug-panel row per key. */
function groupCount(rows: ParsedMessage[]): number {
  const keys = new Set<string>();
  rows.forEach((m, i) => keys.add(m.generationKey ?? m.requestId ?? `__ungrouped_${i}`));
  return keys.size;
}

/**
 * Assert one engine's whole row of the matrix.
 *
 * Both directions are checked, and the second is the one that keeps the file
 * honest: an `unavailable` cell fails if the field *starts* being populated, so
 * a future change that fills a column has to come back here and delete the
 * reason rather than leave a stale claim in the tree.
 */
function assertRow(engine: string, messages: ParsedMessage[]): void {
  const rows = panelRows(messages);
  expect(rows.length, `${engine}: no rows at all — the debug panel would be empty`).toBeGreaterThan(0);

  for (const [field, probe] of Object.entries(PROBES) as [Field, (m: ParsedMessage) => boolean][]) {
    const hits = rows.filter(probe).length;
    const cell = MATRIX[engine][field];
    switch (cell.kind) {
      case "every":
        expect(hits, `${engine}.${field}: expected every one of ${rows.length} rows to carry it`).toBe(rows.length);
        break;
      case "some":
        expect(hits, `${engine}.${field}: expected some rows to carry it — ${cell.note}`).toBeGreaterThan(0);
        expect(hits, `${engine}.${field}: expected NOT every row to carry it — ${cell.note}`).toBeLessThan(rows.length);
        break;
      case "none":
        expect(hits, `${engine}.${field}: expected no row to carry it, because ${cell.because}`).toBe(0);
        break;
    }
  }
}

// ── Fixtures ────────────────────────────────────────────────────────

const T0 = "2026-08-04T12:00:00.000Z";
const T1 = "2026-08-04T12:00:05.000Z";
const T2 = "2026-08-04T12:00:11.000Z";

/**
 * Claude Code's JSONL, in the shape the Agent SDK writes it.
 *
 * Verified field-for-field against a live `~/.claude/projects/**.jsonl` — the
 * `usage` sub-object really does carry `speed`, `service_tier` and an
 * `inference_geo` of `"not_available"`, and `requestId` really does sit on the
 * line rather than inside `message`.
 */
function claudeCodeMessages(): ParsedMessage[] {
  const usage = (cacheRead: number, cacheWrite: number) => ({
    input_tokens: 4,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: 120,
    service_tier: "standard",
    inference_geo: "not_available",
    speed: "standard",
  });
  return parseMessages([
    { type: "user", timestamp: T0, message: { role: "user", content: [{ type: "text", text: "read the readme" }] } },
    {
      type: "assistant",
      requestId: "req_011AAA",
      timestamp: T1,
      message: {
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "tool_use",
        usage: usage(0, 32544),
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } }],
      },
    },
    {
      type: "user",
      timestamp: T1,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello world" }] },
    },
    {
      type: "assistant",
      requestId: "req_011BBB",
      timestamp: T2,
      message: {
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "end_turn",
        usage: usage(32544, 0),
        // Two blocks from one API response, which is how the CLI writes a reply
        // that thought first. Both carry the entry's single timestamp, so the
        // second has a zero gap to the first — the mechanism behind the
        // `msPerTok` cell being `some` rather than `every`.
        content: [
          { type: "thinking", thinking: "It read fine.", signature: "sig" },
          { type: "text", text: "It says hello world." },
        ],
      },
    },
  ]);
}

/**
 * A Codex rollout.
 *
 * Line shapes copied from a real `$CODEX_HOME/sessions/**.jsonl`: `turn_context`
 * opens a turn with the model and `turn_id`, `response_item`s are the durable
 * transcript, and `event_msg`/`token_count` closes each generation with
 * `info.last_token_usage`. Two generations in one turn, which is what makes the
 * grouping assertion meaningful — they must produce two rows, not one.
 */
function codexMessages(): ParsedMessage[] {
  const dir = join(tmpRoot, "codex");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-2026-08-04T12-00-00-019ec8ab-6a4e-74b1-bfd0-9505ffa7f12b.jsonl");
  const tokenCount = (input: number, cached: number, output: number, reasoning: number) => ({
    timestamp: T2,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning },
        model_context_window: 258400,
      },
    },
  });
  const lines = [
    { timestamp: T0, type: "session_meta", payload: { id: "019ec8ab-6a4e-74b1-bfd0-9505ffa7f12b", timestamp: T0, cwd: "/tmp/repo", cli_version: "0.146.0" } },
    { timestamp: T0, type: "turn_context", payload: { turn_id: "019ec8ab-6a71-7e72-b285-7d984d059a8b", cwd: "/tmp/repo", model: "gpt-5.5", effort: "high" } },
    { timestamp: T0, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "read the readme" }] } },
    { timestamp: T1, type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "I should read it" }] } },
    {
      timestamp: T1,
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "call-1", arguments: '{"command":["cat","README.md"]}' },
    },
    tokenCount(13711, 4992, 202, 57),
    { timestamp: T1, type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "hello world" } },
    { timestamp: T2, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "It says hello world." }] } },
    tokenCount(16059, 4992, 250, 11),
  ];
  writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");
  return parseCodexRollout(file);
}

/**
 * An ACP transcript, produced the way `AcpAgentQuery` produces one.
 *
 * The ACP-native values go through the adapter's own `translateAcpUpdate` /
 * `buildAcpUsage` / `mapStopReason` rather than being hand-written as normalized
 * events, so this exercises the whole wire → event → disk → `ParsedMessage`
 * chain.
 *
 * **Every figure the fixture feeds is cumulative**, because that is what ACP
 * sends — `Usage.inputTokens` is "Total input tokens across all turns" and
 * `totalTokens` is "Sum of all token types across session" in the pinned SDK. A
 * fixture of per-turn numbers would have encoded the bug as ground truth.
 *
 * Three turns, and the third is deliberately from a **vendor that reports no
 * cache figures and no cost beacon**: ACP's cache counts are
 * `number | null | undefined` and only some agents fill them, so an engine-wide
 * `every()` for those columns would be a claim about OpenCode dressed up as a
 * claim about ACP.
 */
function acpMessages(): ParsedMessage[] {
  const writer = new AcpTranscriptWriter("opencode", "acp-session-1", "/tmp/repo");
  writer.writeHeader({ name: "opencode", version: "1.0.0" });

  const buffer = new AcpToolCallBuffer();
  const turn = (
    text: string,
    opts: { cumulativeCost?: number; inputTokens: number; outputTokens: number; cache?: { read: number; write: number; thought: number }; stopReason: string },
  ): void => {
    writer.writeUserMessage(`turn: ${text}`);
    writer.writeEvent({ type: "session_started", sessionId: "acp-session-1" });
    // The model rides in on an `adapter_specific` beacon rather than an event of
    // its own: ACP reports the model as a *session config option*, so nothing in
    // the turn's event stream carries it. `AcpAgentQuery` reads it back after
    // `set_config_option` and emits exactly this — see its `turn_model` note.
    writer.writeEvent({ type: "adapter_specific", adapter: "acp", payload: { kind: "turn_model", model: "anthropic/claude-opus-5" } });
    for (const e of translateAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as never, buffer)) writer.writeEvent(e);
    if (opts.cumulativeCost !== undefined) {
      for (const e of translateAcpUpdate(
        { sessionUpdate: "usage_update", used: 100, size: 200, cost: { amount: opts.cumulativeCost, currency: "USD" } } as never,
        buffer,
      ))
        writer.writeEvent(e);
    }
    const result = mapStopReason(opts.stopReason);
    const usage = buildAcpUsage({
      totalTokens: opts.inputTokens + opts.outputTokens,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      // A vendor that reports none sends null, not zero — it has not measured
      // zero cached reads, it does not count them.
      thoughtTokens: opts.cache ? opts.cache.thought : null,
      cachedReadTokens: opts.cache ? opts.cache.read : null,
      cachedWriteTokens: opts.cache ? opts.cache.write : null,
    } as never);
    writer.writeEvent(usage ? { ...result, usage } : result);
  };

  turn("Reading it now.", { cumulativeCost: 0.01, inputTokens: 1200, outputTokens: 300, cache: { read: 900, write: 40, thought: 12 }, stopReason: "end_turn" });
  turn("It says hello world.", {
    cumulativeCost: 0.03,
    inputTokens: 2600,
    outputTokens: 560,
    cache: { read: 1800, write: 40, thought: 24 },
    stopReason: "end_turn",
  });
  turn("And a vendor that counts nothing.", { inputTokens: 3000, outputTokens: 600, stopReason: "end_turn" });

  const messages = parseAcpTranscript(writer.filePath!);
  const rows = panelRows(messages);
  // Three turns, three rows — with no `generationKey` minted for any of them.
  expect(rows).toHaveLength(3);
  expect(groupCount(rows)).toBe(3);

  // Differenced, not copied: turn 2's step is 2600-1200 in and 1800-900 of cache
  // read. A row showing 2600 would claim the whole session's usage for one
  // response, and 900/1800 down the column would read as a cache warming up.
  expect(rows[1].usage).toMatchObject({ input_tokens: 1400, output_tokens: 260, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
  expect(rows[1].costUsd).toBeCloseTo(0.02, 10);
  // The vendor that counts nothing leaves the columns blank rather than zero.
  expect(rows[2].usage?.cache_read_input_tokens).toBeUndefined();
  expect(rows[2].usage?.reasoning_tokens).toBeUndefined();
  expect(rows[2].costUsd).toBeUndefined();
  return messages;
}

/**
 * A Cline transcript, produced the way `ClineAgentQuery` produces one.
 *
 * Cline's counters are **cumulative for the session**, so the fixture feeds
 * running totals and the parser is expected to difference them back into
 * per-turn figures.
 *
 * Three turns, each covering something the matrix asserts:
 *
 *  1. A first turn whose cache totals are still **0**, which Cline's own emitter
 *     sends as `undefined` (`total === 0 ? undefined : total`, verified in
 *     `@cline/core/dist/index.js`) — so the Cache columns are legitimately blank
 *     on it, and `cacheRead`/`cacheWrite` cannot be `every()`.
 *  2. A normal turn, so the differencing is actually exercised: its row must
 *     show its own step, not the chat's running total.
 *  3. A turn that ends on an unrecoverable **error rather than `done`**, which
 *     is the shape that leaves `stopReason` unset — the state `stopReason:
 *     every()` claimed could not happen.
 */
function clineMessages(): ParsedMessage[] {
  const writer = new ClineTranscriptWriter("cline-session-1", "/tmp/repo");
  writer.writeHeader({ providerId: "anthropic", modelId: "claude-opus-5" });

  const turn = (text: string, totals: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number }, finish: unknown): void => {
    writer.writeUserMessage(`turn: ${text}`);
    writer.writeEvent({ type: "session_started", sessionId: "cline-session-1" });
    const accounting = {};
    const inner = [
      { type: "content_end", contentType: "text", text },
      {
        type: "usage",
        inputTokens: 1,
        outputTokens: 1,
        totalInputTokens: totals.input,
        totalOutputTokens: totals.output,
        // Absent, not zero, when Cline's emitter suppresses a zero total.
        ...(totals.cacheRead !== undefined && { totalCacheReadTokens: totals.cacheRead }),
        ...(totals.cacheWrite !== undefined && { totalCacheWriteTokens: totals.cacheWrite }),
        totalCost: totals.cost,
      },
      finish,
    ];
    for (const event of inner) {
      recordTerminalSignal(accounting, event as never);
      const translated = translateClineEvent(event as never);
      if (translated) writer.writeEvent(translated);
    }
    writer.writeEvent(buildTerminalResult(accounting));
  };

  const done = { type: "done", reason: "completed", text: "", iterations: 2 };
  turn("Nothing cached yet.", { input: 1200, output: 300, cost: 0.01 }, done);
  turn("Reading it now.", { input: 2600, output: 560, cacheRead: 900, cacheWrite: 40, cost: 0.03 }, done);
  // No `done` — the loop died. `buildTerminalResult` still carries the usage it
  // accumulated, so this is a row, and it has no finish reason to show.
  turn(
    "It says hello world.",
    { input: 3800, output: 760, cacheRead: 1800, cacheWrite: 40, cost: 0.05 },
    {
      type: "error",
      recoverable: false,
      error: new Error("provider hung up"),
    },
  );

  const messages = parseClineTranscript(writer.filePath!);
  const rows = panelRows(messages);
  // Three turns, three rows — with no `generationKey` minted for any of them.
  expect(rows).toHaveLength(3);
  expect(groupCount(rows)).toBe(3);

  // Turn 1 measured no cache because Cline sent no cache figure at all.
  expect(rows[0].usage).toEqual({ input_tokens: 1200, output_tokens: 300 });
  // Differencing, not the running total: turn 2's step is 2600-1200 in. Its
  // cache read is the full 900 rather than a dash — the baseline it follows sat
  // at zero, and a counter at zero that goes quiet has nothing to hide.
  expect(rows[1].usage).toMatchObject({ input_tokens: 1400, output_tokens: 260, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 });
  expect(rows[1].costUsd).toBeCloseTo(0.02, 10);
  // 1800-900 read this turn and nothing newly written: a real zero, which is a
  // different claim from turn 1's absent field.
  expect(rows[2].usage).toMatchObject({ cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
  expect(rows[2].stopReason).toBeUndefined();
  return messages;
}

/**
 * A pi session file, in pi's real version-3 shape.
 *
 * The assistant message shape is `@earendil-works/pi-ai`'s `AssistantMessage`,
 * where `usage` and `stopReason` are **required** fields and `cost` is a
 * breakdown object rather than a scalar. Two entries, so the per-entry
 * generation key is exercised — pi appends one entry per API call, which is why
 * its rows land per generation rather than per turn.
 */
function piMessages(): ParsedMessage[] {
  const dir = join(tmpRoot, "pi-sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-08-04T12-00-00_pi-session-1.jsonl");
  const assistant = (content: unknown[], stopReason: string, responseId: string) => ({
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5",
    responseId,
    usage: {
      input: 4,
      output: 120,
      cacheRead: 900,
      cacheWrite: 40,
      reasoning: 12,
      totalTokens: 1064,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
    },
    stopReason,
    timestamp: Date.parse(T1),
  });
  const lines = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: "pi-session-1", timestamp: T0, cwd: "/tmp/repo" },
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: T0,
      message: { role: "user", content: [{ type: "text", text: "read the readme" }], timestamp: Date.parse(T0) },
    },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: T1,
      message: assistant(
        [
          { type: "thinking", thinking: "I should read it" },
          { type: "text", text: "Reading it now." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
        ],
        "toolUse",
        "resp_aaa",
      ),
    },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: T1,
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "hello world" }],
        isError: false,
        timestamp: Date.parse(T1),
      },
    },
    { type: "message", id: "e4", parentId: "e3", timestamp: T2, message: assistant([{ type: "text", text: "It says hello world." }], "stop", "resp_bbb") },
    // A compaction: a real, billed API call that produced no assistant message.
    // `CompactionEntry.usage` is "Usage from the LLM call(s) that generated this
    // summary", and dropping it made "Total cost" short by every compaction in a
    // long chat. It records no model, stop reason or response id, which is why
    // three of pi's cells are `some()` rather than `every()`.
    {
      type: "compaction",
      id: "c1",
      parentId: "e4",
      timestamp: T2,
      summary: "summarized the earlier turns",
      firstKeptEntryId: "e4",
      tokensBefore: 40000,
      usage: { input: 40000, output: 800, cacheRead: 0, cacheWrite: 0, totalTokens: 40800, cost: { total: 0.12 } },
    },
  ];
  writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");

  const messages = parsePiSession(file);
  const rows = panelRows(messages);
  // Three rows for three API calls: one per generation, plus the compaction. The
  // first entry's three blocks are one generation — only the last carries the
  // metrics, so the panel's row filter picks it up once rather than three times.
  expect(rows).toHaveLength(3);
  expect(groupCount(rows)).toBe(3);
  expect(rows.at(-1)).toMatchObject({ role: "system", costUsd: 0.12 });
  return messages;
}

// ── The matrix, asserted ────────────────────────────────────────────

const PARSED: Record<string, ParsedMessage[]> = {};

beforeAll(() => {
  PARSED["claude-code"] = claudeCodeMessages();
  PARSED.codex = codexMessages();
  PARSED.acp = acpMessages();
  PARSED.cline = clineMessages();
  PARSED.pi = piMessages();
});

describe("responses debug panel: per-engine field coverage", () => {
  for (const engine of Object.keys(MATRIX)) {
    it(`${engine} populates exactly the fields it can`, () => {
      assertRow(engine, PARSED[engine]);
    });
  }

  /**
   * The regression this whole file exists for. pi set no `usage` and no
   * `stopReason` at all, so `role === "assistant" && usage` matched nothing and
   * a pi chat's debug tab said "No API response data available" — not a missing
   * column, the entire panel.
   */
  it("every engine produces at least one row, so no engine's panel is blank", () => {
    for (const engine of Object.keys(MATRIX)) {
      expect(panelRows(PARSED[engine]).length, `${engine}: the debug panel would render nothing`).toBeGreaterThan(0);
    }
  });

  /**
   * Grouping keys are namespaced per engine and per session because a chat's
   * messages are the concatenation of several session files, and the engines
   * that number their generations positionally would otherwise have two files'
   * entry 0 sharing a key and merging unrelated responses into one row.
   *
   * Keys repeat *within* an engine on purpose — that is what collapses one API
   * call's several blocks into one row — so what must hold is that no key is
   * used by two engines. Rows with no key at all (acp, cline — they need none)
   * are excluded rather than compared as `undefined`.
   */
  it("grouping keys never collide across engines", () => {
    const byEngine = Object.entries(PARSED).map(([engine, messages]) => ({
      engine,
      keys: new Set(
        panelRows(messages)
          .map((m) => m.generationKey ?? m.requestId)
          .filter((k) => k != null),
      ),
    }));
    for (const a of byEngine) {
      for (const b of byEngine) {
        if (a.engine >= b.engine) continue;
        const shared = [...a.keys].filter((k) => b.keys.has(k as string));
        expect(shared, `${a.engine} and ${b.engine} share grouping keys`).toEqual([]);
      }
    }
  });
});
