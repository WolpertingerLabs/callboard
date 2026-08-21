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

  // The URL is the single source of truth for which pane is showing. Both halves
  // of that are load-bearing and the first cut only had one of them:
  //
  // - this effect follows `/settings/:tab` after mount (the initializer above
  //   runs once, and the component does not remount on a param change);
  // - `selectTab` below *navigates* rather than only calling setState.
  //
  // Without the second, the URL silently stopped matching the visible tab as
  // soon as anyone clicked the strip — so from `/settings/about`, the engine
  // card's `<Link to="/settings/about">` pushed an identical path, `tabParam`
  // never changed, and the link visibly did nothing. Which is exactly the state
  // the effect was added to fix.
  useEffect(() => {
    if (tabParam && validTabKeys.has(tabParam)) setActiveTab(tabParam);
  }, [tabParam]);

  /**
   * Show a pane, and say so in the URL.
   *
   * `setActiveTab` as well as navigating, rather than relying on the effect: the
   * `/settings` route has no `:tab` param at all, so a click there would
   * otherwise render nothing new until the navigation resolved.
   */
  const selectTab = (key: string) => {
    setActiveTab(key);
    navigate(`/settings/${key}`, { replace: true, state: { tab: key } });
  };

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
              onClick={() => selectTab(key)}
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
