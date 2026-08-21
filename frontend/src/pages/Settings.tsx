import { useEffect, useState } from "react";
import { useNavigate, useLocation, useParams } from "react-router-dom";
import { ChevronLeft, SlidersHorizontal, Plug, Globe, Wifi, LogOut, Info, Key, Sparkles, Workflow, Tags } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import GeneralSettings from "./settings/GeneralSettings";
import PluginsSettings from "./settings/PluginsSettings";
import ProxySettings from "./settings/ProxySettings";
import RemoteAccessSettings from "./settings/RemoteAccessSettings";
import AccountSettings from "./settings/AccountSettings";
import AboutSettings from "./settings/AboutSettings";
import ApiSettings from "./settings/ApiSettings";
import SkillsSettings from "./settings/SkillsSettings";
import JobsSettings from "./settings/JobsSettings";
import ModelAliasesSettings from "./settings/ModelAliasesSettings";

const tabs = [
  { key: "general", label: "General", icon: SlidersHorizontal },
  { key: "api", label: "API", icon: Key },
  { key: "model-aliases", label: "Model Aliases", icon: Tags },
  { key: "skills", label: "Skills", icon: Sparkles },
  { key: "jobs", label: "Jobs", icon: Workflow },
  { key: "plugins", label: "Plugins & MCP", icon: Plug },
  { key: "proxy", label: "Proxy", icon: Globe },
  { key: "remote", label: "Remote Access", icon: Wifi },
  { key: "account", label: "Account", icon: LogOut },
  { key: "about", label: "About", icon: Info },
];

interface SettingsProps {
  onLogout: () => void;
}

const validTabKeys = new Set(tabs.map((t) => t.key));

export default function Settings({ onLogout }: SettingsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState(() => {
    if (tabParam && validTabKeys.has(tabParam)) return tabParam;
    return (location.state as { tab?: string } | null)?.tab || "general";
  });

  // Follow `/settings/:tab` when it changes *after* mount. The initializer above
  // only runs once, and this component does not remount when the param changes —
  // so before this, a link from one settings pane to another (the engine cards'
  // "Check for a Callboard update" → About) moved the URL and left the visible
  // tab exactly where it was. The tab strip itself does not write to the URL, so
  // this cannot fight it: `tabParam` only moves when something navigates.
  useEffect(() => {
    if (tabParam && validTabKeys.has(tabParam)) setActiveTab(tabParam);
  }, [tabParam]);

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
        {activeTab === "api" && <ApiSettings />}
        {activeTab === "model-aliases" && <ModelAliasesSettings />}
        {activeTab === "skills" && <SkillsSettings />}
        {activeTab === "jobs" && <JobsSettings />}
        {activeTab === "plugins" && <PluginsSettings />}
        {activeTab === "proxy" && <ProxySettings />}
        {activeTab === "remote" && <RemoteAccessSettings />}
        {activeTab === "account" && <AccountSettings onLogout={onLogout} />}
        {activeTab === "about" && <AboutSettings />}
      </div>
    </div>
  );
}
