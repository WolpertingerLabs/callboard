import { useMemo, useState, type CSSProperties } from "react";
import { ChevronRight, ChevronDown, Braces } from "lucide-react";

/**
 * Collapsible key-value tree for JSON tool inputs/results.
 *
 * Motivation: tool payloads (Edit's old_string/new_string, Bash results,
 * MCP tool outputs) are JSON-encoded, so multiline strings render as one
 * unreadable line full of `\n` escapes in both the raw and pretty-printed
 * views. This view renders each key on its own row, expands nested
 * objects/arrays, and shows multiline/long strings as proper code blocks
 * with real line breaks.
 *
 * - Objects/arrays auto-expand to {@link AUTO_EXPAND_DEPTH}; deeper levels
 *   start collapsed with a `{…} 3 keys` / `[…] 5 items` preview.
 * - Short single-line strings, numbers, booleans, and null render inline.
 * - Multiline or long strings collapse to a first-line preview; expanding
 *   shows the full text in a wrapped, scrollable <pre>.
 * - Strings that themselves parse as JSON objects/arrays (double-encoded
 *   payloads are common in tool results) get a `{}` toggle to view them as
 *   a nested tree.
 * - Arrays/objects with more than {@link MAX_CHILDREN} entries render the
 *   first chunk plus an explicit "show N more" expander — no silent caps.
 */

/** Strings at or under this length (and without newlines) render inline. */
const MAX_INLINE_STRING = 60;
/** Chars of the first line shown in a collapsed string preview. */
const PREVIEW_LENGTH = 60;
/** Depths ≤ this start expanded (root is depth 0). */
const AUTO_EXPAND_DEPTH = 1;
/** Children rendered per container before a "show N more" expander. */
const MAX_CHILDREN = 100;
/** Indent per nesting level, in px. */
const INDENT = 14;

function isMultiline(s: string): boolean {
  return s.includes("\n");
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  const line = nl === -1 ? s : s.slice(0, nl);
  return line.length > PREVIEW_LENGTH ? line.slice(0, PREVIEW_LENGTH) + "…" : line;
}

/** Parse a string that is itself an encoded JSON object/array, else null. */
function tryParseNestedJson(s: string): unknown | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const keyStyle: CSSProperties = { color: "var(--accent-text)", flexShrink: 0 };
const punctStyle: CSSProperties = { color: "var(--text-muted)" };
const primitiveStyle: CSSProperties = { color: "var(--text-secondary)" };

function KeyLabel({ name }: { name?: string }) {
  if (name === undefined) return null;
  return (
    <>
      <span style={keyStyle}>{name}</span>
      <span style={punctStyle}>: </span>
    </>
  );
}

/** Inline row for primitives and short strings. */
function InlineValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <span style={{ ...primitiveStyle, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{value === "" ? '""' : value}</span>;
  return <span style={{ ...primitiveStyle, fontStyle: "italic" }}>{value === null ? "null" : String(value)}</span>;
}

/** Collapsible block for multiline/long strings, with optional nested-JSON toggle. */
function StringNode({ name, value, depth }: { name?: string; value: string; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [asTree, setAsTree] = useState(false);
  const nested = useMemo(() => tryParseNestedJson(value), [value]);
  const lines = useMemo(() => value.split("\n").length, [value]);

  return (
    <div style={{ paddingLeft: depth > 0 ? INDENT : 0 }}>
      <div
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        style={{ cursor: "pointer", display: "flex", alignItems: "baseline", gap: 2 }}
      >
        <span style={{ flexShrink: 0, alignSelf: "center", display: "flex" }}>
          {expanded ? <ChevronDown size={11} style={{ opacity: 0.5 }} /> : <ChevronRight size={11} style={{ opacity: 0.5 }} />}
        </span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <KeyLabel name={name} />
          {!expanded && (
            <span style={punctStyle}>
              {firstLine(value)}
              {isMultiline(value) ? ` … (${lines} lines)` : ""}
            </span>
          )}
        </span>
        {expanded && nested !== null && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAsTree(!asTree);
            }}
            title={asTree ? "Show as text" : "Parse string as JSON"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              padding: "0px 5px",
              fontSize: 10,
              color: asTree ? "var(--accent)" : "var(--text-muted)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Braces size={9} />
            {asTree ? "text" : "json"}
          </button>
        )}
      </div>
      {expanded &&
        (asTree && nested !== null ? (
          // depth 0 so the explicitly-requested parse starts expanded; the
          // wrapper div supplies this level's indentation.
          <div style={{ paddingLeft: INDENT }}>
            <TreeNode value={nested} depth={0} />
          </div>
        ) : (
          <pre
            onClick={(e) => e.stopPropagation()}
            style={{
              margin: "2px 0 4px 13px",
              padding: "6px 8px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--code-bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              maxHeight: 300,
              overflow: "auto",
              fontSize: "inherit",
              color: "var(--text-secondary)",
              cursor: "auto",
              userSelect: "text",
            }}
          >
            {value}
          </pre>
        ))}
    </div>
  );
}

