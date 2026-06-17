import { useState, useEffect, useRef } from "react";
import { FolderOpen, Check, Save, KeyRound, Globe, Monitor, Wifi, WifiOff, ShieldAlert, Loader2, X, Upload, Lock } from "lucide-react";
import FolderBrowser from "../../components/FolderBrowser";
import { getAgentSettings, updateAgentSettings, getKeyAliases, testProxyConnection, importCallerBundle } from "../../api";
import type { AgentSettings, KeyAliasInfo, ConnectionTestResult, ParsedCallerBundle } from "../../api";

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

  // Import caller bundle state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pasteText, setPasteText] = useState("");
  const [importParsed, setImportParsed] = useState<ParsedCallerBundle | null>(null);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<{ alias: string; fingerprint: string } | null>(null);

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
      // The backend pinned the bundle's endpoint as the remote server URL.
      setRemoteServerUrl(result.endpointUrl);
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
            subdirectories — in local mode the managed daemon auto-shares the default caller; in remote mode, import a caller bundle below.
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
              style={{ ...inputStyle, flex: 1 }}
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

          {/* Key Aliases section (read-only — callers are auto-shared or imported) */}
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
              Key Aliases ({keyAliases.length})
            </div>

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
                {proxyMode === "remote" && " Import a caller bundle below to add one."}
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
              file, then import it here. callboard pins the endpoint and server key from the bundle — confirm both before the keys are written.
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
                    ["Endpoint", importParsed.endpointUrl],
                    ["Server key", importParsed.serverKeyFingerprint],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline" }}>
                      <span style={{ color: "var(--text-muted)", minWidth: 90, flexShrink: 0 }}>{label}</span>
                      <code style={{ fontFamily: "monospace", color: "var(--text)", wordBreak: "break-all" }}>{value}</code>
                    </div>
                  ))}
                </div>

                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                  Confirm the <strong>endpoint</strong> and <strong>server key fingerprint</strong> match the drawlatch server you trust before importing —
                  this pins callboard to that exact server identity.
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

      <FolderBrowser
        isOpen={showFolderBrowser}
        onClose={() => setShowFolderBrowser(false)}
        onSelect={handleFolderSelect}
        initialPath={displayedConfigDir || "/"}
      />
    </>
  );
}
