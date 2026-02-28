import { X, Hash, Puzzle, Check, Server, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Plugin } from "../types/plugins";
import { getCommandDescription, getCommandCategory } from "../utils/commands";
import { getActivePlugins, setActivePlugins } from "../utils/plugins";
import { toggleAppPlugin, toggleMcpServer, type AppPluginsData, type AppPlugin, type McpServerConfig } from "../api";
import ModalOverlay from "./ModalOverlay";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  slashCommands: string[];
  plugins?: Plugin[];
  appPluginsData?: AppPluginsData | null;
  onCommandSelect?: (command: string) => void;
  onActivePluginsChange?: (activePluginIds: string[]) => void;
  onAppPluginsDataChange?: (data: AppPluginsData) => void;
}

export default function SlashCommandsModal({
  isOpen,
  onClose,
  slashCommands,
  plugins = [],
  appPluginsData,
  onCommandSelect,
  onActivePluginsChange,
  onAppPluginsDataChange,
}: Props) {
  const [activePluginIds, setActivePluginIds] = useState<Set<string>>(() => getActivePlugins());

  // Toggle per-directory plugin activation
  const togglePlugin = (pluginId: string) => {
    const newActiveIds = new Set(activePluginIds);
    if (newActiveIds.has(pluginId)) {
      newActiveIds.delete(pluginId);
    } else {
      newActiveIds.add(pluginId);
    }
    setActivePluginIds(newActiveIds);
    setActivePlugins(newActiveIds);
    onActivePluginsChange?.(Array.from(newActiveIds));
  };

  // Toggle app-wide plugin activation
  const handleToggleAppPlugin = async (pluginId: string, enabled: boolean) => {
    if (!appPluginsData || !onAppPluginsDataChange) return;

    // Optimistic update (cascade: disabling plugin disables its embedded MCP servers)
    const updatedPlugins = appPluginsData.plugins.map((p) => {
      if (p.id !== pluginId) return p;
      const updated = { ...p, enabled };
      if (!enabled && updated.mcpServers) {
        updated.mcpServers = updated.mcpServers.map((s) => ({ ...s, enabled: false }));
      }
      return updated;
    });
    onAppPluginsDataChange({ ...appPluginsData, plugins: updatedPlugins });

    try {
      await toggleAppPlugin(pluginId, enabled);
    } catch {
      // Revert on error
      onAppPluginsDataChange(appPluginsData);
    }
  };

  // Toggle MCP server activation
  const handleToggleMcpServer = async (serverId: string, enabled: boolean) => {
    if (!appPluginsData || !onAppPluginsDataChange) return;

    // Optimistic update — modify servers within their parent plugins
    const updatedPlugins = appPluginsData.plugins.map((p) => ({
      ...p,
      mcpServers: p.mcpServers?.map((s) => (s.id === serverId ? { ...s, enabled } : s)),
    }));
    onAppPluginsDataChange({ ...appPluginsData, plugins: updatedPlugins });

    try {
      await toggleMcpServer(serverId, enabled);
    } catch {
      // Revert on error
      onAppPluginsDataChange(appPluginsData);
    }
  };

  if (!isOpen) return null;

  /** Check if an MCP server has required env vars that are missing */
  const serverHasMissingEnv = (server: McpServerConfig): boolean => {
    if (!server.envDefaults) return false;
    for (const key of Object.keys(server.envDefaults)) {
      const raw = server.envDefaults[key];
      const match = raw.match(/^\$\{([^}:]+)(?::-(.*))?\}$/);
      // Required = has ${VAR} pattern with no :- default
      if (match && match[2] === undefined) {
        const val = server.env?.[key];
        if (!val || val.trim() === "") return true;
      }
    }
    return false;
  };

  /** Check if a plugin has any MCP servers with missing required env */
  const pluginHasMissingEnv = (plugin: AppPlugin): boolean => {
    if (!plugin.mcpServers) return false;
    return plugin.mcpServers.some(serverHasMissingEnv);
  };

  // De-duplicate slash commands
  const uniqueSlashCommands = Array.from(new Set(slashCommands));

  // Group commands by category
  const categorizedCommands = uniqueSlashCommands.reduce(
    (acc, command) => {
      const category = getCommandCategory(command);
      if (!acc[category]) acc[category] = [];
      acc[category].push(command);
      return acc;
    },
    {} as Record<string, string[]>,
  );

  const handleCommandClick = (command: string) => {
    if (onCommandSelect) {
      onCommandSelect(`/${command} `);
    }
    onClose();
  };

  const appPlugins = appPluginsData?.plugins ?? [];
  const mcpServers = appPlugins.flatMap((p) => p.mcpServers ?? []);
  const hasAppPlugins = appPlugins.length > 0;
  const hasMcpServers = mcpServers.length > 0;
  const hasAnyContent = uniqueSlashCommands.length > 0 || plugins.length > 0 || hasAppPlugins || hasMcpServers;

  return (
    <ModalOverlay style={{ padding: "20px" }}>
      <div
        style={{
          backgroundColor: "var(--bg)",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "600px",
          maxHeight: "80vh",
          overflow: "hidden",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          border: "1px solid var(--border)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <Hash size={20} color="var(--accent)" />
            <h2
              style={{
                margin: 0,
                fontSize: "18px",
                fontWeight: 600,
                color: "var(--text)",
              }}
            >
              Slash Commands
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px",
              borderRadius: "4px",
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            padding: "20px 24px 24px",
            overflowY: "auto",
            maxHeight: "calc(80vh - 120px)",
          }}
        >
          {!hasAnyContent ? (
            <div
              style={{
                textAlign: "center" as const,
                color: "var(--text-muted)",
                padding: "40px 20px",
              }}
            >
              <p>No slash commands available yet.</p>
              <p style={{ fontSize: "14px", marginTop: "8px" }}>Commands will appear after sending your first message.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              {/* Slash Commands */}
              {Object.entries(categorizedCommands).map(([category, commands]) => (
                <div key={category}>
                  <h3
                    style={{
                      margin: "0 0 12px 0",
                      fontSize: "14px",
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      textTransform: "uppercase" as const,
                      letterSpacing: "0.05em",
                    }}
                  >
                    {category}
                  </h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {commands.map((command) => (
                      <button
                        key={command}
                        onClick={() => handleCommandClick(command)}
                        style={{
                          background: "transparent",
                          border: "1px solid var(--border)",
                          borderRadius: "8px",
                          padding: "12px 16px",
                          textAlign: "left" as const,
                          cursor: "pointer",
                          transition: "all 0.2s ease",
                          width: "100%",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "var(--accent-bg, rgba(59, 130, 246, 0.1))";
                          e.currentTarget.style.borderColor = "var(--accent)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "transparent";
                          e.currentTarget.style.borderColor = "var(--border)";
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "4px",
                          }}
                        >
                          <code
                            style={{
                              color: "var(--accent)",
                              fontWeight: 600,
                              fontSize: "14px",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            /{command}
                          </code>
                          <p
                            style={{
                              margin: 0,
                              color: "var(--text-muted)",
                              fontSize: "13px",
                              lineHeight: 1.4,
                            }}
                          >
                            {getCommandDescription(command) ?? "No description available"}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Per-Directory Plugins Section */}
          {plugins.length > 0 && (
            <div style={{ marginTop: uniqueSlashCommands.length > 0 ? "32px" : "0" }}>
              <h3
                style={{
                  margin: "0 0 16px 0",
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.05em",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <Puzzle size={16} />
                Plugins ({plugins.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {plugins.map((plugin) => {
                  const isActive = activePluginIds.has(plugin.id);
                  const pluginCommands = plugin.commands.filter(
                    (cmd, i, arr) => arr.findIndex((c) => c.name === cmd.name) === i,
                  );

                  return (
                    <div
                      key={plugin.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "16px",
                        backgroundColor: isActive ? "var(--accent-bg, rgba(59, 130, 246, 0.05))" : "transparent",
                        borderColor: isActive ? "var(--accent)" : "var(--border)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: "12px",
                          marginBottom: "12px",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              marginBottom: "4px",
                            }}
                          >
                            <code
                              style={{
                                color: "var(--accent)",
                                fontWeight: 600,
                                fontSize: "14px",
                                fontFamily: "var(--font-mono)",
                              }}
                            >
                              {plugin.manifest.name}
                            </code>
                          </div>
                          <p
                            style={{
                              margin: 0,
                              color: "var(--text-muted)",
                              fontSize: "13px",
                              lineHeight: 1.4,
                            }}
                          >
                            {plugin.manifest.description}
                          </p>
                        </div>
                        <button
                          onClick={() => togglePlugin(plugin.id)}
                          style={{
                            background: isActive ? "var(--accent)" : "transparent",
                            border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: "6px",
                            padding: "6px 12px",
                            cursor: "pointer",
                            color: isActive ? "white" : "var(--text)",
                            fontSize: "12px",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            transition: "all 0.2s ease",
                          }}
                        >
                          {isActive && <Check size={14} />}
                          {isActive ? "Active" : "Activate"}
                        </button>
                      </div>

                      {/* Show available commands when active */}
                      {isActive && pluginCommands.length > 0 && (
                        <div
                          style={{
                            paddingTop: "12px",
                            borderTop: "1px solid var(--border)",
                          }}
                        >
                          <p
                            style={{
                              margin: "0 0 8px 0",
                              fontSize: "12px",
                              color: "var(--text-muted)",
                              fontWeight: 600,
                            }}
                          >
                            Available Commands:
                          </p>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "6px",
                            }}
                          >
                            {pluginCommands.map((item, index) => (
                              <button
                                key={index}
                                onClick={() => {
                                  if (onCommandSelect) {
                                    onCommandSelect(`/${plugin.manifest.name}:${item.name} `);
                                  }
                                  onClose();
                                }}
                                style={{
                                  background: "var(--bg-secondary)",
                                  border: "1px solid var(--border)",
                                  borderRadius: "4px",
                                  padding: "4px 8px",
                                  fontSize: "11px",
                                  color: "var(--text)",
                                  cursor: "pointer",
                                  fontFamily: "var(--font-mono)",
                                  transition: "all 0.2s ease",
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = "var(--accent-bg, rgba(59, 130, 246, 0.1))";
                                  e.currentTarget.style.borderColor = "var(--accent)";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = "var(--bg-secondary)";
                                  e.currentTarget.style.borderColor = "var(--border)";
                                }}
                              >
                                /{plugin.manifest.name}:{item.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* App-Wide Plugins Section */}
          {hasAppPlugins && (
            <div style={{ marginTop: uniqueSlashCommands.length > 0 || plugins.length > 0 ? "32px" : "0" }}>
              <h3
                style={{
                  margin: "0 0 16px 0",
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.05em",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <Puzzle size={16} />
                App-Wide Plugins ({appPlugins.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {appPlugins.map((plugin: AppPlugin) => {
                  const hasMissingEnv = pluginHasMissingEnv(plugin);
                  const isEnabled = plugin.enabled && !hasMissingEnv;
                  const isDisabledByEnv = plugin.enabled && hasMissingEnv;
                  const pluginCommands = plugin.commands.filter(
                    (cmd, i, arr) => arr.findIndex((c) => c.name === cmd.name) === i,
                  );

                  return (
                    <div
                      key={plugin.id}
                      style={{
                        border: isDisabledByEnv
                          ? "1px solid rgba(220, 53, 69, 0.4)"
                          : "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "16px",
                        backgroundColor: isDisabledByEnv
                          ? "rgba(220, 53, 69, 0.04)"
                          : isEnabled
                            ? "var(--accent-bg, rgba(59, 130, 246, 0.05))"
                            : "transparent",
                        borderColor: isDisabledByEnv
                          ? "rgba(220, 53, 69, 0.4)"
                          : isEnabled
                            ? "var(--accent)"
                            : "var(--border)",
                        opacity: isDisabledByEnv ? 0.7 : 1,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: "12px",
                          marginBottom: (pluginCommands.length > 0 && isEnabled) || isDisabledByEnv ? "12px" : "0",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              marginBottom: "4px",
                            }}
                          >
                            <code
                              style={{
                                color: isDisabledByEnv ? "var(--text-muted)" : "var(--accent)",
                                fontWeight: 600,
                                fontSize: "14px",
                                fontFamily: "var(--font-mono)",
                              }}
                            >
                              {plugin.manifest.name}
                            </code>
                            <span
                              style={{
                                fontSize: "10px",
                                color: "var(--text-muted)",
                                background: "var(--bg-secondary)",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontWeight: 500,
                              }}
                            >
                              app-wide
                            </span>
                          </div>
                          <p
                            style={{
                              margin: 0,
                              color: "var(--text-muted)",
                              fontSize: "13px",
                              lineHeight: 1.4,
                            }}
                          >
                            {plugin.manifest.description}
                          </p>
                        </div>
                        <button
                          onClick={() => !hasMissingEnv && handleToggleAppPlugin(plugin.id, !plugin.enabled)}
                          disabled={hasMissingEnv}
                          style={{
                            background: isDisabledByEnv
                              ? "rgba(220, 53, 69, 0.15)"
                              : isEnabled
                                ? "var(--accent)"
                                : "transparent",
                            border: `1px solid ${isDisabledByEnv ? "rgba(220, 53, 69, 0.4)" : isEnabled ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: "6px",
                            padding: "6px 12px",
                            cursor: hasMissingEnv ? "not-allowed" : "pointer",
                            color: isDisabledByEnv ? "var(--danger, #dc3545)" : isEnabled ? "white" : "var(--text)",
                            fontSize: "12px",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            transition: "all 0.2s ease",
                          }}
                        >
                          {isDisabledByEnv && <AlertTriangle size={14} />}
                          {isEnabled && <Check size={14} />}
                          {isDisabledByEnv ? "Missing Env" : isEnabled ? "Active" : "Activate"}
                        </button>
                      </div>

                      {/* Missing env warning */}
                      {isDisabledByEnv && (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "8px 12px",
                            borderRadius: "6px",
                            background: "rgba(220, 53, 69, 0.08)",
                            border: "1px solid rgba(220, 53, 69, 0.2)",
                            color: "var(--danger, #dc3545)",
                            fontSize: "12px",
                            fontWeight: 500,
                            marginBottom: pluginCommands.length > 0 ? "12px" : "0",
                          }}
                        >
                          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                          <span>
                            MCP server{plugin.mcpServers!.filter(serverHasMissingEnv).length > 1 ? "s" : ""}{" "}
                            <strong>
                              {plugin.mcpServers!
                                .filter(serverHasMissingEnv)
                                .map((s) => s.name)
                                .join(", ")}
                            </strong>{" "}
                            missing required environment variables. Configure in Settings.
                          </span>
                        </div>
                      )}

                      {/* Show available commands when enabled */}
                      {isEnabled && pluginCommands.length > 0 && (
                        <div
                          style={{
                            paddingTop: "12px",
                            borderTop: "1px solid var(--border)",
                          }}
                        >
                          <p
                            style={{
                              margin: "0 0 8px 0",
                              fontSize: "12px",
                              color: "var(--text-muted)",
                              fontWeight: 600,
                            }}
                          >
                            Available Commands:
                          </p>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "6px",
                            }}
                          >
                            {pluginCommands.map((item, index) => (
                              <button
                                key={index}
                                onClick={() => {
                                  if (onCommandSelect) {
                                    onCommandSelect(`/${plugin.manifest.name}:${item.name} `);
                                  }
                                  onClose();
                                }}
                                style={{
                                  background: "var(--bg-secondary)",
                                  border: "1px solid var(--border)",
                                  borderRadius: "4px",
                                  padding: "4px 8px",
                                  fontSize: "11px",
                                  color: "var(--text)",
                                  cursor: "pointer",
                                  fontFamily: "var(--font-mono)",
                                  transition: "all 0.2s ease",
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = "var(--accent-bg, rgba(59, 130, 246, 0.1))";
                                  e.currentTarget.style.borderColor = "var(--accent)";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = "var(--bg-secondary)";
                                  e.currentTarget.style.borderColor = "var(--border)";
                                }}
                              >
                                /{plugin.manifest.name}:{item.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* MCP Servers Section */}
          {hasMcpServers && (
            <div style={{ marginTop: uniqueSlashCommands.length > 0 || plugins.length > 0 || hasAppPlugins ? "32px" : "0" }}>
              <h3
                style={{
                  margin: "0 0 16px 0",
                  fontSize: "14px",
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.05em",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <Server size={16} />
                MCP Servers ({mcpServers.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {mcpServers.map((server: McpServerConfig) => {
                  const hasMissingEnv = serverHasMissingEnv(server);
                  const isEnabled = server.enabled && !hasMissingEnv;
                  const isDisabledByEnv = server.enabled && hasMissingEnv;
                  // Find the source plugin name if available
                  const sourcePlugin = server.sourcePluginId ? appPlugins.find((p) => p.id === server.sourcePluginId) : null;

                  return (
                    <div
                      key={server.id}
                      style={{
                        border: isDisabledByEnv
                          ? "1px solid rgba(220, 53, 69, 0.4)"
                          : "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "16px",
                        backgroundColor: isDisabledByEnv
                          ? "rgba(220, 53, 69, 0.04)"
                          : isEnabled
                            ? "var(--accent-bg, rgba(59, 130, 246, 0.05))"
                            : "transparent",
                        borderColor: isDisabledByEnv
                          ? "rgba(220, 53, 69, 0.4)"
                          : isEnabled
                            ? "var(--accent)"
                            : "var(--border)",
                        opacity: isDisabledByEnv ? 0.7 : 1,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: "12px",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              marginBottom: "4px",
                            }}
                          >
                            <code
                              style={{
                                color: isDisabledByEnv ? "var(--text-muted)" : "var(--accent)",
                                fontWeight: 600,
                                fontSize: "14px",
                                fontFamily: "var(--font-mono)",
                              }}
                            >
                              {server.name}
                            </code>
                            <span
                              style={{
                                fontSize: "10px",
                                color: "var(--text-muted)",
                                background: "var(--bg-secondary)",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontWeight: 500,
                                textTransform: "uppercase" as const,
                              }}
                            >
                              {server.type}
                            </span>
                            {server.env && Object.keys(server.env).length > 0 && !hasMissingEnv && (
                              <span
                                style={{
                                  fontSize: "10px",
                                  color: "var(--text-muted)",
                                  background: "var(--bg-secondary)",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  fontWeight: 500,
                                }}
                              >
                                {Object.keys(server.env).length} env var{Object.keys(server.env).length !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                          {sourcePlugin && (
                            <p
                              style={{
                                margin: 0,
                                color: "var(--text-muted)",
                                fontSize: "12px",
                                lineHeight: 1.4,
                              }}
                            >
                              from plugin: {sourcePlugin.manifest.name}
                            </p>
                          )}
                          {/* Missing env warning */}
                          {isDisabledByEnv && (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                marginTop: "6px",
                                padding: "4px 8px",
                                borderRadius: "4px",
                                background: "rgba(220, 53, 69, 0.08)",
                                color: "var(--danger, #dc3545)",
                                fontSize: "11px",
                                fontWeight: 600,
                              }}
                            >
                              <AlertTriangle size={12} />
                              Missing required env vars — configure in Settings
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => !hasMissingEnv && handleToggleMcpServer(server.id, !server.enabled)}
                          disabled={hasMissingEnv}
                          style={{
                            background: isDisabledByEnv
                              ? "rgba(220, 53, 69, 0.15)"
                              : isEnabled
                                ? "var(--accent)"
                                : "transparent",
                            border: `1px solid ${isDisabledByEnv ? "rgba(220, 53, 69, 0.4)" : isEnabled ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: "6px",
                            padding: "6px 12px",
                            cursor: hasMissingEnv ? "not-allowed" : "pointer",
                            color: isDisabledByEnv ? "var(--danger, #dc3545)" : isEnabled ? "white" : "var(--text)",
                            fontSize: "12px",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            transition: "all 0.2s ease",
                          }}
                        >
                          {isDisabledByEnv && <AlertTriangle size={14} />}
                          {isEnabled && <Check size={14} />}
                          {isDisabledByEnv ? "Missing Env" : isEnabled ? "Active" : "Activate"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid var(--border)",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "12px",
              color: "var(--text-muted)",
              textAlign: "center" as const,
            }}
          >
            Type {'"/"'} in the message input to see autocomplete suggestions
          </p>
        </div>
      </div>
    </ModalOverlay>
  );
}
