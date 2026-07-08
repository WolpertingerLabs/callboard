import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Braces, ListTree, Text } from "lucide-react";
import { getJsonViewMode, saveJsonViewMode, type JsonViewMode } from "../utils/localStorage";
import JsonTreeView from "./JsonTreeView";

/** Dispatched whenever the JSON view-mode preference changes so every mounted
 * JsonContentView re-reads it (same pattern as "theme-change" in App.tsx). */
const VIEW_MODE_EVENT = "json-view-mode-change";

function useJsonViewMode(): [JsonViewMode, (value: JsonViewMode) => void] {
  const [mode, setMode] = useState<JsonViewMode>(() => getJsonViewMode());

  useEffect(() => {
    const onChange = () => setMode(getJsonViewMode());
    window.addEventListener(VIEW_MODE_EVENT, onChange);
    return () => window.removeEventListener(VIEW_MODE_EVENT, onChange);
  }, []);

  const update = (value: JsonViewMode) => {
    saveJsonViewMode(value);
    window.dispatchEvent(new Event(VIEW_MODE_EVENT));
  };

  return [mode, update];
}

/** Parsed object/array form of the content, or null when it isn't JSON. */
function tryParseJson(content: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const MODE_ORDER: JsonViewMode[] = ["tree", "pretty", "raw"];

const MODE_META: Record<JsonViewMode, { label: string; title: string; icon: typeof Braces }> = {
  tree: { label: "tree", title: "Key-value tree — click for pretty-printed JSON", icon: ListTree },
  pretty: { label: "pretty", title: "Pretty-printed JSON — click for raw string", icon: Braces },
  raw: { label: "raw", title: "Raw string — click for key-value tree", icon: Text },
};

interface JsonContentViewProps {
  content: string;
  /** Style applied to the inner <pre> (and inherited by the tree view),
   * matching the previous inline styles at each call site. */
  preStyle?: CSSProperties;
}

/**
 * Renders tool input/result content with an inline toggle cycling between a
 * collapsible key-value tree, pretty-printed JSON, and the raw string. The
 * preference is global and persisted across all tool views. Non-JSON content
 * renders as a plain <pre> with no toggle.
 */
export default function JsonContentView({ content, preStyle }: JsonContentViewProps) {
  const [mode, setMode] = useJsonViewMode();
  const parsed = useMemo(() => tryParseJson(content), [content]);

  if (parsed === null) {
    return <pre style={preStyle}>{content}</pre>;
  }

  const meta = MODE_META[mode];
  const Icon = meta.icon;
  const nextMode = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setMode(nextMode);
        }}
        title={meta.title}
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 6px",
          fontSize: 10,
          color: mode === "raw" ? "var(--text-muted)" : "var(--accent)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          cursor: "pointer",
          zIndex: 1,
        }}
      >
        <Icon size={10} />
        {meta.label}
      </button>
      {mode === "tree" ? (
        // The tree supplies its own layout; carry over the call site's
        // spacing/typography intended for the <pre>.
        <div style={{ ...preStyle, whiteSpace: undefined, maxHeight: preStyle?.maxHeight ?? 400, overflow: "auto" }}>
          <JsonTreeView value={parsed} />
        </div>
      ) : (
        <pre style={preStyle}>{mode === "pretty" ? JSON.stringify(parsed, null, 2) : content}</pre>
      )}
    </div>
  );
}
