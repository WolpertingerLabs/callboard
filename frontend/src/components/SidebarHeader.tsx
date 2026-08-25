import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Settings, Bot, PanelLeftClose, List, FolderOpen, AlertTriangle, Plus, LayoutGrid } from "lucide-react";
import { fetchInstanceName } from "../api";
import type { SidebarViewMode } from "../utils/localStorage";

interface SidebarHeaderProps {
  viewMode: SidebarViewMode;
  onToggleNew: () => void;
  onViewModeChange?: (mode: SidebarViewMode) => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  onToggleSidebar?: () => void;
}

const VIEW_MODES: { mode: SidebarViewMode; label: string; Icon: typeof List }[] = [
  { mode: "folders", label: "Folders", Icon: FolderOpen },
  { mode: "chats", label: "Chats", Icon: List },
];

// Give the new-chat/sidebar-view controls and the main-page navigation controls
// one explicit footprint. Their different active borders (and the selectively
// suppressed borders inside each group) must not change the controls' size.
const HEADER_BUTTON_STYLE = {
  width: 28,
  height: 28,
  padding: 0,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

export default function SidebarHeader({ viewMode, onToggleNew, onViewModeChange, claudeLoggedIn, onShowClaudeModal, onToggleSidebar }: SidebarHeaderProps) {
  const [instanceName, setInstanceName] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsActive = location.pathname === "/settings";
  const isAgentsActive = location.pathname.startsWith("/agents");
  const isBoardActive = location.pathname === "/board";

  useEffect(() => {
    fetchInstanceName()
      .then((name) => {
        setInstanceName(name);
        document.title = `Callboard / ${name}`;
      })
      .catch(() => {});
  }, []);

  return (
    <header
      style={{
        padding: "16px 20px",
        borderBottom: "1px solid var(--chatlist-header-border)",
        background: "var(--chatlist-header-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 1, color: "var(--chatlist-title-text)" }}>Callboard</h1>
        {instanceName && <div style={{ fontSize: 10, color: "var(--chatlist-subtitle-text)", fontWeight: 400, letterSpacing: 0.3 }}>{instanceName}</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          onClick={onToggleNew}
          style={{
            ...HEADER_BUTTON_STYLE,
            background: "var(--accent)",
            color: "var(--text-on-accent)",
            borderRadius: 6,
          }}
          title="New Chat"
        >
          <Plus size={16} />
        </button>
        {onViewModeChange && (
          <div style={{ display: "flex" }}>
            {VIEW_MODES.map(({ mode, label, Icon }, i) => {
              const isActiveMode = viewMode === mode;
              const isFirst = i === 0;
              const isLast = i === VIEW_MODES.length - 1;
              return (
                <button
                  key={mode}
                  onClick={isActiveMode ? undefined : () => onViewModeChange(mode)}
                  style={{
                    ...HEADER_BUTTON_STYLE,
                    background: isActiveMode ? "var(--accent)" : "var(--bg-secondary)",
                    color: isActiveMode ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
                    borderTopLeftRadius: isFirst ? 6 : 0,
                    borderBottomLeftRadius: isFirst ? 6 : 0,
                    borderTopRightRadius: isLast ? 6 : 0,
                    borderBottomRightRadius: isLast ? 6 : 0,
                    border: isActiveMode ? "none" : "1px solid var(--chatlist-item-border)",
                    ...(isFirst && { borderRight: "none" }),
                    ...(isLast && { borderLeft: "none" }),
                  }}
                  title={isActiveMode ? `${label} view (active)` : `Switch to ${label.toLowerCase()} view`}
                >
                  <Icon size={16} />
                </button>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex" }}>
          <button
            onClick={() => navigate("/board")}
            style={{
              ...HEADER_BUTTON_STYLE,
              background: isBoardActive ? "var(--accent)" : "var(--bg-secondary)",
              color: isBoardActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
              borderTopLeftRadius: 6,
              borderBottomLeftRadius: 6,
              borderTopRightRadius: 0,
              borderBottomRightRadius: 0,
              border: isBoardActive ? "none" : "1px solid var(--chatlist-item-border)",
              borderRight: "none",
            }}
            title="Board"
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => navigate("/agents")}
            style={{
              ...HEADER_BUTTON_STYLE,
              background: isAgentsActive ? "var(--accent)" : "var(--bg-secondary)",
              color: isAgentsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
              borderRadius: 0,
              border: isAgentsActive ? "none" : "1px solid var(--chatlist-item-border)",
              borderRight: "none",
              borderLeft: "none",
            }}
            title="Agents"
          >
            <Bot size={16} />
          </button>
          <button
            onClick={() => navigate("/settings")}
            style={{
              ...HEADER_BUTTON_STYLE,
              background: isSettingsActive ? "var(--accent)" : "var(--bg-secondary)",
              color: isSettingsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderTopRightRadius: 6,
              borderBottomRightRadius: 6,
              border: isSettingsActive ? "none" : "1px solid var(--chatlist-item-border)",
              borderLeft: "none",
            }}
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>
        {claudeLoggedIn === false && onShowClaudeModal && (
          <button
            onClick={onShowClaudeModal}
            style={{
              background: "var(--warning-bg)",
              color: "var(--warning)",
              padding: "6px",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Claude Code login required"
          >
            <AlertTriangle size={16} />
          </button>
        )}
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            style={{
              background: "transparent",
              color: "var(--chatlist-icon)",
              padding: "6px",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>
    </header>
  );
}