/** Collapsible container row for objects and arrays. */
function ContainerNode({ name, value, depth }: { name?: string; value: Record<string, unknown> | unknown[]; depth: number }) {
  const [expanded, setExpanded] = useState(depth <= AUTO_EXPAND_DEPTH);
  const [showAll, setShowAll] = useState(false);
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const summary = isArray
    ? `[…] ${entries.length} item${entries.length === 1 ? "" : "s"}`
    : `{…} ${entries.length} key${entries.length === 1 ? "" : "s"}`;

  if (entries.length === 0) {
    return (
      <div style={{ paddingLeft: depth > 0 ? INDENT : 0, display: "flex", alignItems: "baseline", gap: 2 }}>
        {/* spacer aligns with chevron'd siblings */}
        <span style={{ width: 11, flexShrink: 0 }} />
        <span>
          <KeyLabel name={name} />
          <span style={punctStyle}>{isArray ? "[]" : "{}"}</span>
        </span>
      </div>
    );
  }

  const visible = showAll ? entries : entries.slice(0, MAX_CHILDREN);

  return (
    <div style={{ paddingLeft: depth > 0 ? INDENT : 0 }}>
      <div
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 2 }}
      >
        <span style={{ flexShrink: 0, display: "flex" }}>
          {expanded ? <ChevronDown size={11} style={{ opacity: 0.5 }} /> : <ChevronRight size={11} style={{ opacity: 0.5 }} />}
        </span>
        <span>
          <KeyLabel name={name} />
          <span style={punctStyle}>{expanded ? (isArray ? "[" : "{") : summary}</span>
        </span>
      </div>
      {expanded && (
        <>
          {visible.map(([k, v]) => (
            <TreeNode key={k} name={k} value={v} depth={depth + 1} />
          ))}
          {!showAll && entries.length > MAX_CHILDREN && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                setShowAll(true);
              }}
              style={{ paddingLeft: INDENT + 13, color: "var(--accent-text)", cursor: "pointer", fontStyle: "italic" }}
            >
              … show {entries.length - MAX_CHILDREN} more
            </div>
          )}
          <div style={{ paddingLeft: 13 }}>
            <span style={punctStyle}>{isArray ? "]" : "}"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function TreeNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  if (typeof value === "object" && value !== null) {
    return <ContainerNode name={name} value={value as Record<string, unknown> | unknown[]} depth={depth} />;
  }
  if (typeof value === "string" && (isMultiline(value) || value.length > MAX_INLINE_STRING)) {
    return <StringNode name={name} value={value} depth={depth} />;
  }
  return (
    <div style={{ paddingLeft: depth > 0 ? INDENT : 0, display: "flex", alignItems: "baseline", gap: 2 }}>
      <span style={{ width: 11, flexShrink: 0 }} />
      <span style={{ minWidth: 0, wordBreak: "break-word" }}>
        <KeyLabel name={name} />
        <InlineValue value={value} />
      </span>
    </div>
  );
}

interface JsonTreeViewProps {
  /** Already-parsed JSON value (object or array at the root). */
  value: unknown;
  /** Style for the outer container (font sizing etc. from the call site). */
  style?: CSSProperties;
}

export default function JsonTreeView({ value, style }: JsonTreeViewProps) {
  return (
    <div style={{ fontFamily: "monospace", lineHeight: 1.5, ...style }} onClick={(e) => e.stopPropagation()}>
      <TreeNode value={value} depth={0} />
    </div>
  );
}
