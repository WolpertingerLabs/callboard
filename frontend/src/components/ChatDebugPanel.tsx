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

/** Format token count with locale grouping */
function fmtTok(n?: number): string {
  if (n == null || n === 0) return "-";
  return n.toLocaleString();
}

type SortKey = "index" | "delta" | "msPerTok" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite";

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

  // Build rows: one row per unique API request, grouped by requestId.
  // A single API response may produce multiple JSONL entries (one per content
  // block: thinking, text, tool_use). These share the same requestId and have
  // duplicated input / cache token counts. We pick the canonical entry per
  // request (the one with stop_reason set, or the last entry) and recompute
  // inter-response timing deltas.
  const allRows: DebugRow[] = useMemo(() => {
    // Step 1: Collect assistant messages that carry usage data
    const assistantEntries: ParsedMessage[] = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.usage) {
        assistantEntries.push(m);
      }
    }

    // Step 2: Group by requestId, maintaining first-seen order.
    // Messages without a requestId are treated as their own group.
    const requestOrder: string[] = [];
    const byRequest = new Map<string, ParsedMessage[]>();
    let ungroupedIdx = 0;

    for (const m of assistantEntries) {
      const key = m.requestId || `__ungrouped_${ungroupedIdx++}`;
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

    // Step 4: Recompute inter-response timing deltas between grouped rows
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
          return ((am.deltaMs ?? 0) - (bm.deltaMs ?? 0)) * dir;
        case "msPerTok":
          return ((am.msPerOutputToken ?? 0) - (bm.msPerOutputToken ?? 0)) * dir;
        case "inputTokens":
          return ((am.usage?.input_tokens ?? 0) - (bm.usage?.input_tokens ?? 0)) * dir;
        case "outputTokens":
          return ((am.usage?.output_tokens ?? 0) - (bm.usage?.output_tokens ?? 0)) * dir;
        case "cacheRead":
          return ((am.usage?.cache_read_input_tokens ?? 0) - (bm.usage?.cache_read_input_tokens ?? 0)) * dir;
        case "cacheWrite":
          return ((am.usage?.cache_creation_input_tokens ?? 0) - (bm.usage?.cache_creation_input_tokens ?? 0)) * dir;
        default:
          return 0;
      }
    });
    return sorted;
  }, [filteredRows, sortKey, sortAsc]);

  // Aggregate stats
  const stats = useMemo(() => {
    const rows = filteredRows;
    if (rows.length === 0) return null;
    let totalIn = 0,
      totalOut = 0,
      totalCacheRead = 0,
      totalCacheWrite = 0;
    const deltas: number[] = [];
    const msPerToks: number[] = [];

    for (const { message: m } of rows) {
      totalIn += m.usage?.input_tokens ?? 0;
      totalOut += m.usage?.output_tokens ?? 0;
      totalCacheRead += m.usage?.cache_read_input_tokens ?? 0;
      totalCacheWrite += m.usage?.cache_creation_input_tokens ?? 0;
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
    const cacheHitRate = totalCacheRead + totalCacheWrite + totalIn > 0 ? (totalCacheRead / (totalCacheRead + totalCacheWrite + totalIn)) * 100 : null;

    return { totalIn, totalOut, totalCacheRead, totalCacheWrite, avgDelta, p95Delta, avgMsPerTok, cacheHitRate, count: rows.length };
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
            Cache read: <span style={{ fontWeight: 600, color: "var(--text)" }}>{stats.totalCacheRead.toLocaleString()}</span>
            {stats.cacheHitRate != null && <span> ({stats.cacheHitRate.toFixed(1)}%)</span>}
          </div>
          <div>
            Cache write: <span style={{ fontWeight: 600, color: "var(--text)" }}>{stats.totalCacheWrite.toLocaleString()}</span>
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
                color: "var(--accent)",
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
                  <span
                    style={{
                      color:
                        m.stopReason === "end_turn"
                          ? "var(--success, #22c55e)"
                          : m.stopReason === "tool_use"
                            ? "var(--accent)"
                            : m.stopReason === "max_tokens"
                              ? "var(--danger, #ef4444)"
                              : "var(--text-muted)",
                    }}
                  >
                    {m.stopReason ?? "-"}
                  </span>
                </td>
                <td style={tdStyle}>{fmtTok(m.usage?.input_tokens)}</td>
                <td style={tdStyle}>{fmtTok(m.usage?.output_tokens)}</td>
                <td style={tdStyle}>{fmtTok(m.usage?.cache_read_input_tokens)}</td>
                <td style={tdStyle}>{fmtTok(m.usage?.cache_creation_input_tokens)}</td>
                <td style={tdStyle}>{m.deltaMs != null ? fmtDelta(m.deltaMs) : "-"}</td>
                <td style={tdStyle}>{m.msPerOutputToken != null ? fmtMsPerTok(m.msPerOutputToken) : "-"}</td>
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
