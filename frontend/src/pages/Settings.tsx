import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronDown, ChevronRight, LogOut, FolderSearch, RefreshCw, Trash2, Plug, Server, Plus, Loader2, Eye, EyeOff, Save, AlertTriangle } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import ConfirmModal from "../components/ConfirmModal";
import FolderBrowser from "../components/FolderBrowser";
import { getMaxTurns, saveMaxTurns } from "../utils/localStorage";
import {
  getAppPlugins,
  scanForPlugins,
  rescanPlugins,
  removeScanRoot,
  toggleAppPlugin,
  toggleMcpServer,
  updateMcpServerEnv,
  type AppPluginsData,
  type AppPlugin,
  type McpServerConfig,
} from "../api";

interface SettingsProps {
  onLogout: () => void;
}

export default function Settings({ onLogout }: SettingsProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [maxTurns, setMaxTurns] = useState(() => getMaxTurns());
  const [saved, setSaved] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  // App-wide plugins state
  const [appPluginsData, setAppPluginsData] = useState<AppPluginsData | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [removingRoot, setRemovingRoot] = useState<string | null>(null);

  // Env var editor state
  const [expandedMcpServerId, setExpandedMcpServerId] = useState<string | null>(null);
  const [editingEnv, setEditingEnv] = useState<Record<string, string> | null>(null);
  const [showEnvValues, setShowEnvValues] = useState<Record<string, boolean>>({});
  const [envSaved, setEnvSaved] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);

  // Load app plugins data on mount
  const loadPluginsData = useCallback(async () => {
    try {
      const data = await getAppPlugins();
      setAppPluginsData(data);
    } catch (err) {
      console.error("Failed to load app plugins:", err);
    }
  }, []);

  useEffect(() => {
    loadPluginsData();
  }, [loadPluginsData]);

  const handleSave = () => {
    const clamped = Math.max(1, Math.min(10000, maxTurns || 200));
    saveMaxTurns(clamped);
    setMaxTurns(clamped);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Plugin management handlers
  const handleAddScanRoot = async (directory: string) => {
    setShowFolderBrowser(false);
    setIsScanning(true);
    setScanError(null);
    try {
      await scanForPlugins(directory);
      await loadPluginsData();
    } catch (err: any) {
      setScanError(err.message || "Scan failed");
    } finally {
      setIsScanning(false);
    }
  };

  const handleRemoveScanRoot = async (directory: string) => {
    setRemovingRoot(directory);
    try {
      await removeScanRoot(directory);
      await loadPluginsData();
    } catch (err: any) {
      console.error("Failed to remove scan root:", err);
    } finally {
      setRemovingRoot(null);
    }
  };

  const handleRescan = async (directory?: string) => {
    setIsScanning(true);
    setScanError(null);
    try {
      await rescanPlugins(directory);
      await loadPluginsData();
    } catch (err: any) {
      setScanError(err.message || "Rescan failed");
    } finally {
      setIsScanning(false);
    }
  };

  const handleTogglePlugin = async (pluginId: string, enabled: boolean) => {
    // Optimistic update
    setAppPluginsData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        plugins: prev.plugins.map((p) => {
          if (p.id === pluginId) {
            const updated = { ...p, enabled };
            // Cascade: disabling plugin disables its MCP servers
            if (!enabled && updated.mcpServers) {
              updated.mcpServers = updated.mcpServers.map((s) => ({ ...s, enabled: false }));
            }
            return updated;
          }
          return p;
        }),
      };
    });

    try {
      await toggleAppPlugin(pluginId, enabled);
    } catch (err) {
      console.error("Failed to toggle plugin:", err);
      await loadPluginsData(); // Revert on error
    }
  };

  const handleToggleMcpServer = async (serverId: string, enabled: boolean) => {
    // Optimistic update
    setAppPluginsData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        mcpServers: prev.mcpServers.map((s) => (s.id === serverId ? { ...s, enabled } : s)),
        plugins: prev.plugins.map((p) => ({
          ...p,
          mcpServers: p.mcpServers?.map((s) => (s.id === serverId ? { ...s, enabled } : s)),
        })),
      };
    });

    try {
      await toggleMcpServer(serverId, enabled);
    } catch (err) {
      console.error("Failed to toggle MCP server:", err);
      await loadPluginsData(); // Revert on error
    }
  };

  // Env var editing handlers
  const handleExpandMcpServer = (server: McpServerConfig) => {
    if (expandedMcpServerId === server.id) {
      // Collapse
      setExpandedMcpServerId(null);
      setEditingEnv(null);
      setShowEnvValues({});
      setEnvSaved(false);
    } else {
      // Expand and initialize editing state from server's env
      setExpandedMcpServerId(server.id);
      setEditingEnv({ ...(server.env || {}) });
      setShowEnvValues({});
      setEnvSaved(false);
    }
  };

  const handleSaveEnv = async (serverId: string) => {
    if (!editingEnv) return;
    setEnvSaving(true);
    try {
      await updateMcpServerEnv(serverId, editingEnv);
      // Optimistic update of local state
      setAppPluginsData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          mcpServers: prev.mcpServers.map((s) => (s.id === serverId ? { ...s, env: { ...editingEnv } } : s)),
          plugins: prev.plugins.map((p) => ({
            ...p,
            mcpServers: p.mcpServers?.map((s) => (s.id === serverId ? { ...s, env: { ...editingEnv } } : s)),
          })),
        };
      });
      setEnvSaved(true);
      setTimeout(() => setEnvSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save env vars:", err);
      await loadPluginsData();
    } finally {
      setEnvSaving(false);
    }
  };

  const getEnvDefaultHint = (envDefaults: Record<string, string> | undefined, key: string): string | null => {
    if (!envDefaults || !envDefaults[key]) return null;
    const raw = envDefaults[key];
    const match = raw.match(/^\$\{([^}:]+)(?::-(.*))?\}$/);
    if (match) {
      return match[2] !== undefined ? `default: ${match[2]}` : "required";
    }
    return null;
  };

  const isEnvKeyRequired = (envDefaults: Record<string, string> | undefined, key: string): boolean => {
    if (!envDefaults || !envDefaults[key]) return false;
    const raw = envDefaults[key];
    // Required means ${VAR} with no :- default syntax
    const match = raw.match(/^\$\{([^}:]+)(?::-(.*))?\}$/);
    return !!match && match[2] === undefined;
  };

  /** Returns list of required env keys that have no value set */
  const getMissingRequiredEnvKeys = (server: McpServerConfig): string[] => {
    if (!server.envDefaults) return [];
    const missing: string[] = [];
    for (const key of Object.keys(server.envDefaults)) {
      if (isEnvKeyRequired(server.envDefaults, key)) {
        const val = server.env?.[key];
        if (!val || val.trim() === "") {
          missing.push(key);
        }
      }
    }
    return missing;
  };

  const hasEnvVars = (server: McpServerConfig): boolean => {
    return !!(
      (server.env && Object.keys(server.env).length > 0) ||
      (server.envDefaults && Object.keys(server.envDefaults).length > 0)
    );
  };

  /** Check if value is a ${ENV_VAR} reference for native env pass-through */
  const isEnvReference = (value: string): boolean => {
    return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
  };

  // Collect all MCP servers from all sources
  const allMcpServers: (McpServerConfig & { pluginName?: string })[] = [];
  if (appPluginsData) {
    // From plugins
    for (const plugin of appPluginsData.plugins) {
      if (plugin.mcpServers) {
        for (const server of plugin.mcpServers) {
          allMcpServers.push({ ...server, pluginName: plugin.manifest.name });
        }
      }
    }
    // Standalone
    for (const server of appPluginsData.mcpServers) {
      allMcpServers.push(server);
    }
  }

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

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {/* Max Iterations Section */}
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 20,
            background: "var(--bg)",
            marginBottom: 16,
          }}
        >
          <div style={{ marginBottom: 6 }}>
            <label
              htmlFor="maxTurns"
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text)",
              }}
            >
              Max Iterations
            </label>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginBottom: 10,
            }}
          >
            Maximum number of agent turns per message. The agent will stop after this many iterations. Default is 200.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              id="maxTurns"
              type="number"
              min={1}
              max={10000}
              value={maxTurns}
              onChange={(e) => setMaxTurns(parseInt(e.target.value, 10) || 0)}
              style={{
                flex: 1,
                maxWidth: 200,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 14,
                boxSizing: "border-box",
              }}
            />
            <button
              onClick={handleSave}
              style={{
                background: "var(--accent)",
                color: "#fff",
                padding: "10px 20px",
                borderRadius: 8,
                border: "none",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              {saved ? "Saved!" : "Save"}
            </button>
          </div>
        </div>

        {/* Plugins & MCP Servers Section */}
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 20,
            background: "var(--bg)",
            marginBottom: 16,
          }}
        >
          <div style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
            <Plug size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Plugins & MCP Servers</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
            Configure app-wide plugins and MCP servers available across all agent sessions. Add directories to scan for marketplace plugins.
          </div>

          {/* Error message */}
          {scanError && (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                background: "var(--danger, #dc3545)22",
                color: "var(--danger, #dc3545)",
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              {scanError}
            </div>
          )}

          {/* Scan Directories */}
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "var(--text-muted)",
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <FolderSearch size={14} />
              Scan Directories
            </div>

            {appPluginsData?.scanRoots.map((root) => (
              <div
                key={root.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  marginBottom: 6,
                  background: "var(--surface)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {root.path}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {root.pluginCount} plugin{root.pluginCount !== 1 ? "s" : ""}, {root.mcpServerCount} MCP server
                    {root.mcpServerCount !== 1 ? "s" : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                  <button
                    onClick={() => handleRescan(root.path)}
                    disabled={isScanning}
                    title="Rescan"
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      padding: "4px 6px",
                      cursor: isScanning ? "default" : "pointer",
                      color: "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      opacity: isScanning ? 0.5 : 1,
                    }}
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button
                    onClick={() => handleRemoveScanRoot(root.path)}
                    disabled={removingRoot === root.path}
                    title="Remove"
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      padding: "4px 6px",
                      cursor: removingRoot === root.path ? "default" : "pointer",
                      color: "var(--danger, #dc3545)",
                      display: "flex",
                      alignItems: "center",
                      opacity: removingRoot === root.path ? 0.5 : 1,
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}

            <button
              onClick={() => setShowFolderBrowser(true)}
              disabled={isScanning}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px dashed var(--border)",
                background: "transparent",
                color: "var(--accent)",
                fontSize: 13,
                cursor: isScanning ? "default" : "pointer",
                width: "100%",
                justifyContent: "center",
                opacity: isScanning ? 0.5 : 1,
              }}
            >
              {isScanning ? (
                <>
                  <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                  Scanning...
                </>
              ) : (
                <>
                  <Plus size={14} />
                  Add Directory
                </>
              )}
            </button>
          </div>

          {/* Plugins List */}
          {appPluginsData && appPluginsData.plugins.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--text-muted)",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Plug size={14} />
                Plugins ({appPluginsData.plugins.length})
              </div>

              {appPluginsData.plugins.map((plugin: AppPlugin) => (
                <div
                  key={plugin.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    marginBottom: 4,
                    background: "var(--surface)",
                    opacity: plugin.enabled ? 1 : 0.6,
                  }}
                >
                  {/* Toggle */}
                  <button
                    onClick={() => handleTogglePlugin(plugin.id, !plugin.enabled)}
                    style={{
                      width: 36,
                      height: 20,
                      borderRadius: 10,
                      border: "none",
                      background: plugin.enabled ? "var(--accent)" : "var(--border)",
                      cursor: "pointer",
                      position: "relative",
                      flexShrink: 0,
                      marginRight: 12,
                      transition: "background 0.2s",
                    }}
                  >
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        background: "#fff",
                        position: "absolute",
                        top: 2,
                        left: plugin.enabled ? 18 : 2,
                        transition: "left 0.2s",
                      }}
                    />
                  </button>

                  {/* Plugin info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          fontFamily: "monospace",
                          color: "var(--accent)",
                        }}
                      >
                        {plugin.manifest.name}
                      </span>
                      {plugin.commands.length > 0 && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 5px",
                            borderRadius: 3,
                            background: "var(--border)",
                            color: "var(--text-muted)",
                          }}
                        >
                          {plugin.commands.length} cmd{plugin.commands.length !== 1 ? "s" : ""}
                        </span>
                      )}
                      {plugin.mcpServers && plugin.mcpServers.length > 0 && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 5px",
                            borderRadius: 3,
                            background: "var(--border)",
                            color: "var(--text-muted)",
                          }}
                        >
                          {plugin.mcpServers.length} MCP
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{plugin.manifest.description}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* MCP Servers List */}
          {allMcpServers.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--text-muted)",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Server size={14} />
                MCP Servers ({allMcpServers.length})
              </div>

              {allMcpServers.map((server) => {
                const isExpanded = expandedMcpServerId === server.id;
                const serverHasEnv = hasEnvVars(server);
                const envKeys = Object.keys(server.envDefaults || server.env || {});
                const missingKeys = getMissingRequiredEnvKeys(server);
                const hasMissingEnv = missingKeys.length > 0;

                return (
                  <div
                    key={server.id}
                    style={{
                      borderRadius: 6,
                      border: hasMissingEnv ? "1px solid var(--danger, #dc3545)" : "1px solid var(--border)",
                      marginBottom: 4,
                      background: "var(--surface)",
                      opacity: server.enabled ? 1 : 0.6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        padding: "10px 12px",
                      }}
                    >
                      {/* Toggle */}
                      <button
                        onClick={() => handleToggleMcpServer(server.id, !server.enabled)}
                        style={{
                          width: 36,
                          height: 20,
                          borderRadius: 10,
                          border: "none",
                          background: server.enabled ? "var(--accent)" : "var(--border)",
                          cursor: "pointer",
                          position: "relative",
                          flexShrink: 0,
                          marginRight: 12,
                          transition: "background 0.2s",
                        }}
                      >
                        <div
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            background: "#fff",
                            position: "absolute",
                            top: 2,
                            left: server.enabled ? 18 : 2,
                            transition: "left 0.2s",
                          }}
                        />
                      </button>

                      {/* Server info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              fontFamily: "monospace",
                              color: "var(--text)",
                            }}
                          >
                            {server.name}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: server.type === "stdio" ? "#2d6a4f22" : "#1d3557aa",
                              color: server.type === "stdio" ? "#2d6a4f" : "#a8dadc",
                              fontFamily: "monospace",
                            }}
                          >
                            {server.type}
                          </span>
                          {serverHasEnv && !hasMissingEnv && (
                            <span
                              style={{
                                fontSize: 10,
                                padding: "1px 5px",
                                borderRadius: 3,
                                background: "var(--border)",
                                color: "var(--text-muted)",
                              }}
                            >
                              {envKeys.length} env
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          {server.pluginName && <span>from {server.pluginName}</span>}
                          {!server.pluginName && server.type === "stdio" && server.command && (
                            <span>
                              {server.command} {server.args?.join(" ")}
                            </span>
                          )}
                          {!server.pluginName && server.type !== "stdio" && server.url && <span>{server.url}</span>}
                        </div>

                        {/* Missing env warning */}
                        {hasMissingEnv && !isExpanded && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                              marginTop: 6,
                              padding: "4px 8px",
                              borderRadius: 4,
                              background: "rgba(220, 53, 69, 0.1)",
                              color: "var(--danger, #dc3545)",
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            <AlertTriangle size={12} />
                            Missing {missingKeys.length} required environment variable{missingKeys.length !== 1 ? "s" : ""}
                          </div>
                        )}
                      </div>

                      {/* Expand/collapse chevron for env vars */}
                      {serverHasEnv && (
                        <button
                          onClick={() => handleExpandMcpServer(server)}
                          className={hasMissingEnv && !isExpanded ? "env-pulse" : ""}
                          style={{
                            background: hasMissingEnv && !isExpanded ? "rgba(220, 53, 69, 0.15)" : "none",
                            border: hasMissingEnv && !isExpanded ? "1px solid var(--danger, #dc3545)" : "none",
                            borderRadius: 6,
                            padding: "4px 6px",
                            cursor: "pointer",
                            color: hasMissingEnv && !isExpanded ? "var(--danger, #dc3545)" : "var(--text-muted)",
                            display: "flex",
                            alignItems: "center",
                            flexShrink: 0,
                            marginLeft: 8,
                          }}
                          title={
                            hasMissingEnv
                              ? `Configure ${missingKeys.length} missing env var${missingKeys.length !== 1 ? "s" : ""}`
                              : isExpanded
                                ? "Hide env vars"
                                : "Show env vars"
                          }
                        >
                          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                      )}
                    </div>

                    {/* Expanded env var editor */}
                    {isExpanded && editingEnv && (
                      <div
                        style={{
                          borderTop: hasMissingEnv ? "1px solid var(--danger, #dc3545)" : "1px solid var(--border)",
                          padding: "12px",
                          background: "var(--bg)",
                          borderRadius: "0 0 6px 6px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: "var(--text-muted)",
                            marginBottom: 8,
                            textTransform: "uppercase",
                            letterSpacing: "0.5px",
                          }}
                        >
                          Environment Variables
                        </div>

                        {hasMissingEnv && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "6px 10px",
                              borderRadius: 4,
                              background: "rgba(220, 53, 69, 0.1)",
                              border: "1px solid rgba(220, 53, 69, 0.3)",
                              color: "var(--danger, #dc3545)",
                              fontSize: 11,
                              fontWeight: 600,
                              marginBottom: 10,
                            }}
                          >
                            <AlertTriangle size={14} />
                            Set required variables below before this server can be used
                          </div>
                        )}

                        {envKeys.map((key) => {
                          const hint = getEnvDefaultHint(server.envDefaults, key);
                          const isRequired = isEnvKeyRequired(server.envDefaults, key);
                          const isVisible = showEnvValues[key] || false;
                          const currentVal = editingEnv[key] || "";
                          const isMissing = isRequired && !currentVal.trim();
                          const isRef = isEnvReference(currentVal);

                          return (
                            <div key={key} style={{ marginBottom: 8 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontFamily: "monospace",
                                    fontWeight: 500,
                                    color: isMissing ? "var(--danger, #dc3545)" : "var(--text)",
                                  }}
                                >
                                  {key}
                                </span>
                                {hint && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      color: hint === "required" ? "var(--danger, #dc3545)" : "var(--text-muted)",
                                      fontStyle: "italic",
                                      fontWeight: isMissing ? 600 : 400,
                                    }}
                                  >
                                    {hint}
                                  </span>
                                )}
                                {isRef && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      padding: "1px 5px",
                                      borderRadius: 3,
                                      background: "#2d6a4f22",
                                      color: "#2d6a4f",
                                      fontFamily: "monospace",
                                    }}
                                  >
                                    from env
                                  </span>
                                )}
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                <input
                                  type={isVisible ? "text" : "password"}
                                  value={currentVal}
                                  onChange={(e) => {
                                    setEditingEnv((prev) => (prev ? { ...prev, [key]: e.target.value } : prev));
                                    setEnvSaved(false);
                                  }}
                                  placeholder={hint === "required" ? "Required" : hint?.replace("default: ", "") || ""}
                                  style={{
                                    flex: 1,
                                    padding: "6px 8px",
                                    borderRadius: 4,
                                    border: isMissing ? "1px solid var(--danger, #dc3545)" : "1px solid var(--border)",
                                    background: isMissing ? "rgba(220, 53, 69, 0.05)" : "var(--surface)",
                                    color: "var(--text)",
                                    fontSize: 12,
                                    fontFamily: "monospace",
                                    boxSizing: "border-box",
                                  }}
                                />
                                <button
                                  onClick={() => {
                                    const envVarName = `\${${key}}`;
                                    setEditingEnv((prev) => (prev ? { ...prev, [key]: envVarName } : prev));
                                    setEnvSaved(false);
                                  }}
                                  style={{
                                    background: isRef ? "#2d6a4f22" : "none",
                                    border: isRef ? "1px solid #2d6a4f" : "1px solid var(--border)",
                                    borderRadius: 4,
                                    padding: "5px 6px",
                                    cursor: "pointer",
                                    color: isRef ? "#2d6a4f" : "var(--text-muted)",
                                    display: "flex",
                                    alignItems: "center",
                                    fontSize: 10,
                                    fontFamily: "monospace",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={`Use $\{${key}} to pull from system environment`}
                                >
                                  ${"{"}ENV{"}"}
                                </button>
                                <button
                                  onClick={() =>
                                    setShowEnvValues((prev) => ({
                                      ...prev,
                                      [key]: !prev[key],
                                    }))
                                  }
                                  style={{
                                    background: "none",
                                    border: "1px solid var(--border)",
                                    borderRadius: 4,
                                    padding: "5px 6px",
                                    cursor: "pointer",
                                    color: "var(--text-muted)",
                                    display: "flex",
                                    alignItems: "center",
                                  }}
                                  title={isVisible ? "Hide value" : "Show value"}
                                >
                                  {isVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                                </button>
                              </div>
                            </div>
                          );
                        })}

                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                          <button
                            onClick={() => handleSaveEnv(server.id)}
                            disabled={envSaving}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                              padding: "5px 12px",
                              borderRadius: 4,
                              border: "none",
                              background: envSaved ? "#2d6a4f" : "var(--accent)",
                              color: "#fff",
                              fontSize: 12,
                              cursor: envSaving ? "default" : "pointer",
                              opacity: envSaving ? 0.7 : 1,
                            }}
                          >
                            <Save size={12} />
                            {envSaving ? "Saving..." : envSaved ? "Saved!" : "Save"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Empty state */}
          {appPluginsData && appPluginsData.plugins.length === 0 && allMcpServers.length === 0 && appPluginsData.scanRoots.length === 0 && (
            <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, padding: "12px 0" }}>
              No plugin directories configured. Add a directory to scan for marketplace plugins.
            </div>
          )}

          {/* Rescan All button (when there are roots) */}
          {appPluginsData && appPluginsData.scanRoots.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <button
                onClick={() => handleRescan()}
                disabled={isScanning}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  cursor: isScanning ? "default" : "pointer",
                  opacity: isScanning ? 0.5 : 1,
                }}
              >
                <RefreshCw size={12} />
                Rescan All
              </button>
            </div>
          )}
        </div>

        {/* Account / Logout Section */}
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 20,
            background: "var(--bg)",
            marginTop: 32,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
              marginBottom: 6,
            }}
          >
            Account
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginBottom: 12,
            }}
          >
            Log out of your current session.
          </div>
          <button
            onClick={() => setLogoutConfirmOpen(true)}
            style={{
              background: "var(--danger, #dc3545)",
              color: "#fff",
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </div>

      {/* Logout Confirm Modal */}
      <ConfirmModal
        isOpen={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          onLogout();
        }}
        title="Logout"
        message="Are you sure you want to log out?"
        confirmText="Logout"
        confirmStyle="danger"
      />

      {/* Folder Browser for adding scan roots */}
      <FolderBrowser isOpen={showFolderBrowser} onClose={() => setShowFolderBrowser(false)} onSelect={handleAddScanRoot} />

      {/* CSS for spinner and pulse animations */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes env-pulse-anim {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.4); }
          50% { opacity: 0.85; box-shadow: 0 0 0 4px rgba(220, 53, 69, 0); }
        }
        .env-pulse {
          animation: env-pulse-anim 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
