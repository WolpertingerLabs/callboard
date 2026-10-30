import { useState, useEffect } from "react";
import { fetchInstanceName } from "../api";
import SidebarControls from "./SidebarControls";

interface SidebarHeaderProps {
  onToggleNew: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  onToggleSidebar?: () => void;
}

export default function SidebarHeader({ onToggleNew, claudeLoggedIn, onShowClaudeModal, onToggleSidebar }: SidebarHeaderProps) {
  const [instanceName, setInstanceName] = useState("");

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
      <SidebarControls
        orientation="horizontal"
        onNewChat={onToggleNew}
        claudeLoggedIn={claudeLoggedIn}
        onShowClaudeModal={onShowClaudeModal}
        onToggleSidebar={onToggleSidebar}
      />
    </header>
  );
}
