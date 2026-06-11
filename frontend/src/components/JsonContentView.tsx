import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Braces } from "lucide-react";
import { getJsonPrettyPrint, saveJsonPrettyPrint } from "../utils/localStorage";

/** Dispatched whenever the pretty-print preference changes so every mounted
 * JsonContentView re-reads it (same pattern as "theme-change" in App.tsx). */
const PRETTY_PRINT_EVENT = "json-pretty-print-change";

function useJsonPrettyPrint(): [boolean, (value: boolean) => void] {
  const [pretty, setPretty] = useState<boolean>(() => getJsonPrettyPrint());

  useEffect(() => {
    const onChange = () => setPretty(getJsonPrettyPrint());
    window.addEventListener(PRETTY_PRINT_EVENT, onChange);
    return () => window.removeEventListener(PRETTY_PRINT_EVENT, onChange);
  }, []);

  const update = (value: boolean) => {
    saveJsonPrettyPrint(value);
    window.dispatchEvent(new Event(PRETTY_PRINT_EVENT));
  };

  return [pretty, update];
}

/** Pretty-printed form of the content, or null when it isn't a JSON object/array
 * (or is already formatted identically — nothing to toggle). */
function tryPrettyPrint(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
    return pretty === trimmed ? null : pretty;
  } catch {
    return null;
  }
}

interface JsonContentViewProps {
  content: string;
  /** Style applied to the inner <pre>, matching the previous inline styles at each call site. */
  preStyle?: CSSProperties;
}

/**
 * Renders tool input/result content in a <pre>, with an inline toggle between
 * the raw JSON string and a pretty-printed view when the content is JSON.
 * The preference is global and persisted across all tool views.
 */
export default function JsonContentView({ content, preStyle }: JsonContentViewProps) {
  const [pretty, setPretty] = useJsonPrettyPrint();
  const prettyContent = useMemo(() => tryPrettyPrint(content), [content]);

  return (
    <div style={{ position: "relative" }}>
      {prettyContent !== null && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPretty(!pretty);
          }}
          title={pretty ? "Show raw JSON string" : "Pretty-print JSON"}
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 6px",
            fontSize: 10,
            color: pretty ? "var(--accent)" : "var(--text-muted)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          <Braces size={10} />
          {pretty ? "pretty" : "raw"}
        </button>
      )}
      <pre style={preStyle}>{pretty && prettyContent !== null ? prettyContent : content}</pre>
    </div>
  );
}
