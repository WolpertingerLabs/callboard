import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, FolderOpen, Check, Save, KeyRound, Globe, Monitor } from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import FolderBrowser from "../../components/FolderBrowser";
import { getAgentSettings, updateAgentSettings, getKeyAliases } from "../../api";
import type { AgentSettings, KeyAliasInfo } from "../../api";

export default function AgentSettingsPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [mcpConfigDir, setMcpConfigDir] = useState("");
  const [proxyMode, setProxyMode] = useState<"local" | "remote" | undefined>(undefined);
  const [remoteServerUrl, setRemoteServerUrl] = useState("");
  const [keyAliases, setKeyAliases] = useState<KeyAliasInfo[]>([]);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load settings on mount
  useEffect(() => {
    getAgentSettings()
      .then((s) => {
        setSettings(s);
        setMcpConfigDir(s.mcpConfigDir || "");
        setProxyMode(s.proxyMode || undefined);
        setRemoteServerUrl(s.remoteServerUrl || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Load key aliases when settings have an MCP config dir
  useEffect(() => {
    if (settings?.mcpConfigDir) {
      getKeyAliases()
        .then(setKeyAliases)
        .catch(() => setKeyAliases([]));
    } else {
      setKeyAliases([]);
    }
  }, [settings?.mcpConfigDir]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateAgentSettings({
        mcpConfigDir: mcpConfigDir || undefined,
        proxyMode: proxyMode || undefined,
        remoteServerUrl: remoteServerUrl || undefined,
      });
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Refresh key aliases after save
      getKeyAliases()
        .then(setKeyAliases)
        .catch(() => setKeyAliases([]));
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleFolderSelect = (path: string) => {
    setMcpConfigDir(path);
    setShowFolderBrowser(false);
    setSaved(false);
  };

  if (loading) return null;

  const radioStyle = (selected: boolean) => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
    background: selected ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "var(--bg)",
    cursor: "pointer" as const,
    transition: "all 0.15s",
    fontSize: 13,
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: isMobile ? "12px 16px" : "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => navigate("/agents")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            padding: 6,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
          }}
        >
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Agent Settings</h1>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: isMobile ? "16px" : "24px 20px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          {/* MCP Config Directory section */}
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 20,
              background: "var(--surface)",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <KeyRound size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>MCP Config Directory</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
              Path to the{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--bg-secondary)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                .mcp-secure-proxy/
              </code>{" "}
              directory containing your keys and identity. Key aliases are discovered from the{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--bg-secondary)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                keys/local/
              </code>{" "}
              subdirectories.
            </div>

            {/* Path input + browse */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
              <input
                type="text"
                value={mcpConfigDir}
                onChange={(e) => {
                  setMcpConfigDir(e.target.value);
                  setSaved(false);
                }}
                placeholder="e.g. /home/user/.mcp-secure-proxy"
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 14,
                  fontFamily: "monospace",
                }}
              />
              <button
                onClick={() => setShowFolderBrowser(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 14,
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg)")}
              >
                <FolderOpen size={16} />
                Browse
              </button>
            </div>

            {/* Discovered key aliases readout */}
            {keyAliases.length > 0 && (
              <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 8,
                  }}
                >
                  Discovered Key Aliases ({keyAliases.length})
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {keyAliases.map((ka) => (
                    <span
                      key={ka.alias}
                      style={{
                        fontSize: 12,
                        fontFamily: "monospace",
                        padding: "4px 10px",
                        borderRadius: 6,
                        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                        color: "var(--accent)",
                        border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                      }}
                    >
                      {ka.alias}
                      {(!ka.hasSigningPub || !ka.hasExchangePub) && <span style={{ color: "var(--warning)", marginLeft: 4 }}>(missing keys)</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {settings?.mcpConfigDir && keyAliases.length === 0 && (
              <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  No key aliases found in{" "}
                  <code
                    style={{
                      fontFamily: "monospace",
                      background: "var(--bg-secondary)",
                      padding: "1px 5px",
                      borderRadius: 4,
                    }}
                  >
                    {settings.mcpConfigDir}/keys/local/
                  </code>
                </div>
              </div>
            )}
          </div>

          {/* Proxy Mode section */}
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 20,
              background: "var(--surface)",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <Globe size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Proxy Mode</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
              How proxy tools connect to mcp-secure-proxy. Local mode runs in-process with no separate server. Remote mode connects to an external server over
              an encrypted channel.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: proxyMode === "remote" ? 16 : 0 }}>
              {/* Local option */}
              <div
                style={radioStyle(proxyMode === "local")}
                onClick={() => {
                  setProxyMode("local");
                  setSaved(false);
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    border: `2px solid ${proxyMode === "local" ? "var(--accent)" : "var(--border)"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {proxyMode === "local" && (
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--accent)",
                      }}
                    />
                  )}
                </div>
                <Monitor size={14} style={{ color: proxyMode === "local" ? "var(--accent)" : "var(--text-muted)", flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 500, color: proxyMode === "local" ? "var(--text)" : "var(--text-muted)" }}>Local</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    Runs in-process, no separate server. Best for single-machine setups.
                  </div>
                </div>
              </div>

              {/* Remote option */}
              <div
                style={radioStyle(proxyMode === "remote")}
                onClick={() => {
                  setProxyMode("remote");
                  setSaved(false);
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    border: `2px solid ${proxyMode === "remote" ? "var(--accent)" : "var(--border)"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {proxyMode === "remote" && (
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--accent)",
                      }}
                    />
                  )}
                </div>
                <Globe size={14} style={{ color: proxyMode === "remote" ? "var(--accent)" : "var(--text-muted)", flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 500, color: proxyMode === "remote" ? "var(--text)" : "var(--text-muted)" }}>Remote</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    Connect to an external MCP secure proxy server over encrypted channel.
                  </div>
                </div>
              </div>
            </div>

            {/* Remote server URL (shown when remote mode selected) */}
            {proxyMode === "remote" && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Server URL</div>
                <input
                  type="text"
                  value={remoteServerUrl}
                  onChange={(e) => {
                    setRemoteServerUrl(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="e.g. https://proxy.example.com:9999"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontSize: 14,
                    fontFamily: "monospace",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            )}
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "var(--accent)",
              color: "#fff",
              padding: "10px 20px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              cursor: saving ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => !saving && (e.currentTarget.style.background = "var(--accent-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saving ? "Saving..." : saved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>

      <FolderBrowser isOpen={showFolderBrowser} onClose={() => setShowFolderBrowser(false)} onSelect={handleFolderSelect} initialPath={mcpConfigDir || "/"} />
    </div>
  );
}
