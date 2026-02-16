import { X, Hash, Puzzle, Check, Server } from "lucide-react";
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

    // Optimistic update
    const updatedPlugins = appPluginsData.plugins.map((p) => (p.id === pluginId ? { ...p, enabled } : p));
    // If disabling a plugin, also disable its MCP servers
    const updatedMcpServers = !enabled
      ? appPluginsData.mcpServers.map((s) => (s.sourcePluginId === pluginId ? { ...s, enabled: false } : s))
      : appPluginsData.mcpServers;
    onAppPluginsDataChange({ ...appPluginsData, plugins: updatedPlugins, mcpServers: updatedMcpServers });

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

    // Optimistic update
    const updatedMcpServers = appPluginsData.mcpServers.map((s) => (s.id === serverId ? { ...s, enabled } : s));
    onAppPluginsDataChange({ ...appPluginsData, mcpServers: updatedMcpServers });

    try {
      await toggleMcpServer(serverId, enabled);
    } catch {
      // Revert on error
      onAppPluginsDataChange(appPluginsData);
    }
  };

  if (!isOpen) return null;

  // Group commands by category
  const categorizedCommands = slashCommands.reduce(
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
  const mcpServers = appPluginsData?.mcpServers ?? [];
  const hasAppPlugins = appPlugins.length > 0;
  const hasMcpServers = mcpServers.length > 0;
  const hasAnyContent = slashCommands.length > 0 || plugins.length > 0 || hasAppPlugins || hasMcpServers;

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
            <div style={{ marginTop: slashCommands.length > 0 ? "32px" : "0" }}>
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
                  const pluginCommands = plugin.commands;

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
            <div style={{ marginTop: slashCommands.length > 0 || plugins.length > 0 ? "32px" : "0" }}>
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
                  const isEnabled = plugin.enabled;
                  const pluginCommands = plugin.commands;

                  return (
                    <div
                      key={plugin.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "16px",
                        backgroundColor: isEnabled ? "var(--accent-bg, rgba(59, 130, 246, 0.05))" : "transparent",
                        borderColor: isEnabled ? "var(--accent)" : "var(--border)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: "12px",
                          marginBottom: pluginCommands.length > 0 && isEnabled ? "12px" : "0",
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
                          onClick={() => handleToggleAppPlugin(plugin.id, !isEnabled)}
                          style={{
                            background: isEnabled ? "var(--accent)" : "transparent",
                            border: `1px solid ${isEnabled ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: "6px",
                            padding: "6px 12px",
                            cursor: "pointer",
                            color: isEnabled ? "white" : "var(--text)",
                            fontSize: "12px",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            transition: "all 0.2s ease",
                          }}
                        >
                          {isEnabled && <Check size={14} />}
                          {isEnabled ? "Active" : "Activate"}
                        </button>
                      </div>

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
            <div style={{ marginTop: slashCommands.length > 0 || plugins.length > 0 || hasAppPlugins ? "32px" : "0" }}>
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
                  const isEnabled = server.enabled;
                  // Find the source plugin name if available
                  const sourcePlugin = server.sourcePluginId ? appPlugins.find((p) => p.id === server.sourcePluginId) : null;

                  return (
                    <div
                      key={server.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        padding: "16px",
                        backgroundColor: isEnabled ? "var(--accent-bg, rgba(59, 130, 246, 0.05))" : "transparent",
                        borderColor: isEnabled ? "var(--accent)" : "var(--border)",
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
                                color: "var(--accent)",
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
                        </div>
                        <button
                          onClick={() => handleToggleMcpServer(server.id, !isEnabled)}
                          style={{
                            background: isEnabled ? "var(--accent)" : "transparent",
                            border: `1px solid ${isEnabled ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: "6px",
                            padding: "6px 12px",
                            cursor: "pointer",
                            color: isEnabled ? "white" : "var(--text)",
                            fontSize: "12px",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            transition: "all 0.2s ease",
                          }}
                        >
                          {isEnabled && <Check size={14} />}
                          {isEnabled ? "Active" : "Activate"}
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
