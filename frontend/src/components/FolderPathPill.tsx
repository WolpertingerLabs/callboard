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
const BUBBLE_MAX_WIDTH = 360;

export default function FolderPathPill({ path }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const folderName = path.split("/").pop() || path;

  // The bubble is positioned `fixed` (viewport-relative) so it isn't clipped by
  // the sidebar's `overflow: hidden` or the scrollable chat list. Recompute its
  // anchor from the trigger's rect on open, and keep it in sync while scrolling
  // or resizing. `left` is clamped so a wide bubble never spills off-screen.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - BUBBLE_MAX_WIDTH - 8));
      setCoords({ top: r.bottom + 4, left });
    };
    update();
    // capture:true catches scrolls on any ancestor scroll container, not just window.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

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
        ref={triggerRef}
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
      {open && coords && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            zIndex: 1000,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 11,
            color: "var(--text)",
            width: "max-content",
            maxWidth: BUBBLE_MAX_WIDTH,
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
