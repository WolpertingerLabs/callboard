import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Settings, Bot, PanelLeftClose, List, FolderOpen, AlertTriangle, Plus, GitBranch } from "lucide-react";
import { fetchInstanceName } from "../api";

interface SidebarHeaderProps {
  viewMode: "chats" | "folders";
  onToggleNew: () => void;
  onViewModeChange?: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  onToggleSidebar?: () => void;
}

export default function SidebarHeader({ viewMode, onToggleNew, onViewModeChange, claudeLoggedIn, onShowClaudeModal, onToggleSidebar }: SidebarHeaderProps) {
  const [instanceName, setInstanceName] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsActive = location.pathname === "/settings";
  const isAgentsActive = location.pathname.startsWith("/agents");
  const isBranchesActive = location.pathname === "/branches";

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
            background: "var(--accent)",
            color: "var(--text-on-accent)",
            padding: "6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="New Chat"
        >
          <Plus size={16} />
        </button>
        {onViewModeChange && (
          <div style={{ display: "flex" }}>
            <button
              onClick={viewMode === "folders" ? undefined : onViewModeChange}
              style={{
                background: viewMode === "folders" ? "var(--accent)" : "var(--bg-secondary)",
                color: viewMode === "folders" ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
                padding: "6px",
                borderTopLeftRadius: 6,
                borderBottomLeftRadius: 6,
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                border: viewMode === "folders" ? "none" : "1px solid var(--chatlist-item-border)",
                borderRight: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title={viewMode === "folders" ? "Folders view (active)" : "Switch to folders view"}
            >
              <FolderOpen size={16} />
            </button>
            <button
              onClick={viewMode === "chats" ? undefined : onViewModeChange}
              style={{
                background: viewMode === "chats" ? "var(--accent)" : "var(--bg-secondary)",
                color: viewMode === "chats" ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
                padding: "6px",
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: 6,
                borderBottomRightRadius: 6,
                border: viewMode === "chats" ? "none" : "1px solid var(--chatlist-item-border)",
                borderLeft: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title={viewMode === "chats" ? "Chats view (active)" : "Switch to chats view"}
            >
              <List size={16} />
            </button>
          </div>
        )}
        <div style={{ display: "flex" }}>
          <button
            onClick={() => navigate("/branches")}
            style={{
              background: isBranchesActive ? "var(--accent)" : "var(--bg-secondary)",
              color: isBranchesActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
              padding: "6px",
              borderTopLeftRadius: 6,
              borderBottomLeftRadius: 6,
              borderTopRightRadius: 0,
              borderBottomRightRadius: 0,
              border: isBranchesActive ? "none" : "1px solid var(--chatlist-item-border)",
              borderRight: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Branches"
          >
            <GitBranch size={16} />
          </button>
          <button
            onClick={() => navigate("/agents")}
            style={{
              background: isAgentsActive ? "var(--accent)" : "var(--bg-secondary)",
              color: isAgentsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
              padding: "6px",
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderTopRightRadius: 0,
              borderBottomRightRadius: 0,
              border: isAgentsActive ? "none" : "1px solid var(--chatlist-item-border)",
              borderLeft: "none",
              borderRight: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Agents"
          >
            <Bot size={16} />
          </button>
          <button
            onClick={() => navigate("/settings")}
            style={{
              background: isSettingsActive ? "var(--accent)" : "var(--bg-secondary)",
              color: isSettingsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
              padding: "6px",
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderTopRightRadius: 6,
              borderBottomRightRadius: 6,
              border: isSettingsActive ? "none" : "1px solid var(--chatlist-item-border)",
              borderLeft: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
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
