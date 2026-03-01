import { useState, useEffect, useCallback } from "react";
import {
  Wifi,
  WifiOff,
  ExternalLink,
  Search,
  Loader2,
  Settings,
  Radio,
  Globe,
  Check,
  AlertTriangle,
  Plus,
  Trash2,
  Users,
  ChevronDown,
  Cloud,
} from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { getConnections, setConnectionEnabled, createCallerAlias, deleteCallerAlias } from "../../api";
import type { ConnectionStatus, CallerInfo } from "../../api";
import ConfigureConnectionModal from "../../components/ConfigureConnectionModal";

interface ConnectionsSettingsProps {
  onSwitchTab: (tab: string) => void;
}

export default function ConnectionsSettings({ onSwitchTab }: ConnectionsSettingsProps) {
  const isMobile = useIsMobile();
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [callers, setCallers] = useState<CallerInfo[]>([]);
  const [selectedCaller, setSelectedCaller] = useState("default");
  const [localModeActive, setLocalModeActive] = useState(true);
  const [remoteModeActive, setRemoteModeActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [configuring, setConfiguring] = useState<ConnectionStatus | null>(null);
  const [togglingAlias, setTogglingAlias] = useState<string | null>(null);
  const [showCallerMenu, setShowCallerMenu] = useState(false);
  const [showNewCallerInput, setShowNewCallerInput] = useState(false);
  const [newCallerAlias, setNewCallerAlias] = useState("");
  const [newCallerError, setNewCallerError] = useState<string | null>(null);

  const fetchConnections = useCallback(
    async (caller?: string) => {
      try {
        const data = await getConnections(caller || selectedCaller);
        setConnections(data.templates);
        setCallers(data.callers || []);
        setLocalModeActive(data.localModeActive);
        setRemoteModeActive(data.remoteModeActive ?? false);
        // When switching to remote mode for the first time, pick the first available caller
        if (!data.localModeActive && data.remoteModeActive && data.callers?.length > 0 && !caller) {
          setSelectedCaller(data.callers[0].alias);
        }
      } catch {
        setConnections([]);
      } finally {
        setLoading(false);
      }
    },
    [selectedCaller],
  );

  useEffect(() => {
    setLoading(true);
    fetchConnections();
  }, [fetchConnections]);

  const handleCallerChange = (caller: string) => {
    setSelectedCaller(caller);
    setShowCallerMenu(false);
    setLoading(true);
    fetchConnections(caller);
  };

  const handleCreateCaller = async () => {
    if (!newCallerAlias.trim()) return;

    setNewCallerError(null);
    try {
      const { caller } = await createCallerAlias(newCallerAlias.trim());
      setCallers((prev) => [...prev, caller]);
      setSelectedCaller(caller.alias);
      setShowNewCallerInput(false);
      setNewCallerAlias("");
      setShowCallerMenu(false);
      fetchConnections(caller.alias);
    } catch (err: any) {
      setNewCallerError(err.message || "Failed to create caller");
    }
  };

  const handleDeleteCaller = async (alias: string) => {
    if (alias === "default") return;
    try {
      await deleteCallerAlias(alias);
      setCallers((prev) => prev.filter((c) => c.alias !== alias));
      if (selectedCaller === alias) {
        setSelectedCaller("default");
        fetchConnections("default");
      }
    } catch {
      // silently fail
    }
  };

  const handleToggle = async (alias: string, enabled: boolean) => {
    // Optimistic update
    setTogglingAlias(alias);
    setConnections((prev) => prev.map((c) => (c.alias === alias ? { ...c, enabled } : c)));
    try {
      await setConnectionEnabled(alias, enabled, selectedCaller);
    } catch {
      // Revert on failure
      setConnections((prev) => prev.map((c) => (c.alias === alias ? { ...c, enabled: !enabled } : c)));
    } finally {
      setTogglingAlias(null);
    }
  };

  const handleSecretsUpdated = (alias: string, secretsSet: Record<string, boolean>) => {
    setConnections((prev) =>
      prev.map((c) => {
        if (c.alias !== alias) return c;
        const requiredSecretsSet = { ...c.requiredSecretsSet };
        const optionalSecretsSet = { ...c.optionalSecretsSet };
        for (const [key, value] of Object.entries(secretsSet)) {
          if (key in requiredSecretsSet) requiredSecretsSet[key] = value;
          if (key in optionalSecretsSet) optionalSecretsSet[key] = value;
        }
        return { ...c, requiredSecretsSet, optionalSecretsSet };
      }),
    );
  };

  const filtered = connections.filter(
    (c) =>
      !searchQuery ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.alias.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.description?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Sort: enabled first, then alphabetically
  const sorted = [...filtered].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Whether caller management (create/delete) is available (local mode only)
  const canManageCallers = localModeActive && !remoteModeActive;

  // ── Not configured state ──
  if (!loading && !localModeActive && !remoteModeActive) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div
          style={{
            textAlign: "center",
            padding: "48px 20px",
            color: "var(--text-muted)",
            fontSize: 14,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          <WifiOff size={32} style={{ marginBottom: 12, opacity: 0.5 }} />
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Proxy not configured</p>
          <p style={{ fontSize: 12, marginBottom: 16 }}>Set proxy mode in Proxy settings to manage connections.</p>
          <button
            onClick={() => onSwitchTab("proxy")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--accent)",
              color: "#fff",
              padding: "8px 16px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              border: "none",
            }}
          >
            <Settings size={14} />
            Open Proxy Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* Caller selector + search row */}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 20,
            flexWrap: isMobile ? "wrap" : "nowrap",
          }}
        >
          {/* Caller selector dropdown */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              onClick={() => setShowCallerMenu(!showCallerMenu)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 14,
                cursor: "pointer",
                whiteSpace: "nowrap",
                minWidth: 140,
              }}
            >
              <Users size={14} style={{ color: "var(--text-muted)" }} />
              <span style={{ flex: 1, textAlign: "left" }}>{selectedCaller}</span>
              <ChevronDown size={14} style={{ color: "var(--text-muted)" }} />
            </button>

            {/* Dropdown menu */}
            {showCallerMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  minWidth: 220,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                  zIndex: 100,
                  overflow: "hidden",
                }}
              >
                {/* Caller list */}
                {callers.map((caller) => (
                  <div
                    key={caller.alias}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      cursor: "pointer",
                      background: caller.alias === selectedCaller ? "var(--bg-secondary)" : "transparent",
                      transition: "background 0.1s",
                    }}
                    onClick={() => handleCallerChange(caller.alias)}
                    onMouseEnter={(e) => {
                      if (caller.alias !== selectedCaller) {
                        e.currentTarget.style.background = "var(--bg-secondary)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (caller.alias !== selectedCaller) {
                        e.currentTarget.style.background = "transparent";
                      }
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {caller.alias === selectedCaller && <Check size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />}
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: caller.alias === selectedCaller ? 600 : 400,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {caller.alias}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                          }}
                        >
                          {caller.connectionCount} connection
                          {caller.connectionCount !== 1 ? "s" : ""}
                        </div>
                      </div>
                    </div>
                    {canManageCallers && caller.alias !== "default" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteCaller(caller.alias);
                        }}
                        style={{
                          background: "transparent",
                          padding: 4,
                          borderRadius: 4,
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                        title={`Delete "${caller.alias}"`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}

                {/* Divider + new caller input (local mode only) */}
                {canManageCallers && (
                  <>
                    <div
                      style={{
                        height: 1,
                        background: "var(--border)",
                        margin: "4px 0",
                      }}
                    />

                    {/* New caller input */}
                    {showNewCallerInput ? (
                      <div style={{ padding: "8px 12px" }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          <input
                            type="text"
                            placeholder="alias-name"
                            value={newCallerAlias}
                            onChange={(e) => {
                              setNewCallerAlias(e.target.value);
                              setNewCallerError(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleCreateCaller();
                              if (e.key === "Escape") {
                                setShowNewCallerInput(false);
                                setNewCallerAlias("");
                                setNewCallerError(null);
                              }
                            }}
                            autoFocus
                            style={{
                              flex: 1,
                              padding: "6px 8px",
                              borderRadius: 6,
                              border: `1px solid ${newCallerError ? "var(--error)" : "var(--border)"}`,
                              background: "var(--bg)",
                              color: "var(--text)",
                              fontSize: 12,
                              fontFamily: "monospace",
                              outline: "none",
                              minWidth: 0,
                            }}
                          />
                          <button
                            onClick={handleCreateCaller}
                            style={{
                              background: "var(--accent)",
                              color: "#fff",
                              padding: "5px 10px",
                              borderRadius: 6,
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            Add
                          </button>
                        </div>
                        {newCallerError && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--error)",
                              marginTop: 4,
                            }}
                          >
                            {newCallerError}
                          </div>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowNewCallerInput(true);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          width: "100%",
                          padding: "8px 12px",
                          background: "transparent",
                          color: "var(--accent)",
                          fontSize: 13,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <Plus size={14} />
                        New caller alias
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Click-outside handler */}
            {showCallerMenu && (
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 99,
                }}
                onClick={() => {
                  setShowCallerMenu(false);
                  setShowNewCallerInput(false);
                  setNewCallerAlias("");
                  setNewCallerError(null);
                }}
              />
            )}
          </div>

          {/* Search bar */}
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <Search
              size={16}
              style={{
                position: "absolute",
                left: 12,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-muted)",
              }}
            />
            <input
              type="text"
              placeholder="Search connections..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px 10px 36px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div
            style={{
              textAlign: "center",
              padding: "48px 20px",
              color: "var(--text-muted)",
              fontSize: 14,
            }}
          >
            <Loader2
              size={24}
              style={{
                animation: "spin 1s linear infinite",
                marginBottom: 12,
              }}
            />
            <p>Loading connections...</p>
          </div>
        )}

        {/* Connection cards grid */}
        {!loading && sorted.length === 0 && searchQuery && (
          <div
            style={{
              textAlign: "center",
              padding: "48px 20px",
              color: "var(--text-muted)",
              fontSize: 14,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          >
            No connections match &quot;{searchQuery}&quot;
          </div>
        )}

        {!loading && sorted.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
              gap: 12,
            }}
          >
            {sorted.map((conn) => (
              <ConnectionCard
                key={conn.alias}
                connection={conn}
                toggling={togglingAlias === conn.alias}
                onToggle={(enabled) => handleToggle(conn.alias, enabled)}
                onConfigure={() => setConfiguring(conn)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Configure modal */}
      {configuring && (
        <ConfigureConnectionModal
          connection={configuring}
          caller={selectedCaller}
          onClose={() => setConfiguring(null)}
          onSecretsUpdated={handleSecretsUpdated}
        />
      )}
    </>
  );
}

// ── Connection card component ──

function ConnectionCard({
  connection,
  toggling,
  onToggle,
  onConfigure,
}: {
  connection: ConnectionStatus;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const conn = connection;
  const isRemote = conn.source === "remote";

  // Compute secret status
  const requiredTotal = conn.requiredSecrets.length;
  const requiredSet = Object.values(conn.requiredSecretsSet).filter(Boolean).length;
  const allRequiredSet = requiredTotal === 0 || requiredSet === requiredTotal;
  const someRequiredSet = requiredSet > 0 && !allRequiredSet;

  // Status color
  let secretStatusColor = "var(--text-muted)";
  let secretStatusBg = "var(--bg-secondary)";
  let secretStatusText = "No secrets needed";

  if (requiredTotal > 0) {
    if (allRequiredSet) {
      secretStatusColor = "var(--success)";
      secretStatusBg = "color-mix(in srgb, var(--success) 12%, transparent)";
      secretStatusText = "Ready";
    } else if (someRequiredSet) {
      secretStatusColor = "var(--warning)";
      secretStatusBg = "color-mix(in srgb, var(--warning) 12%, transparent)";
      secretStatusText = `${requiredSet}/${requiredTotal} secrets`;
    } else {
      secretStatusColor = "var(--text-muted)";
      secretStatusBg = "var(--bg-secondary)";
      secretStatusText = `${requiredTotal} secret${requiredTotal !== 1 ? "s" : ""} needed`;
    }
  }

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1px solid ${hovered ? "color-mix(in srgb, var(--accent) 40%, var(--border))" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        transition: "border-color 0.15s",
        opacity: conn.enabled || isRemote ? 1 : 0.75,
        overflow: "hidden",
        minWidth: 0,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top row: icon + name + toggle/badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flex: 1,
            minWidth: 0,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: conn.enabled || isRemote ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {isRemote ? (
              <Cloud size={18} style={{ color: "var(--accent)" }} />
            ) : (
              <Wifi
                size={18}
                style={{
                  color: conn.enabled ? "var(--accent)" : "var(--text-muted)",
                }}
              />
            )}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3
              style={{
                fontSize: 14,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {conn.name}
            </h3>
            {conn.description && (
              <p
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {conn.description}
              </p>
            )}
          </div>
        </div>

        {/* Toggle switch (local) or Remote badge */}
        {isRemote ? (
          <span
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 6,
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              color: "var(--accent)",
              fontWeight: 500,
              whiteSpace: "nowrap",
              marginLeft: 10,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Cloud size={10} />
            Remote
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!toggling) onToggle(!conn.enabled);
            }}
            style={{
              width: 40,
              height: 22,
              borderRadius: 11,
              border: "none",
              background: conn.enabled ? "var(--accent)" : "var(--bg-secondary)",
              position: "relative",
              cursor: toggling ? "wait" : "pointer",
              transition: "background 0.2s",
              flexShrink: 0,
              marginLeft: 10,
            }}
            title={conn.enabled ? "Disable connection" : "Enable connection"}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: 3,
                left: conn.enabled ? 21 : 3,
                transition: "left 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }}
            />
          </button>
        )}
      </div>

      {/* Badges row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {/* Endpoint count */}
        <span
          style={{
            fontSize: 11,
            padding: "3px 7px",
            borderRadius: 6,
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            fontFamily: "monospace",
          }}
        >
          <Globe size={10} style={{ marginRight: 3, verticalAlign: "middle" }} />
          {conn.allowedEndpoints.length} endpoint
          {conn.allowedEndpoints.length !== 1 ? "s" : ""}
        </span>

        {/* Ingestor type badge */}
        {conn.hasIngestor && conn.ingestorType && (
          <span
            style={{
              fontSize: 11,
              padding: "3px 7px",
              borderRadius: 6,
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              color: "var(--accent)",
              border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
            }}
          >
            <Radio size={10} style={{ marginRight: 3, verticalAlign: "middle" }} />
            {conn.ingestorType}
          </span>
        )}

        {/* Secret status badge (local mode only — remote has no secret info) */}
        {!isRemote && requiredTotal > 0 && (
          <span
            style={{
              fontSize: 11,
              padding: "3px 7px",
              borderRadius: 6,
              background: secretStatusBg,
              color: secretStatusColor,
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
            }}
          >
            {allRequiredSet ? <Check size={10} /> : <AlertTriangle size={10} />}
            {secretStatusText}
          </span>
        )}

        {/* Docs link */}
        {conn.docsUrl && (
          <a
            href={conn.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              marginLeft: "auto",
              textDecoration: "none",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={10} />
            Docs
          </a>
        )}
      </div>

      {/* Configure button (when enabled and local only) */}
      {conn.enabled && !isRemote && (
        <button
          onClick={onConfigure}
          style={{
            width: "100%",
            padding: "8px 0",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg)")}
        >
          Configure
        </button>
      )}
    </div>
  );
}
