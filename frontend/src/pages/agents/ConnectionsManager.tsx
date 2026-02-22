import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
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
} from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { getConnections, setConnectionEnabled } from "../../api";
import type { ConnectionStatus } from "../../api";
import ConfigureConnectionModal from "../../components/ConfigureConnectionModal";

export default function ConnectionsManager() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [localModeActive, setLocalModeActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [configuring, setConfiguring] = useState<ConnectionStatus | null>(null);
  const [togglingAlias, setTogglingAlias] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      const data = await getConnections();
      setConnections(data.templates);
      setLocalModeActive(data.localModeActive);
    } catch {
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const handleToggle = async (alias: string, enabled: boolean) => {
    // Optimistic update
    setTogglingAlias(alias);
    setConnections((prev) =>
      prev.map((c) => (c.alias === alias ? { ...c, enabled } : c)),
    );
    try {
      await setConnectionEnabled(alias, enabled);
    } catch {
      // Revert on failure
      setConnections((prev) =>
        prev.map((c) => (c.alias === alias ? { ...c, enabled: !enabled } : c)),
      );
    } finally {
      setTogglingAlias(null);
    }
  };

  const handleSecretsUpdated = (
    alias: string,
    secretsSet: Record<string, boolean>,
  ) => {
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

  // ── Not configured state ──
  if (!loading && !localModeActive) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <Header isMobile={isMobile} navigate={navigate} />
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: isMobile ? "16px" : "24px 32px",
          }}
        >
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
              <WifiOff
                size={32}
                style={{ marginBottom: 12, opacity: 0.5 }}
              />
              <p style={{ fontWeight: 600, marginBottom: 4 }}>
                Local proxy not configured
              </p>
              <p style={{ fontSize: 12, marginBottom: 16 }}>
                Set proxy mode to &quot;Local&quot; in Agent Settings to manage
                connections.
              </p>
              <button
                onClick={() => navigate("/agents/settings")}
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
                }}
              >
                <Settings size={14} />
                Open Settings
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Header isMobile={isMobile} navigate={navigate} />

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: isMobile ? "16px" : "24px 32px",
        }}
      >
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          {/* Search bar */}
          <div
            style={{
              position: "relative",
              marginBottom: 20,
            }}
          >
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
      </div>

      {/* Configure modal */}
      {configuring && (
        <ConfigureConnectionModal
          connection={configuring}
          onClose={() => setConfiguring(null)}
          onSecretsUpdated={handleSecretsUpdated}
        />
      )}
    </div>
  );
}

// ── Header component ──

function Header({
  isMobile,
  navigate,
}: {
  isMobile: boolean;
  navigate: (path: string) => void;
}) {
  return (
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
        }}
      >
        <ArrowLeft size={20} style={{ color: "var(--text-muted)" }} />
      </button>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Connection Manager</h1>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>
          Enable connections and configure API keys for mcp-secure-proxy
        </p>
      </div>
    </div>
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
        opacity: conn.enabled ? 1 : 0.75,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top row: icon + name + toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: conn.enabled
                ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                : "var(--bg-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Wifi
              size={18}
              style={{
                color: conn.enabled ? "var(--accent)" : "var(--text-muted)",
              }}
            />
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

        {/* Toggle switch */}
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
          <Globe
            size={10}
            style={{ marginRight: 3, verticalAlign: "middle" }}
          />
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
              background:
                "color-mix(in srgb, var(--accent) 10%, transparent)",
              color: "var(--accent)",
              border:
                "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
            }}
          >
            <Radio
              size={10}
              style={{ marginRight: 3, verticalAlign: "middle" }}
            />
            {conn.ingestorType}
          </span>
        )}

        {/* Secret status badge */}
        {requiredTotal > 0 && (
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
            {allRequiredSet ? (
              <Check size={10} />
            ) : (
              <AlertTriangle size={10} />
            )}
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

      {/* Configure button (when enabled) */}
      {conn.enabled && (
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
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "var(--bg-secondary)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "var(--bg)")
          }
        >
          Configure
        </button>
      )}
    </div>
  );
}
