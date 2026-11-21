import { History, X } from "lucide-react";
import LeftTruncatedPath from "./LeftTruncatedPath";

interface RecentDirectoryRowProps {
  path: string;
  /** Mobile: one line, 44px touch targets. Desktop: name over path, as Quick Access. */
  compact: boolean;
  /** The folder the browser is showing right now. */
  isCurrent: boolean;
  /** A tag for the folder the browser was opened above ("last used", "current"). */
  tag?: string;
  onNavigate: (path: string) => void;
  onSelect: (path: string) => void;
  /** Omitted, the row has no remove button. */
  onRemove?: (path: string) => void;
}

/** Last path segment, for a row's title line. */
const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || "/";

/** The small "last used" / "current" badge, shared with the directory listing. */
export function FocusTag({ label }: { label: string }) {
  return (
    <span data-testid="focus-tag" style={{ fontSize: 10, fontWeight: 500, opacity: 0.8, flexShrink: 0, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

/** One entry of the folder browser's "Previously used" section. Click navigates, double-click selects. */
export default function RecentDirectoryRow({ path, compact, isCurrent, tag, onNavigate, onSelect, onRemove }: RecentDirectoryRowProps) {
  const lastUsedTag = tag && <FocusTag label={tag} />;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: compact ? 44 : undefined,
        borderRadius: 6,
        marginBottom: 2,
        background: isCurrent ? "var(--accent)" : "none",
        color: isCurrent ? "var(--text-on-accent)" : "var(--text)",
      }}
    >
      <button
        type="button"
        onClick={() => onNavigate(path)}
        onDoubleClick={() => onSelect(path)}
        title={path}
        aria-current={isCurrent ? "location" : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: compact ? 44 : undefined,
          display: "flex",
          alignItems: "center",
          gap: compact ? 6 : 8,
          textAlign: "left",
          background: "none",
          color: "inherit",
          border: "none",
          padding: compact ? "0 4px 0 10px" : "8px 4px 8px 12px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        <History size={14} style={{ color: isCurrent ? "inherit" : "var(--text-muted)", flexShrink: 0 }} />
        {compact ? (
          <>
            <LeftTruncatedPath path={path} style={{ flex: 1 }} />
            {lastUsedTag}
          </>
        ) : (
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{baseName(path)}</span>
              {lastUsedTag}
            </div>
            <LeftTruncatedPath path={path} style={{ display: "block", fontSize: 11, opacity: 0.7 }} />
          </div>
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(path);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          aria-label={`Remove ${path} from previously used folders`}
          title={`Remove ${path} from previously used folders`}
          style={{
            background: "none",
            border: "none",
            padding: 4,
            borderRadius: 4,
            cursor: "pointer",
            color: isCurrent ? "var(--text-on-accent)" : "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            minWidth: compact ? 44 : 28,
            minHeight: compact ? 44 : 28,
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
