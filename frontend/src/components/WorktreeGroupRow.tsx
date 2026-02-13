import { useState } from "react";
import { ChevronRight, ChevronDown, GitBranch } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

interface WorktreeItem {
  path: string;
  name: string;
  branch?: string | null;
}

interface WorktreeGroupRowProps {
  mainRepo: { path: string; name: string; isGitRepo?: boolean };
  worktrees: WorktreeItem[];
  /** Called when user selects a directory (recent: start chat; browser: double-click select) */
  onSelect: (path: string) => void;
  /** Called on single-click to navigate into a directory (browser variant only) */
  onNavigate?: (path: string) => void;
  /** Called when user clicks remove button (recent variant only) */
  onRemove?: (path: string) => void;
  /** Controls styling and click behavior */
  variant: "recent" | "browser";
}

export default function WorktreeGroupRow({ mainRepo, worktrees, onSelect, onNavigate, onRemove, variant }: WorktreeGroupRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();

  const handleMainClick = () => {
    if (variant === "browser" && onNavigate) {
      onNavigate(mainRepo.path);
    } else {
      onSelect(mainRepo.path);
    }
  };

  const handleMainDoubleClick = () => {
    if (variant === "browser") {
      onSelect(mainRepo.path);
    }
  };

  const handleWorktreeClick = (path: string) => {
    if (variant === "browser" && onNavigate) {
      onNavigate(path);
    } else {
      onSelect(path);
    }
  };

  const handleWorktreeDoubleClick = (path: string) => {
    if (variant === "browser") {
      onSelect(path);
    }
  };

  if (variant === "recent") {
    return (
      <div style={{ marginBottom: 4 }}>
        {/* Main repo row */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {/* Expand/collapse chevron */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            style={{
              background: "none",
              border: "none",
              padding: 4,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
            title={expanded ? "Collapse worktrees" : "Show worktrees"}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          {/* Main repo button */}
          <button
            onClick={handleMainClick}
            title={mainRepo.path}
            style={{
              flex: 1,
              textAlign: "left",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                direction: "rtl",
              }}
            >
              {mainRepo.path}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                background: "var(--bg-secondary)",
                padding: "2px 6px",
                borderRadius: 4,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {worktrees.length} worktree{worktrees.length !== 1 ? "s" : ""}
            </span>
          </button>

          {/* Remove button */}
          {onRemove && (
            <button
              onClick={() => onRemove(mainRepo.path)}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px",
                fontSize: 12,
                color: "var(--text-muted)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 28,
                height: 28,
              }}
              title={`Remove ${mainRepo.path} from recent directories`}
            >
              ×
            </button>
          )}
        </div>

        {/* Expanded worktree sub-items */}
        {expanded && (
          <div style={{ paddingLeft: 28, marginTop: 2 }}>
            {worktrees.map((wt) => (
              <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                <button
                  onClick={() => handleWorktreeClick(wt.path)}
                  title={wt.path}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 13,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    overflow: "hidden",
                    opacity: 0.85,
                  }}
                >
                  <GitBranch size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      direction: "rtl",
                    }}
                  >
                    {wt.path}
                  </span>
                  {wt.branch && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        fontStyle: "italic",
                        flexShrink: 0,
                      }}
                    >
                      {wt.branch}
                    </span>
                  )}
                </button>

                {onRemove && (
                  <button
                    onClick={() => onRemove(wt.path)}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "8px",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 28,
                      height: 28,
                    }}
                    title={`Remove ${wt.path} from recent directories`}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // variant === "browser"
  return (
    <div>
      {/* Main repo row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: isMobile ? 6 : 8,
          padding: isMobile ? "8px 10px" : "8px 12px",
          borderRadius: 6,
          cursor: "pointer",
          marginBottom: 2,
          minHeight: isMobile ? 44 : 40,
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface)")}
        onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {/* Expand/collapse chevron */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          style={{
            background: "none",
            border: "none",
            padding: 2,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
          title={expanded ? "Collapse worktrees" : "Show worktrees"}
        >
          {expanded ? <ChevronDown size={isMobile ? 12 : 14} /> : <ChevronRight size={isMobile ? 12 : 14} />}
        </button>

        <div
          onClick={handleMainClick}
          onDoubleClick={handleMainDoubleClick}
          style={{
            display: "flex",
            alignItems: "center",
            gap: isMobile ? 6 : 8,
            flex: 1,
            minWidth: 0,
            cursor: "pointer",
          }}
        >
          <GitBranch size={isMobile ? 14 : 16} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span
            style={{
              fontSize: isMobile ? 13 : 14,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {mainRepo.name}
          </span>
          <span
            style={{
              fontSize: isMobile ? 10 : 11,
              color: "var(--text-muted)",
              background: "var(--bg-secondary)",
              padding: "2px 6px",
              borderRadius: 4,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {worktrees.length} worktree{worktrees.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Expanded worktree sub-items */}
      {expanded && (
        <div style={{ paddingLeft: isMobile ? 24 : 32 }}>
          {worktrees.map((wt) => (
            <div
              key={wt.path}
              onClick={() => handleWorktreeClick(wt.path)}
              onDoubleClick={() => handleWorktreeDoubleClick(wt.path)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: isMobile ? 6 : 8,
                padding: isMobile ? "6px 10px" : "6px 12px",
                borderRadius: 6,
                cursor: "pointer",
                marginBottom: 2,
                opacity: 0.85,
                minHeight: isMobile ? 38 : 34,
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface)")}
              onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <GitBranch size={isMobile ? 12 : 14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              <span
                style={{
                  fontSize: isMobile ? 12 : 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {wt.name}
              </span>
              {wt.branch && (
                <span
                  style={{
                    fontSize: isMobile ? 10 : 11,
                    color: "var(--text-muted)",
                    fontStyle: "italic",
                    flexShrink: 0,
                  }}
                >
                  {wt.branch}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
