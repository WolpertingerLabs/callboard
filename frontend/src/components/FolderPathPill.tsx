import { useEffect, useRef, useState } from "react";
import { Folder } from "lucide-react";

interface Props {
  path: string;
}

/**
 * A compact pill showing the last segment of a folder path, styled to match the
 * branch pill in ChatListItem. Hover (desktop) or click (mobile/universal)
 * reveals the full path in a small bubble. Click is captured so it never opens
 * the parent chat card.
 */
export default function FolderPathPill({ path }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const folderName = path.split("/").pop() || path;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} style={{ position: "relative", display: "inline-flex", minWidth: 0 }}>
      <span
        title={path}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 10,
          padding: "0 5px",
          borderRadius: 3,
          background: "var(--chatlist-badge-agent-bg)",
          color: "var(--chatlist-item-time-text)",
          maxWidth: 120,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        <Folder size={10} style={{ flexShrink: 0 }} />
        {folderName}
      </span>
      {open && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            zIndex: 1000,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 11,
            color: "var(--text)",
            maxWidth: 280,
            wordBreak: "break-all",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
          }}
        >
          {path}
        </span>
      )}
    </span>
  );
}
