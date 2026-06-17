import { useState, useEffect } from "react";
import { FolderOpen, Check, Save, KeyRound, Globe, Monitor, Wifi, WifiOff, ShieldAlert, Loader2, RefreshCw, X, ArrowRight, Plus, ExternalLink, Server } from "lucide-react";
import FolderBrowser from "../../components/FolderBrowser";
import {
  getAgentSettings,
  updateAgentSettings,
  getKeyAliases,
  createCallerAlias,
  testProxyConnection,
  startSync,
  completeSync,
  cancelSync,
  getDaemonStatus,
} from "../../api";
import type { AgentSettings, KeyAliasInfo, ConnectionTestResult, DaemonStatus } from "../../api";

function formatUptime(seconds?: number): string | null {
  if (seconds === undefined || seconds === null) return null;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

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
  const [defaultLocalDir, setDefaultLocalDir] = useState("");
  const [defaultRemoteDir, setDefaultRemoteDir] = useState("");

  // Sync state
  const [syncStep, setSyncStep] = useState<"input" | "confirm" | "success">("input");
  const [syncInviteCode, setSyncInviteCode] = useState("");
  const [syncEncryptionKey, setSyncEncryptionKey] = useState("");
  const [syncCallerAlias, setSyncCallerAlias] = useState("");
  const [syncConfirmCode, setSyncConfirmCode] = useState("");
  const [syncResult, setSyncResult] = useState<{ callerAlias: string; fingerprint: string } | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Create alias state (local mode only)
  const [showNewAliasInput, setShowNewAliasInput] = useState(false);
  const [newAliasName, setNewAliasName] = useState("");
  const [newAliasError, setNewAliasError] = useState<string | null>(null);

  // Daemon status (merged in from the former Connections tab)
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [daemonError, setDaemonError] = useState<string | null>(null);

  // Load daemon status on mount (independent of settings; both fire in parallel)
  useEffect(() => {
    getDaemonStatus()
      .then((s) => {
        setDaemonStatus(s);
        setDaemonError(null);
      })
      .catch((err: Error) => setDaemonError(err.message));
  }, []);

  const daemonHealthy = daemonStatus?.health?.status === "ok";

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
        setDefaultLocalDir(s.defaultLocalMcpConfigDir || "");
        setDefaultRemoteDir(s.defaultRemoteMcpConfigDir || "");
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

  // Load key aliases when proxy mode or config dir changes.
  // The backend resolves the effective config dir (including built-in defaults
  // when no explicit dir is saved), so fetch unconditionally and let it return
  // an empty list when there is nothing to show.
  useEffect(() => {
    if (!settings) return;
    getKeyAliases(proxyMode)
      .then(setKeyAliases)
      .catch(() => setKeyAliases([]));
  }, [settings, proxyMode, localMcpConfigDir, mcpConfigDir, remoteMcpConfigDir]);

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
      getKeyAliases(updated.proxyMode)
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

  const handleCreateAlias = async () => {
    if (!newAliasName) return;
    try {
      setNewAliasError(null);
      await createCallerAlias(newAliasName);
      const updated = await getKeyAliases();
      setKeyAliases(updated);
      setNewAliasName("");
      setShowNewAliasInput(false);
    } catch (err: any) {
      setNewAliasError(err?.message || "Failed to create alias");
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
        {/* Daemon status (merged from former Connections tab) */}
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
            <Server size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>drawlatch daemon</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
            callboard delegates all proxy, connection, secret, listener and webhook-tunnel management to the drawlatch daemon. This panel only shows
            connectivity — open the dashboard below to manage everything else.
          </div>

          {daemonError && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.5,
                border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                background: "var(--danger-bg)",
                color: "var(--danger)",
                marginBottom: 16,
              }}
            >
              {daemonError}
            </div>
          )}

          {daemonStatus && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Mode */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {daemonStatus.mode === "local" ? (
                  <Monitor size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                ) : (
                  <Globe size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                )}
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: "var(--text-muted)" }}>Mode: </span>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>
                    {daemonStatus.mode === "local" ? (daemonStatus.managed ? "Managed local" : "Local") : "Remote"}
                  </span>
                  {daemonStatus.managed && daemonStatus.pid !== undefined && (
                    <span style={{ color: "var(--text-muted)", marginLeft: 6, fontFamily: "monospace", fontSize: 11 }}>(pid {daemonStatus.pid})</span>
                  )}
                </div>
              </div>

              {/* URL */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Globe size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <div style={{ fontSize: 13, minWidth: 0 }}>
                  <span style={{ color: "var(--text-muted)" }}>URL: </span>
                  {daemonStatus.url ? (
                    <code style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{daemonStatus.url}</code>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>not configured</span>
                  )}
                </div>
              </div>

              {/* Reachability / health */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: `1px solid ${
                    daemonHealthy ? "color-mix(in srgb, var(--success) 30%, transparent)" : "color-mix(in srgb, var(--danger) 30%, transparent)"
                  }`,
                  background: daemonHealthy ? "var(--success-bg)" : "var(--danger-bg)",
                  color: daemonHealthy ? "var(--success)" : "var(--danger)",
                }}
              >
                {daemonHealthy ? (
                  <Wifi size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                ) : (
                  <WifiOff size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                )}
                <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 600 }}>
                    {daemonHealthy ? "Reachable" : daemonStatus.reachable ? "Unhealthy" : "Unreachable"}
                  </div>
                  {daemonStatus.health && (
                    <div style={{ opacity: 0.85, marginTop: 2 }}>
                      {daemonStatus.health.activeSessions !== undefined && <span>{daemonStatus.health.activeSessions} active session(s)</span>}
                      {formatUptime(daemonStatus.health.uptime) && (
                        <span>
                          {daemonStatus.health.activeSessions !== undefined ? " · " : ""}up {formatUptime(daemonStatus.health.uptime)}
                        </span>
                      )}
                      {daemonStatus.health.tunnelUrl && (
                        <div style={{ marginTop: 2 }}>
                          tunnel: <code style={{ fontFamily: "monospace", fontSize: 11 }}>{daemonStatus.health.tunnelUrl}</code>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Enrolled aliases */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <KeyRound size={13} /> Enrolled callers ({daemonStatus.enrolledAliases.length})
                </div>
                {daemonStatus.enrolledAliases.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {daemonStatus.enrolledAliases.map((alias) => (
                      <span
                        key={alias}
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
                        {alias}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No callers enrolled yet.</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Manage connections in drawlatch (deep link) */}
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
            <ExternalLink size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Manage connections in drawlatch</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
            Connections, secrets, listeners, and the webhook tunnel are all managed in drawlatch&apos;s own password-gated dashboard. Open it to configure
            external services for your agents.
          </div>

          {daemonStatus?.dashboardUrl ? (
            <a
              href={daemonStatus.dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                padding: "10px 20px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
                textDecoration: "none",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
            >
              <ExternalLink size={14} />
              Open drawlatch dashboard
            </a>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              No dashboard URL available. Configure the drawlatch endpoint below first.
            </div>
          )}
        </div>

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
              .drawlatch.local/
            </code>{" "}
            directory containing your keys and identity. Caller aliases are discovered from the{" "}
            <code
              style={{
                fontFamily: "monospace",
                background: "var(--bg-secondary)",
                padding: "1px 5px",
                borderRadius: 4,
              }}
            >
              keys/callers/
            </code>{" "}
            subdirectories — enrollment is automatic in local mode (or via Sync in remote mode).
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
              placeholder={
                proxyMode === "local" && defaultLocalDir
                  ? `Default: ${defaultLocalDir}`
                  : proxyMode === "remote" && defaultRemoteDir
                    ? `Default: ${defaultRemoteDir}`
                    : "e.g. /home/user/.drawlatch.local"
              }
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

          {/* Key Aliases section */}
          <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Key Aliases ({keyAliases.length})
              </div>
              {proxyMode === "local" && !showNewAliasInput && (
                <button
                  type="button"
                  onClick={() => setShowNewAliasInput(true)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    background: "var(--bg)",
                    color: "var(--text-muted)",
                    border: "1px dashed var(--border)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Plus size={12} /> New Alias
                </button>
              )}
            </div>

            {/* Create alias inline (local mode only) */}
            {proxyMode === "local" && showNewAliasInput && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                <input
                  type="text"
                  value={newAliasName}
                  onChange={(e) => {
                    setNewAliasName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""));
                    setNewAliasError(null);
                  }}
                  placeholder="alias-name"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setShowNewAliasInput(false);
                      setNewAliasName("");
                      setNewAliasError(null);
                    }
                    if (e.key === "Enter" && newAliasName) handleCreateAlias();
                  }}
                  style={{
                    padding: "5px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontFamily: "monospace",
                    background: "var(--bg)",
                    color: "var(--text)",
                    border: newAliasError ? "1px solid var(--danger)" : "1px solid var(--border)",
                    width: 160,
                  }}
                />
                <button
                  type="button"
                  onClick={handleCreateAlias}
                  disabled={!newAliasName}
                  style={{
                    padding: "5px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    background: newAliasName ? "var(--accent)" : "var(--bg)",
                    color: newAliasName ? "var(--text-on-accent)" : "var(--text-muted)",
                    border: "1px solid var(--border)",
                    cursor: newAliasName ? "pointer" : "default",
                  }}
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNewAliasInput(false);
                    setNewAliasName("");
                    setNewAliasError(null);
                  }}
                  style={{
                    padding: "5px 8px",
                    borderRadius: 6,
                    fontSize: 12,
                    background: "transparent",
                    color: "var(--text-muted)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {newAliasError && <p style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>{newAliasError}</p>}

            {keyAliases.length > 0 ? (
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
                    {proxyMode !== "local" && (!ka.hasSigningPub || !ka.hasExchangePub) && (
                      <span style={{ color: "var(--warning)", marginLeft: 4 }}>(missing keys)</span>
                    )}
                  </span>
                ))}
              </div>
            ) : displayedConfigDir ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                No key aliases found.
                {proxyMode === "remote" && " Use the Sync feature below to add aliases from a remote server."}
              </div>
            ) : null}
          </div>
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
            How callboard connects to drawlatch. Local mode runs and supervises a managed daemon. Remote mode connects to an external server over an encrypted
            channel.
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
                  callboard runs and supervises a local drawlatch daemon and talks to it over the encrypted protocol.
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
                        ? "color-mix(in srgb, var(--success) 30%, transparent)"
                        : testResult.status === "handshake_failed"
                          ? "color-mix(in srgb, var(--warning) 30%, transparent)"
                          : "color-mix(in srgb, var(--danger) 30%, transparent)"
                    }`,
                    background:
                      testResult.status === "connected"
                        ? "var(--success-bg)"
                        : testResult.status === "handshake_failed"
                          ? "var(--warning-bg)"
                          : "var(--danger-bg)",
                    color: testResult.status === "connected" ? "var(--success)" : testResult.status === "handshake_failed" ? "var(--warning)" : "var(--danger)",
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

        {/* Sync with Remote Server (remote mode only) */}
        {proxyMode === "remote" && (
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
              <RefreshCw size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Sync with Remote Server</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
              Exchange keys with a drawlatch remote server. Run{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--bg-secondary)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                drawlatch sync
              </code>{" "}
              on the server first to get an invite code and encryption key.
            </div>

            {syncStep === "input" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Invite Code</div>
                  <input
                    type="text"
                    value={syncInviteCode}
                    onChange={(e) => {
                      setSyncInviteCode(e.target.value);
                      setSyncError(null);
                    }}
                    placeholder="WORD-1234"
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

                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Encryption Key</div>
                  <input
                    type="text"
                    value={syncEncryptionKey}
                    onChange={(e) => {
                      setSyncEncryptionKey(e.target.value);
                      setSyncError(null);
                    }}
                    placeholder="base64..."
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

                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Caller Alias</div>
                  <input
                    type="text"
                    value={syncCallerAlias}
                    onChange={(e) => {
                      setSyncCallerAlias(e.target.value);
                      setSyncError(null);
                    }}
                    placeholder="my-callboard"
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

                {syncError && (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      fontSize: 12,
                      lineHeight: 1.5,
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                      background: "var(--danger-bg)",
                      color: "var(--danger)",
                    }}
                  >
                    <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ opacity: 0.85 }}>{syncError}</div>
                  </div>
                )}

                <button
                  onClick={async () => {
                    if (!syncInviteCode || !syncEncryptionKey || !syncCallerAlias) {
                      setSyncError("All fields are required");
                      return;
                    }
                    if (!remoteServerUrl) {
                      setSyncError("Set a remote server URL above first");
                      return;
                    }
                    setSyncLoading(true);
                    setSyncError(null);
                    try {
                      const result = await startSync({
                        remoteUrl: remoteServerUrl,
                        inviteCode: syncInviteCode,
                        encryptionKey: syncEncryptionKey,
                        callerAlias: syncCallerAlias,
                      });
                      setSyncConfirmCode(result.confirmCode);
                      setSyncStep("confirm");
                    } catch (err: any) {
                      setSyncError(err.message || "Failed to start sync");
                    } finally {
                      setSyncLoading(false);
                    }
                  }}
                  disabled={syncLoading || !syncInviteCode || !syncEncryptionKey || !syncCallerAlias}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "var(--accent)",
                    color: "var(--text-on-accent)",
                    padding: "10px 20px",
                    borderRadius: 8,
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: syncLoading ? "not-allowed" : "pointer",
                    transition: "background 0.15s",
                    alignSelf: "flex-start",
                    border: "none",
                  }}
                  onMouseEnter={(e) => !syncLoading && (e.currentTarget.style.background = "var(--accent-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
                >
                  {syncLoading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <ArrowRight size={14} />}
                  {syncLoading ? "Starting..." : "Start Sync"}
                </button>
              </div>
            )}

            {syncStep === "confirm" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div
                  style={{
                    padding: "16px 20px",
                    borderRadius: 8,
                    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                    background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Enter this code into the drawlatch server</div>
                  <div
                    style={{
                      fontSize: 28,
                      fontWeight: 700,
                      fontFamily: "monospace",
                      color: "var(--accent)",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {syncConfirmCode}
                  </div>
                </div>

                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                  Enter the code above into the drawlatch server when it asks for a confirm code, then click <strong>Complete Sync</strong> below.
                </div>

                {syncError && (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      fontSize: 12,
                      lineHeight: 1.5,
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                      background: "var(--danger-bg)",
                      color: "var(--danger)",
                    }}
                  >
                    <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ opacity: 0.85 }}>{syncError}</div>
                  </div>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={async () => {
                      setSyncLoading(true);
                      setSyncError(null);
                      try {
                        const result = await completeSync();
                        setSyncResult(result);
                        setSyncStep("success");
                        // Refresh key aliases
                        getKeyAliases()
                          .then(setKeyAliases)
                          .catch(() => setKeyAliases([]));
                      } catch (err: any) {
                        const msg = err.message || "Failed to complete sync";
                        const errorMessages: Record<string, string> = {
                          NO_ACTIVE_SESSION: "No sync session is active on the remote server. Run `drawlatch sync` first.",
                          CODE_MISMATCH: "Code mismatch — verify the invite and confirm codes.",
                          SESSION_EXPIRED: "Sync session expired. Start a new one on the remote server.",
                          DECRYPTION_FAILED: "Decryption failed — check the encryption key.",
                        };
                        // Try to extract code from error message
                        const codeMatch = msg.match(/:\s*(\w+)$/);
                        const code = codeMatch?.[1];
                        setSyncError(code && errorMessages[code] ? errorMessages[code] : msg);
                      } finally {
                        setSyncLoading(false);
                      }
                    }}
                    disabled={syncLoading}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--accent)",
                      color: "var(--text-on-accent)",
                      padding: "10px 20px",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: syncLoading ? "not-allowed" : "pointer",
                      transition: "background 0.15s",
                      border: "none",
                    }}
                    onMouseEnter={(e) => !syncLoading && (e.currentTarget.style.background = "var(--accent-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
                  >
                    {syncLoading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />}
                    {syncLoading ? "Completing..." : "Complete Sync"}
                  </button>

                  <button
                    onClick={async () => {
                      await cancelSync().catch(() => {});
                      setSyncStep("input");
                      setSyncConfirmCode("");
                      setSyncError(null);
                    }}
                    disabled={syncLoading}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text-muted)",
                      fontSize: 14,
                      cursor: syncLoading ? "not-allowed" : "pointer",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => !syncLoading && (e.currentTarget.style.background = "var(--bg-secondary)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg)")}
                  >
                    <X size={14} />
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {syncStep === "success" && syncResult && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div
                  style={{
                    padding: "14px 16px",
                    borderRadius: 8,
                    border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)",
                    background: "var(--success-bg)",
                    color: "var(--success)",
                    fontSize: 12,
                    lineHeight: 1.6,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                  }}
                >
                  <Check size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Sync Complete</div>
                    <div>
                      Registered as <strong style={{ fontFamily: "monospace" }}>{syncResult.callerAlias}</strong>
                    </div>
                    <div style={{ marginTop: 2 }}>
                      Fingerprint:{" "}
                      <code
                        style={{
                          fontFamily: "monospace",
                          fontSize: 11,
                          background: "color-mix(in srgb, var(--success) 12%, transparent)",
                          padding: "1px 4px",
                          borderRadius: 3,
                        }}
                      >
                        {syncResult.fingerprint}
                      </code>
                    </div>
                    <div style={{ marginTop: 6, opacity: 0.85 }}>
                      The remote server&apos;s public keys have been saved. You can now test the connection above.
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setSyncStep("input");
                    setSyncInviteCode("");
                    setSyncEncryptionKey("");
                    setSyncCallerAlias("");
                    setSyncConfirmCode("");
                    setSyncResult(null);
                    setSyncError(null);
                  }}
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
                    transition: "background 0.15s",
                    alignSelf: "flex-start",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg)")}
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "var(--accent)",
            color: "var(--text-on-accent)",
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
