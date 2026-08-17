import { useState, useMemo } from "react";
import { Copy, Check } from "lucide-react";
import type { ParsedMessage } from "../api";

/** Format ms delta as human-readable duration */
function fmtDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = (sec % 60).toFixed(0);
  return `${min}m ${remSec}s`;
}

/** Format ms/tok throughput */
function fmtMsPerTok(v: number): string {
  if (v < 1) return v.toFixed(2);
  if (v < 10) return v.toFixed(1);
  return Math.round(v).toString();
}

/**
 * Format a token count — **`0` is a number here, not a blank.**
 *
 * This is a diagnostics table, and a dash and a zero say different things: a
 * dash means *this engine does not report the figure* (OpenAI bills no
 * prompt-cache writes, so a Codex row genuinely has no such number), a zero
 * means *it counted, and the answer was none* — which is what a fully-cached
 * Anthropic turn reports for `input_tokens`, and what a real pi generation on
 * this machine reports for `cacheRead`.
 *
 * Four parsers carry machinery to keep `undefined` and `0` apart on the way
 * here, and the summary chips render them differently. Collapsing them in this
 * one function made the rows below disagree with the row above them, and made a
 * measured zero indistinguishable from a column the engine never fills.
 */
function fmtTok(n?: number): string {
  if (n == null) return "-";
  return n.toLocaleString();
}

/**
 * Colour for a Stop value, across the two vocabularies the column now carries.
 *
 * The panel was built for Anthropic's model-level `stop_reason` and recognised
 * exactly three values, so every Cline row — whose reason describes why the
 * *agent loop* ended, a different fact deliberately not relabelled — fell
 * through to muted grey. A clean `loop:completed` and a `loop:mistake_limit`
 * rendered identically, and `loop:max_iterations`, the direct analogue of
 * `max_tokens`, got no danger colour at all.
 *
 * Cline's are namespaced `loop:` on the way in (`cline/sessionParser.ts`), which
 * is what lets both live here without `error` meaning two things at once.
 */
function stopReasonColor(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "loop:completed":
      return "var(--success, #22c55e)";
    case "tool_use":
      return "var(--accent)";
    case "max_tokens":
    case "refusal":
    case "error":
    case "loop:max_iterations":
    case "loop:mistake_limit":
    case "loop:error":
      return "var(--danger, #ef4444)";
    default:
      // `aborted`, `loop:aborted`, `cancelled`, `pending`, and anything an
      // engine adds later: not a failure, not a clean finish, no claim made.
      return "var(--text-muted)";
  }
}

/**
 * Order rows by an optional metric, keeping "not reported" out of the numbers.
 *
 * `?? 0` would sort a row whose engine reports no cache-write metric in among
 * the rows that measured zero, re-collapsing in the sort exactly the
 * distinction the cells preserve. Unreported rows sort to the end in both
 * directions instead, so a descending sort still starts at the largest value
 * and the dashes stay together.
 */
function compareOptional(a: number | undefined | null, b: number | undefined | null, dir: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * dir;
}

/** Format USD cost with adaptive precision */
function fmtCost(usd: number): string {
  if (usd >= 1) return `${usd.toFixed(2)}`;
  if (usd >= 0.01) return `${usd.toFixed(3)}`;
  if (usd >= 0.001) return `${usd.toFixed(4)}`;
  return `${usd.toFixed(5)}`;
}

type SortKey = "index" | "delta" | "msPerTok" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite" | "cost";

interface DebugRow {
  index: number;
  message: ParsedMessage;
}

interface Props {
  messages: ParsedMessage[];
}

