import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, LogOut, FolderSearch, RefreshCw, Trash2, Plug, Server, Plus, Loader2 } from "lucide-react";
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

              {allMcpServers.map((server) => (
                <div
                  key={server.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    marginBottom: 4,
                    background: "var(--surface)",
                    opacity: server.enabled ? 1 : 0.6,
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
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
                  </div>
                </div>
              ))}
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

      {/* CSS for spinner animation */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
