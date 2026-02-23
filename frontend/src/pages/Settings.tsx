import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ChevronLeft, SlidersHorizontal, Plug, Globe, Wifi, LogOut } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import GeneralSettings from "./settings/GeneralSettings";
import PluginsSettings from "./settings/PluginsSettings";
import ProxySettings from "./settings/ProxySettings";
import ConnectionsSettings from "./settings/ConnectionsSettings";
import AccountSettings from "./settings/AccountSettings";

const tabs = [
  { key: "general", label: "General", icon: SlidersHorizontal },
  { key: "plugins", label: "Plugins & MCP", icon: Plug },
  { key: "proxy", label: "Proxy", icon: Globe },
  { key: "connections", label: "Connections", icon: Wifi },
  { key: "account", label: "Account", icon: LogOut },
];

interface SettingsProps {
  onLogout: () => void;
}

export default function Settings({ onLogout }: SettingsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState(() => (location.state as { tab?: string } | null)?.tab || "general");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        {isMobile && (
          <button
            onClick={() => navigate("/")}
            style={{
              background: "none",
              padding: "4px 8px",
              display: "flex",
              alignItems: "center",
              color: "var(--text)",
            }}
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <div style={{ fontSize: 18, fontWeight: 600 }}>Settings</div>
      </header>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          overflowX: "auto",
        }}
      >
        {tabs.map(({ key, label, icon: Icon }) => {
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 16px",
                borderRadius: 8,
                border: "none",
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                background: isActive ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                color: isActive ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "background 0.15s, color 0.15s",
                whiteSpace: "nowrap",
                flex: isMobile ? 1 : undefined,
                justifyContent: isMobile ? "center" : undefined,
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = "var(--bg-secondary)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {activeTab === "general" && <GeneralSettings />}
        {activeTab === "plugins" && <PluginsSettings />}
        {activeTab === "proxy" && <ProxySettings />}
        {activeTab === "connections" && <ConnectionsSettings onSwitchTab={setActiveTab} />}
        {activeTab === "account" && <AccountSettings onLogout={onLogout} />}
      </div>
    </div>
  );
}
