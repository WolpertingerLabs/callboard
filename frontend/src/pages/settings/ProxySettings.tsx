import { useState, useEffect, useRef, useCallback } from "react";
import { FolderOpen, Check, Save, KeyRound, Globe, Monitor, Wifi, WifiOff, ShieldAlert, Loader2, X, ExternalLink, Server, Upload, Lock, Trash2 } from "lucide-react";
import {
  getAgentSettings,
  updateAgentSettings,
  getKeyAliases,
  testProxyConnection,
  getDaemonStatus,
  importCallerBundle,
  getEnrolledCallers,
  deleteEnrolledCaller,
} from "../../api";
import type { AgentSettings, KeyAliasInfo, ConnectionTestResult, DaemonStatus, ParsedCallerBundle, EnrolledCaller } from "../../api";

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

/**
 * Parse a `{alias}.drawlatch-caller.json` document into the plaintext fields the
 * import UI confirms. Throws on anything that isn't a v1 caller bundle. The
 * private keys (possibly passphrase-wrapped) are forwarded verbatim in `raw` —
 * never inspected here.
 */
function parseBundle(text: string): ParsedCallerBundle {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("Not a JSON object");
  if (raw.version !== 1) throw new Error("Unsupported bundle version (expected 1)");
  const callerAlias = raw.callerAlias;
  const fingerprint = raw.fingerprint;
  const endpointUrl = raw.endpointUrl;
  const serverKeyFingerprint = raw.serverKeyFingerprint;
  if (typeof callerAlias !== "string" || typeof fingerprint !== "string" || typeof endpointUrl !== "string" || typeof serverKeyFingerprint !== "string") {
    throw new Error("Missing required fields (callerAlias, fingerprint, endpointUrl, serverKeyFingerprint)");
  }
  return {
    version: 1,
    callerAlias,
    fingerprint,
    endpointUrl,
    serverKeyFingerprint,
    encryption: raw.encryption ?? null,
    raw,
  };
}

