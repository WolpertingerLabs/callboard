import { useState, useEffect } from "react";
import { FolderOpen, Check, Save, KeyRound, Globe, Monitor, Wifi, WifiOff, ShieldAlert, Loader2 } from "lucide-react";
import FolderBrowser from "../../components/FolderBrowser";
import { getAgentSettings, updateAgentSettings, getKeyAliases, testProxyConnection } from "../../api";
import type { AgentSettings, KeyAliasInfo, ConnectionTestResult } from "../../api";

export default function ProxySettings() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [mcpConfigDir, setMcpConfigDir] = useState("");
  const [localMcpConfigDir, setLocalMcpConfigDir] = useState("");
  const [remoteMcpConfigDir, setRemoteMcpConfigDir] = useState("");
  const [proxyMode, setProxyMode] = useState<"local" | "remote" | undefined>(undefined);
  const [remoteServerUrl, setRemoteServerUrl] = useState("");
  const [keyAliases, setKeyAliases] = useState<KeyAliasInfo[]>([]);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  // Load settings on mount
  useEffect(() => {
    getAgentSettings()
      .then((s) => {
        setSettings(s);
        setMcpConfigDir(s.mcpConfigDir || "");
        setLocalMcpConfigDir(s.localMcpConfigDir || "");
        setRemoteMcpConfigDir(s.remoteMcpConfigDir || "");
        setProxyMode(s.proxyMode || undefined);
        setRemoteServerUrl(s.remoteServerUrl || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Resolve the active config dir based on current proxy mode
  const displayedConfigDir = (() => {
    if (proxyMode === "local") return localMcpConfigDir || mcpConfigDir;
    if (proxyMode === "remote") return remoteMcpConfigDir || mcpConfigDir;
    return mcpConfigDir;
  })();

  // Load key aliases when the active MCP config dir changes
  useEffect(() => {
    // Resolve from saved settings (not local state) to match what backend uses
    const activeDir = (() => {
      if (!settings) return null;
      if (settings.proxyMode === "local") return settings.localMcpConfigDir || settings.mcpConfigDir;
      if (settings.proxyMode === "remote") return settings.remoteMcpConfigDir || settings.mcpConfigDir;
      return settings.mcpConfigDir;
    })();

    if (activeDir) {
      getKeyAliases()
        .then(setKeyAliases)
        .catch(() => setKeyAliases([]));
    } else {
      setKeyAliases([]);
    }
  }, [settings?.mcpConfigDir, settings?.localMcpConfigDir, settings?.remoteMcpConfigDir, settings?.proxyMode]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateAgentSettings({
        mcpConfigDir: mcpConfigDir || undefined,
        localMcpConfigDir: localMcpConfigDir || undefined,
        remoteMcpConfigDir: remoteMcpConfigDir || undefined,
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
    if (proxyMode === "local") {
      setLocalMcpConfigDir(path);
    } else if (proxyMode === "remote") {
      setRemoteMcpConfigDir(path);
    } else {
      setMcpConfigDir(path);
    }
    setShowFolderBrowser(false);
    setSaved(false);
  };

  const handleTestConnection = async () => {
    if (!remoteServerUrl) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProxyConnection(remoteServerUrl);
      setTestResult(result);
    } catch {
      setTestResult({ status: "unreachable", message: "Failed to reach backend" });
    } finally {
      setTesting(false);
    }
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
    <>
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
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              MCP Config Directory
              {proxyMode && <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)", marginLeft: 6 }}>({proxyMode} mode)</span>}
            </span>
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
              value={displayedConfigDir}
              onChange={(e) => {
                const val = e.target.value;
                if (proxyMode === "local") {
                  setLocalMcpConfigDir(val);
                } else if (proxyMode === "remote") {
                  setRemoteMcpConfigDir(val);
                } else {
                  setMcpConfigDir(val);
                }
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

          {displayedConfigDir && keyAliases.length === 0 && (
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
                  {displayedConfigDir}/keys/local/
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
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={remoteServerUrl}
                  onChange={(e) => {
                    setRemoteServerUrl(e.target.value);
                    setSaved(false);
                    setTestResult(null);
                  }}
                  placeholder="e.g. https://proxy.example.com:9999"
                  style={{
                    flex: 1,
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
                <button
                  onClick={handleTestConnection}
                  disabled={testing || !remoteServerUrl}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: testing || !remoteServerUrl ? "var(--text-muted)" : "var(--text)",
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: testing || !remoteServerUrl ? "not-allowed" : "pointer",
                    flexShrink: 0,
                    transition: "background 0.15s",
                    opacity: testing || !remoteServerUrl ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!testing && remoteServerUrl) e.currentTarget.style.background = "var(--bg-secondary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg)";
                  }}
                >
                  {testing ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Wifi size={14} />}
                  {testing ? "Testing..." : "Test"}
                </button>
              </div>

              {/* Connection test result */}
              {testResult && (
                <div
                  style={{
                    marginTop: 10,
                    padding: "10px 14px",
                    borderRadius: 8,
                    fontSize: 12,
                    lineHeight: 1.5,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    border: `1px solid ${
                      testResult.status === "connected"
                        ? "color-mix(in srgb, #22c55e 30%, transparent)"
                        : testResult.status === "handshake_failed"
                          ? "color-mix(in srgb, #f59e0b 30%, transparent)"
                          : "color-mix(in srgb, #ef4444 30%, transparent)"
                    }`,
                    background:
                      testResult.status === "connected"
                        ? "color-mix(in srgb, #22c55e 8%, transparent)"
                        : testResult.status === "handshake_failed"
                          ? "color-mix(in srgb, #f59e0b 8%, transparent)"
                          : "color-mix(in srgb, #ef4444 8%, transparent)",
                    color: testResult.status === "connected" ? "#22c55e" : testResult.status === "handshake_failed" ? "#f59e0b" : "#ef4444",
                  }}
                >
                  {testResult.status === "connected" ? (
                    <Check size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  ) : testResult.status === "handshake_failed" ? (
                    <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  ) : (
                    <WifiOff size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  )}
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      {testResult.status === "connected" ? "Connected" : testResult.status === "handshake_failed" ? "Handshake Failed" : "Unreachable"}
                    </div>
                    <div style={{ opacity: 0.85 }}>{testResult.message}</div>
                  </div>
                </div>
              )}
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

      <FolderBrowser
        isOpen={showFolderBrowser}
        onClose={() => setShowFolderBrowser(false)}
        onSelect={handleFolderSelect}
        initialPath={displayedConfigDir || "/"}
      />
    </>
  );
}