export default function ChatDebugPanel({ messages }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortAsc, setSortAsc] = useState(true);
  const [copiedReqId, setCopiedReqId] = useState<string | null>(null);
  const [filterModel, setFilterModel] = useState<string | null>(null);
  const [filterStop, setFilterStop] = useState<string | null>(null);

  // Build rows: one row per unique model generation.
  //
  // Grouping key selection:
  //   • OpenRouter (transcript path): `generationKey` = "<requestId>/<turnNumber>"
  //     Each intra-cycle generation gets a distinct key, so multi-generation
  //     agentic turns produce multiple rows instead of collapsing to one.
  //   • OpenRouter (legacy state.json path): `generationKey` = "<reqDirName>/<genIndex>"
  //     Same granularity — one row per gen_N directory.
  //   • Claude Code: `generationKey` is absent; falls back to `requestId`,
  //     which is already unique per API call — behaviour unchanged.
  //
  // A single generation may produce multiple ParsedMessage entries (thinking,
  // tool_use(s), final text) that share the same generationKey/requestId and
  // carry duplicated input/cache token counts. We pick the canonical entry per
  // group (the one with stopReason set, or the last entry) and recompute
  // inter-response timing deltas.
  const allRows: DebugRow[] = useMemo(() => {
    // Step 1: Collect the messages that carry usage data.
    //
    // Assistant messages, and system markers that record an API call the
    // assistant did not speak for: pi's compaction and branch-summary entries
    // carry the usage of the call that *wrote the summary*, which is real spend
    // on a real call. Excluding them made "Total cost" short by every
    // compaction in a long chat. User messages never carry usage.
    const assistantEntries: ParsedMessage[] = [];
    for (const m of messages) {
      if ((m.role === "assistant" || m.role === "system") && m.usage) {
        assistantEntries.push(m);
      }
    }

    // Step 2: Group by generationKey (OR) or requestId (Claude), maintaining
    // first-seen order. Messages without either are treated as their own group.
    const requestOrder: string[] = [];
    const byRequest = new Map<string, ParsedMessage[]>();
    let ungroupedIdx = 0;

    for (const m of assistantEntries) {
      const key = m.generationKey ?? m.requestId ?? `__ungrouped_${ungroupedIdx++}`;
      if (!byRequest.has(key)) {
        requestOrder.push(key);
        byRequest.set(key, []);
      }
      byRequest.get(key)!.push(m);
    }

    // Step 3: Pick canonical entry per group.
    // Prefer the entry with stop_reason (the final streamed entry which has
    // the real output_tokens total). Fall back to the last entry if the
    // response was interrupted and no entry carries a stop_reason.
    const canonicalEntries: ParsedMessage[] = [];
    for (const key of requestOrder) {
      const entries = byRequest.get(key)!;
      const final = entries.find((e) => e.stopReason != null);
      canonicalEntries.push(final || entries[entries.length - 1]);
    }

    // Step 4: Recompute inter-response timing deltas between grouped rows.
    //
    // Note that `msPerOutputToken` is *always* recomputed here from the wall
    // clock, overwriting whatever a parser set — so the ms/tok column is
    // engine-independent by construction and needs nothing from an adapter
    // beyond `timestamp` and `output_tokens`, which every engine reports. It is
    // gap-to-gap wall time divided by output tokens, not the model's generation
    // throughput: a row that sat waiting on a slow tool call inflates it.
    const rows: DebugRow[] = [];
    let prevTs: number | null = null;

    for (let i = 0; i < canonicalEntries.length; i++) {
      const m = { ...canonicalEntries[i] }; // shallow copy to override delta
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : NaN;

      if (!isNaN(ts)) {
        if (prevTs !== null) {
          m.deltaMs = ts - prevTs;
          if (m.usage?.output_tokens && m.usage.output_tokens > 0 && m.deltaMs > 0) {
            m.msPerOutputToken = Math.round((m.deltaMs / m.usage.output_tokens) * 100) / 100;
          } else {
            m.msPerOutputToken = undefined;
          }
        } else {
          m.deltaMs = undefined;
          m.msPerOutputToken = undefined;
        }
        prevTs = ts;
      }

      rows.push({ index: i, message: m });
    }

    return rows;
  }, [messages]);

  // Unique models and stop reasons for filter dropdowns
  const models = useMemo(() => [...new Set(allRows.map((r) => r.message.model).filter(Boolean))], [allRows]);
  const stopReasons = useMemo(() => [...new Set(allRows.map((r) => r.message.stopReason).filter((s) => s != null))], [allRows]);

  // Filter
  const filteredRows = useMemo(() => {
    return allRows.filter((r) => {
      if (filterModel && r.message.model !== filterModel) return false;
      if (filterStop && r.message.stopReason !== filterStop) return false;
      return true;
    });
  }, [allRows, filterModel, filterStop]);

  // Sort
  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows];
    const dir = sortAsc ? 1 : -1;
    sorted.sort((a, b) => {
      const am = a.message;
      const bm = b.message;
      switch (sortKey) {
        case "index":
          return (a.index - b.index) * dir;
        case "delta":
          return compareOptional(am.deltaMs, bm.deltaMs, dir);
        case "msPerTok":
          return compareOptional(am.msPerOutputToken, bm.msPerOutputToken, dir);
        case "inputTokens":
          return compareOptional(am.usage?.input_tokens, bm.usage?.input_tokens, dir);
        case "outputTokens":
          return compareOptional(am.usage?.output_tokens, bm.usage?.output_tokens, dir);
        case "cacheRead":
          return compareOptional(am.usage?.cache_read_input_tokens, bm.usage?.cache_read_input_tokens, dir);
        case "cacheWrite":
          return compareOptional(am.usage?.cache_creation_input_tokens, bm.usage?.cache_creation_input_tokens, dir);
        case "cost":
          return compareOptional(am.costUsd, bm.costUsd, dir);
        default:
          return 0;
      }
    });
    return sorted;
  }, [filteredRows, sortKey, sortAsc]);

  // Aggregate stats
  //
  // Every total that an engine may simply not report is tracked with a
  // "did anything report this?" flag beside it, and renders as a dash when
  // nothing did. The distinction is not cosmetic: "Cache write: 0" is a
  // measurement — it says the run wrote nothing to the cache — and OpenAI
  // reports no cache-write metric at all, so showing that for a Codex chat
  // would be stating a fact callboard never observed. A zero that a row
  // genuinely carried still shows as 0.
  const stats = useMemo(() => {
    const rows = filteredRows;
    if (rows.length === 0) return null;
    let totalIn = 0,
      totalOut = 0,
      totalCacheRead = 0,
      totalCacheWrite = 0,
      totalCost = 0;
    let hasCost = false;
    let hasCacheRead = false;
    let hasCacheWrite = false;
    // Every prompt token of the rows that reported a cache read, kept apart from
    // `totalIn`. The hit rate is a ratio, and a ratio needs both halves to come
    // from the same rows — see `cacheHitRate` below.
    let cachedRowsPromptTokens = 0;
    const deltas: number[] = [];
    const msPerToks: number[] = [];

    for (const { message: m } of rows) {
      totalIn += m.usage?.input_tokens ?? 0;
      totalOut += m.usage?.output_tokens ?? 0;
      if (m.usage?.cache_read_input_tokens != null) {
        totalCacheRead += m.usage.cache_read_input_tokens;
        cachedRowsPromptTokens += (m.usage.input_tokens ?? 0) + m.usage.cache_read_input_tokens + (m.usage.cache_creation_input_tokens ?? 0);
        hasCacheRead = true;
      }
      if (m.usage?.cache_creation_input_tokens != null) {
        totalCacheWrite += m.usage.cache_creation_input_tokens;
        hasCacheWrite = true;
      }
      if (m.costUsd != null) {
        totalCost += m.costUsd;
        hasCost = true;
      }
      if (m.deltaMs != null) deltas.push(m.deltaMs);
      if (m.msPerOutputToken != null) msPerToks.push(m.msPerOutputToken);
    }

    const avgDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
    const p95Delta =
      deltas.length > 0
        ? (() => {
            const s = [...deltas].sort((a, b) => a - b);
            return s[Math.floor(s.length * 0.95)];
          })()
        : null;
    const avgMsPerTok = msPerToks.length > 0 ? msPerToks.reduce((a, b) => a + b, 0) / msPerToks.length : null;
    // A hit rate needs a cache-read figure to be a rate *of* anything. Without
    // one the denominator is just the input count and the answer is a flat 0%,
    // which reads as "the cache never hit" rather than "nobody counted".
    //
    // The denominator is the input of the rows that *reported* a cache read, not
    // of every row. A chat can span engines — forks across harnesses are
    // supported — and folding in the input of rows from an engine that reports no
    // cache metric dilutes the rate towards zero: 10 Codex rows at 5k in / 4k
    // cache read followed by 10 Cline rows at 5k in and no cache figure reported
    // 28.6% where the measured rate is 44%. Rows nobody measured are not
    // evidence of a cache miss.
    const cacheHitRate = hasCacheRead && cachedRowsPromptTokens > 0 ? (totalCacheRead / cachedRowsPromptTokens) * 100 : null;

    return {
      totalIn,
      totalOut,
      totalCacheRead: hasCacheRead ? totalCacheRead : null,
      totalCacheWrite: hasCacheWrite ? totalCacheWrite : null,
      totalCost: hasCost ? totalCost : null,
      avgDelta,
      p95Delta,
      avgMsPerTok,
      cacheHitRate,
      count: rows.length,
    };
  }, [filteredRows]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortAsc ? " \u25B2" : " \u25BC";
  }

  function copyRequestId(reqId: string) {
    navigator.clipboard.writeText(reqId);
    setCopiedReqId(reqId);
    setTimeout(() => setCopiedReqId(null), 1500);
  }

  const thStyle: React.CSSProperties = {
    padding: "6px 8px",
    textAlign: "right",
    fontWeight: 600,
    borderBottom: "1px solid var(--border)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    userSelect: "none",
    position: "sticky",
    top: 0,
    background: "var(--surface)",
    zIndex: 1,
  };

  const thLeftStyle: React.CSSProperties = { ...thStyle, textAlign: "left" };

  const tdStyle: React.CSSProperties = {
    padding: "4px 8px",
    textAlign: "right",
    borderBottom: "1px solid var(--border-subtle, var(--border))",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  };

  const tdLeftStyle: React.CSSProperties = { ...tdStyle, textAlign: "left" };

  if (allRows.length === 0) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>No API response data available for this chat.</div>;
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "12px 16px", fontSize: 12 }}>
      {/* Aggregate stats */}
      {stats && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            padding: "10px 12px",
            marginBottom: 12,
            background: "var(--bg-secondary, var(--surface))",
            borderRadius: 8,
            border: "1px solid var(--border)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <div>
            <span style={{ fontWeight: 600, color: "var(--text)" }}>{stats.count}</span> responses
          </div>
          <div>
            In: <span style={{ fontWeight: 600, color: "var(--text)" }}>{stats.totalIn.toLocaleString()}</span>
          </div>
          <div>
            Out: <span style={{ fontWeight: 600, color: "var(--text)" }}>{stats.totalOut.toLocaleString()}</span>
          </div>
          <div>
            Cache read: <span style={{ fontWeight: 600, color: "var(--text)" }}>{stats.totalCacheRead?.toLocaleString() ?? "-"}</span>
            {stats.cacheHitRate != null && <span> ({stats.cacheHitRate.toFixed(1)}%)</span>}
          </div>
          <div>
            Cache write: <span style={{ fontWeight: 600, color: "var(--text)" }}>{stats.totalCacheWrite?.toLocaleString() ?? "-"}</span>
          </div>
          {stats.avgDelta != null && (
            <div>
              Avg delta: <span style={{ fontWeight: 600, color: "var(--text)" }}>{fmtDelta(Math.round(stats.avgDelta))}</span>
            </div>
          )}
          {stats.p95Delta != null && (
            <div>
              p95 delta: <span style={{ fontWeight: 600, color: "var(--text)" }}>{fmtDelta(stats.p95Delta)}</span>
            </div>
          )}
          {stats.avgMsPerTok != null && (
            <div>
              Avg ms/tok: <span style={{ fontWeight: 600, color: "var(--text)" }}>{fmtMsPerTok(stats.avgMsPerTok)}</span>
            </div>
          )}
          {stats.totalCost != null && (
            <div>
              Total cost: <span style={{ fontWeight: 600, color: "var(--text)" }}>{fmtCost(stats.totalCost)}</span>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      {(models.length > 1 || stopReasons.length > 1) && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", fontSize: 11 }}>
          {models.length > 1 && (
            <select
              value={filterModel ?? ""}
              onChange={(e) => setFilterModel(e.target.value || null)}
              style={{
                background: "var(--surface)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "3px 6px",
                fontSize: 11,
              }}
            >
              <option value="">All models</option>
              {models.map((m) => (
                <option key={m} value={m!}>
                  {m}
                </option>
              ))}
            </select>
          )}
          {stopReasons.length > 1 && (
            <select
              value={filterStop ?? ""}
              onChange={(e) => setFilterStop(e.target.value || null)}
              style={{
                background: "var(--surface)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "3px 6px",
                fontSize: 11,
              }}
            >
              <option value="">All stop reasons</option>
              {stopReasons.map((s) => (
                <option key={s!} value={s!}>
                  {s}
                </option>
              ))}
            </select>
          )}
          {(filterModel || filterStop) && (
            <button
              onClick={() => {
                setFilterModel(null);
                setFilterStop(null);
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent-text)",
                cursor: "pointer",
                fontSize: 11,
                padding: 0,
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div style={{ overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "var(--text)" }}>
          <thead>
            <tr>
              <th style={thLeftStyle} onClick={() => handleSort("index")}>
                #{sortIndicator("index")}
              </th>
              <th style={thLeftStyle}>Time</th>
              <th style={thLeftStyle}>Model</th>
              <th style={thLeftStyle}>Speed</th>
              <th style={thLeftStyle}>Stop</th>
              <th style={thStyle} onClick={() => handleSort("inputTokens")}>
                In{sortIndicator("inputTokens")}
              </th>
              <th style={thStyle} onClick={() => handleSort("outputTokens")}>
                Out{sortIndicator("outputTokens")}
              </th>
              <th style={thStyle} onClick={() => handleSort("cacheRead")}>
                Cache R{sortIndicator("cacheRead")}
              </th>
              <th style={thStyle} onClick={() => handleSort("cacheWrite")}>
                Cache W{sortIndicator("cacheWrite")}
              </th>
              <th style={thStyle} onClick={() => handleSort("delta")}>
                Delta{sortIndicator("delta")}
              </th>
              <th style={thStyle} onClick={() => handleSort("msPerTok")}>
                ms/tok{sortIndicator("msPerTok")}
              </th>
              <th style={thStyle} onClick={() => handleSort("cost")}>
                Cost{sortIndicator("cost")}
              </th>
              <th style={thLeftStyle}>Tier</th>
              <th style={thLeftStyle}>Geo</th>
              <th style={thLeftStyle}>Req ID</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(({ index, message: m }) => (
              <tr
                key={index}
                style={{
                  background: index % 2 === 0 ? "transparent" : "var(--bg-secondary, var(--surface))",
                }}
              >
                <td style={tdLeftStyle}>{index + 1}</td>
                <td style={{ ...tdLeftStyle, fontSize: 10, color: "var(--text-muted)" }}>{m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "-"}</td>
                <td style={tdLeftStyle}>{m.model ?? "-"}</td>
                <td style={tdLeftStyle}>{m.speed ?? "-"}</td>
                <td style={tdLeftStyle}>
                  <span style={{ color: m.stopReason ? stopReasonColor(m.stopReason) : "var(--text-muted)" }}>{m.stopReason ?? "-"}</span>
                </td>
                <td style={tdStyle}>{fmtTok(m.usage?.input_tokens)}</td>
                <td style={tdStyle}>{fmtTok(m.usage?.output_tokens)}</td>
                <td style={tdStyle}>{fmtTok(m.usage?.cache_read_input_tokens)}</td>
                <td style={tdStyle}>{fmtTok(m.usage?.cache_creation_input_tokens)}</td>
                <td style={tdStyle}>{m.deltaMs != null ? fmtDelta(m.deltaMs) : "-"}</td>
                <td style={tdStyle}>{m.msPerOutputToken != null ? fmtMsPerTok(m.msPerOutputToken) : "-"}</td>
                <td style={tdStyle}>{m.costUsd != null ? fmtCost(m.costUsd) : "-"}</td>
                <td style={tdLeftStyle}>{m.serviceTier ?? "-"}</td>
                <td style={tdLeftStyle}>{m.inferenceGeo ?? "-"}</td>
                <td style={tdLeftStyle}>
                  {m.requestId ? (
                    <span
                      style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3 }}
                      onClick={() => copyRequestId(m.requestId!)}
                      title={m.requestId}
                    >
                      <span style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis" }}>{m.requestId.slice(0, 12)}...</span>
                      {copiedReqId === m.requestId ? <Check size={10} /> : <Copy size={10} />}
                    </span>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