export default function ProxySettings() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [proxyMode, setProxyMode] = useState<"local" | "remote" | undefined>(undefined);
  const [remoteServerUrl, setRemoteServerUrl] = useState("");
  const [keyAliases, setKeyAliases] = useState<KeyAliasInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  // Import caller bundle state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pasteText, setPasteText] = useState("");
  const [importParsed, setImportParsed] = useState<ParsedCallerBundle | null>(null);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<{ alias: string; fingerprint: string } | null>(null);

  // Daemon status (merged in from the former Connections tab)
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [daemonError, setDaemonError] = useState<string | null>(null);

  // Enrolled callers management panel
  const [enrolledCallers, setEnrolledCallers] = useState<EnrolledCaller[]>([]);
  const [callersError, setCallersError] = useState<string | null>(null);
  const [deletingAlias, setDeletingAlias] = useState<string | null>(null);

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
        setProxyMode(s.proxyMode || undefined);
        setRemoteServerUrl(s.remoteServerUrl || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Load key aliases when proxy mode changes. The backend resolves the config
  // dir for the mode (always the built-in default now), so fetch unconditionally
  // and let it return an empty list when there is nothing to show.
  useEffect(() => {
    if (!settings) return;
    getKeyAliases(proxyMode)
      .then(setKeyAliases)
      .catch(() => setKeyAliases([]));
  }, [settings, proxyMode]);

  // Load enrolled callers (with fingerprints + bound agents) for the panel.
  const loadCallers = useCallback(() => {
    getEnrolledCallers(proxyMode)
      .then((callers) => {
        setEnrolledCallers(callers);
        setCallersError(null);
      })
      .catch((err: Error) => setCallersError(err.message));
  }, [proxyMode]);

  useEffect(() => {
    if (!settings) return;
    loadCallers();
  }, [settings, loadCallers]);

  const handleDeleteCaller = async (alias: string) => {
    if (!window.confirm(`Delete enrolled caller "${alias}"? This removes its keys from this callboard. This cannot be undone.`)) {
      return;
    }
    setDeletingAlias(alias);
    setCallersError(null);
    try {
      await deleteEnrolledCaller(alias, proxyMode);
      loadCallers();
      // Keep the alias picker + enrolled-count badge in sync.
      getKeyAliases(proxyMode)
        .then(setKeyAliases)
        .catch(() => setKeyAliases([]));
      getDaemonStatus()
        .then(setDaemonStatus)
        .catch(() => {});
    } catch (err: any) {
      setCallersError(err.message || "Failed to delete caller");
    } finally {
      setDeletingAlias(null);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateAgentSettings({
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

  const handleTestConnection = async () => {
    if (!remoteServerUrl) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Authenticate the test with a real imported caller (the first usable
      // one); the backend falls back to the first enrolled caller if omitted
      // and reports a clear error when none exist. No hardcoded "default".
      const testAlias = keyAliases.find((ka) => ka.hasSigningPub && ka.hasExchangePub)?.alias;
      const result = await testProxyConnection(remoteServerUrl, testAlias);
      setTestResult(result);
    } catch {
      setTestResult({ status: "unreachable", message: "Failed to reach backend" });
    } finally {
      setTesting(false);
    }
  };

  // ── Import caller bundle ──────────────────────────────────────────

  const loadBundleText = (text: string) => {
    setImportError(null);
    setImportResult(null);
    setImportPassphrase("");
    try {
      setImportParsed(parseBundle(text));
    } catch (err: any) {
      setImportParsed(null);
      setImportError(`Could not read bundle: ${err.message || "invalid JSON"}`);
    }
  };

  const handleBundleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      loadBundleText(await file.text());
    } catch {
      setImportError("Could not read the selected file");
    }
  };

  const resetImport = () => {
    setImportParsed(null);
    setImportPassphrase("");
    setImportError(null);
    setImportResult(null);
    setPasteText("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleConfirmImport = async () => {
    if (!importParsed) return;
    setImportLoading(true);
    setImportError(null);
    try {
      const result = await importCallerBundle(importParsed.raw, importPassphrase || undefined);
      setImportResult({ alias: result.alias, fingerprint: result.fingerprint });
      setKeyAliases(result.aliases);
      loadCallers();
      // Endpoint-from-bundle pinning is disabled for now (see the import-bundle
      // route) — cloudflared endpoints are ephemeral, so the user sets the
      // Server URL manually above. Don't overwrite what they typed.
      // setRemoteServerUrl(result.endpointUrl);
      setImportParsed(null);
      setImportPassphrase("");
      setPasteText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      setImportError(err.message || "Failed to import bundle");
    } finally {
      setImportLoading(false);
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

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 14,
    fontFamily: "monospace",
    boxSizing: "border-box" as const,
  };

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

              {/* Enrolled callers — fingerprint + bound agents + delete */}
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
                  <KeyRound size={13} /> Enrolled callers ({enrolledCallers.length})
                </div>

                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.6 }}>
                  Each caller is a drawlatch credential this callboard holds. The fingerprint identifies the keypair — use it to spot stale callers. A caller
                  can only be deleted once no agents use it.
                </div>

                {callersError && (
                  <div
                    style={{
                      marginBottom: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      fontSize: 12,
                      border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                      background: "var(--danger-bg)",
                      color: "var(--danger)",
                    }}
                  >
                    {callersError}
                  </div>
                )}

                {enrolledCallers.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {enrolledCallers.map((c) => (
                      <div
                        key={c.alias}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 12,
                          padding: "10px 12px",
                          borderRadius: 8,
                          border: "1px solid var(--border)",
                          background: "var(--bg)",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                          <code style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>{c.alias}</code>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", wordBreak: "break-all" }} title={c.fingerprint ?? undefined}>
                            {c.fingerprint ? `fp: ${c.fingerprint}` : "fingerprint unavailable (keys unreadable)"}
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 2 }}>
                            {c.agents.length > 0 ? (
                              <>
                                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Used by:</span>
                                {c.agents.map((a) => (
                                  <span
                                    key={a.alias}
                                    style={{
                                      fontSize: 11,
                                      padding: "2px 8px",
                                      borderRadius: 6,
                                      background: "var(--bg-secondary)",
                                      border: "1px solid var(--border)",
                                      color: "var(--text)",
                                    }}
                                  >
                                    {a.emoji ? `${a.emoji} ` : ""}
                                    {a.name}
                                  </span>
                                ))}
                              </>
                            ) : (
                              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No agents — safe to delete</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteCaller(c.alias)}
                          disabled={!c.canDelete || deletingAlias === c.alias}
                          title={c.canDelete ? "Delete caller" : `In use by ${c.agents.length} agent(s) — reassign them first`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "6px 10px",
                            borderRadius: 8,
                            border: "1px solid var(--border)",
                            background: "var(--bg)",
                            color: c.canDelete ? "var(--danger)" : "var(--text-muted)",
                            fontSize: 12,
                            cursor: c.canDelete && deletingAlias !== c.alias ? "pointer" : "not-allowed",
                            opacity: c.canDelete ? 1 : 0.5,
                            flexShrink: 0,
                          }}
                        >
                          {deletingAlias === c.alias ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={13} />}
                          Delete
                        </button>
                      </div>
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
                  style={{ ...inputStyle, flex: 1 }}
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

        {/* Import caller bundle (remote mode only) */}
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
              <Upload size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Import caller bundle</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
              Issue a caller in drawlatch (Callers page → Issue credentials, or{" "}
              <code style={{ fontFamily: "monospace", background: "var(--bg-secondary)", padding: "1px 5px", borderRadius: 4 }}>drawlatch issue-caller</code>) to
              get a <code style={{ fontFamily: "monospace", background: "var(--bg-secondary)", padding: "1px 5px", borderRadius: 4 }}>.drawlatch-caller.json</code>{" "}
              file, then import it here. callboard pins the server key from the bundle — confirm it before the keys are written. Set the Server URL above
              manually (the bundle&apos;s endpoint is ignored for now, since tunnel URLs are ephemeral).
            </div>

            {/* Success state */}
            {importResult ? (
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
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Bundle imported</div>
                    <div>
                      Caller <strong style={{ fontFamily: "monospace" }}>{importResult.alias}</strong> is ready. Bind it to an agent, then test the connection
                      above.
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
                        {importResult.fingerprint}
                      </code>
                    </div>
                  </div>
                </div>
                {settings?.proxyMode !== "remote" && (
                  <div
                    style={{
                      padding: "12px 14px",
                      borderRadius: 8,
                      border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
                      background: "var(--warning-bg)",
                      color: "var(--warning)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                    }}
                  >
                    <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div>
                      callboard is still in <strong>{settings?.proxyMode ?? "local"}</strong> mode, so agents won&apos;t use this caller yet. Select{" "}
                      <strong>Remote</strong> under Proxy Mode and click <strong>Save</strong> to switch over.
                    </div>
                  </div>
                )}
                <button
                  onClick={resetImport}
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
                    alignSelf: "flex-start",
                  }}
                >
                  Import another
                </button>
              </div>
            ) : importParsed ? (
              /* Confirmation state — show pinned identity before writing */
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div
                  style={{
                    padding: "14px 16px",
                    borderRadius: 8,
                    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                    background: "color-mix(in srgb, var(--accent) 6%, transparent)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {[
                    ["Caller alias", importParsed.callerAlias],
                    ["Fingerprint", importParsed.fingerprint],
                    // Endpoint row hidden for now — the bundle's endpoint is no longer
                    // applied (ephemeral tunnels); the user sets the Server URL manually.
                    // ["Endpoint", importParsed.endpointUrl],
                    ["Server key", importParsed.serverKeyFingerprint],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline" }}>
                      <span style={{ color: "var(--text-muted)", minWidth: 90, flexShrink: 0 }}>{label}</span>
                      <code style={{ fontFamily: "monospace", color: "var(--text)", wordBreak: "break-all" }}>{value}</code>
                    </div>
                  ))}
                </div>

                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                  Confirm the <strong>server key fingerprint</strong> matches the drawlatch server you trust before importing — this pins callboard to that
                  exact server identity. Set the <strong>Server URL</strong> above yourself.
                </div>

                {/* Passphrase prompt for wrapped bundles */}
                {importParsed.encryption != null && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                      <Lock size={12} /> Passphrase
                    </div>
                    <input
                      type="password"
                      value={importPassphrase}
                      onChange={(e) => {
                        setImportPassphrase(e.target.value);
                        setImportError(null);
                      }}
                      placeholder="Passphrase that protects the private keys"
                      autoFocus
                      style={inputStyle}
                    />
                  </div>
                )}

                {importError && (
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
                    <div style={{ opacity: 0.85 }}>{importError}</div>
                  </div>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={handleConfirmImport}
                    disabled={importLoading || (importParsed.encryption != null && !importPassphrase)}
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
                      cursor: importLoading ? "not-allowed" : "pointer",
                      border: "none",
                      opacity: importParsed.encryption != null && !importPassphrase ? 0.6 : 1,
                    }}
                  >
                    {importLoading ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />}
                    {importLoading ? "Importing..." : "Confirm & import"}
                  </button>
                  <button
                    onClick={resetImport}
                    disabled={importLoading}
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
                      cursor: importLoading ? "not-allowed" : "pointer",
                    }}
                  >
                    <X size={14} />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Input state — file picker or paste */
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => handleBundleFile(e.target.files?.[0])}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
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
                    alignSelf: "flex-start",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg)")}
                >
                  <FolderOpen size={16} />
                  Choose bundle file…
                </button>

                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>or paste the bundle JSON:</div>
                <textarea
                  value={pasteText}
                  onChange={(e) => {
                    setPasteText(e.target.value);
                    setImportError(null);
                  }}
                  placeholder='{ "version": 1, "callerAlias": "...", ... }'
                  rows={4}
                  style={{ ...inputStyle, resize: "vertical", fontSize: 12, lineHeight: 1.5 }}
                />
                <button
                  onClick={() => loadBundleText(pasteText)}
                  disabled={!pasteText.trim()}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: pasteText.trim() ? "var(--accent)" : "var(--bg)",
                    color: pasteText.trim() ? "var(--text-on-accent)" : "var(--text-muted)",
                    padding: "10px 20px",
                    borderRadius: 8,
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: pasteText.trim() ? "pointer" : "not-allowed",
                    border: "none",
                    alignSelf: "flex-start",
                  }}
                >
                  Review bundle
                </button>

                {importError && (
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
                    <div style={{ opacity: 0.85 }}>{importError}</div>
                  </div>
                )}
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
    </>
  );
}
