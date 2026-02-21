import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { Wifi, WifiOff, ExternalLink, Info, Loader2, AlertTriangle } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { getProxyRoutes } from "../../../api";
import type { ProxyRoute, AgentConfig } from "../../../api";

// Connections are managed by mcp-secure-proxy, not by claude-code-ui.
// This page fetches live route data from the proxy via GET /api/proxy/routes.

export default function Connections() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [routes, setRoutes] = useState<ProxyRoute[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasKeys = agent.mcpKeyAliases && agent.mcpKeyAliases.length > 0;

  useEffect(() => {
    if (!hasKeys) return;
    getProxyRoutes()
      .then((data) => {
        setRoutes(data.routes);
        setConfigured(data.configured);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [hasKeys]);

  // Guard: no key aliases assigned
  if (!hasKeys) {
    return (
      <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Connections</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>External services available via mcp-secure-proxy</p>
        </div>
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
          <p style={{ fontWeight: 600, marginBottom: 4 }}>No proxy key assigned</p>
          <p style={{ fontSize: 12 }}>Assign an MCP key alias to this agent in the Overview tab to enable connections.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Connections</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>External services available via mcp-secure-proxy</p>
      </div>

      {/* Info banner */}
      <div
        style={{
          background: "color-mix(in srgb, var(--accent) 8%, transparent)",
          border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
          borderRadius: "var(--radius)",
          padding: "14px 18px",
          marginBottom: 20,
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}
      >
        <Info size={18} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-muted)" }}>
          Connections are configured in{" "}
          <code style={{ fontFamily: "monospace", background: "var(--bg-secondary)", padding: "1px 5px", borderRadius: 4 }}>mcp-secure-proxy</code>&apos;s{" "}
          <code style={{ fontFamily: "monospace", background: "var(--bg-secondary)", padding: "1px 5px", borderRadius: 4 }}>remote.config.json</code>. The proxy
          manages authentication, secrets, and event ingestion. Agents access these services via MCP tools during sessions.
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
          <Loader2 size={24} style={{ animation: "spin 1s linear infinite", marginBottom: 12 }} />
          <p>Loading connections from proxy...</p>
        </div>
      )}

      {/* Not configured state */}
      {!loading && !configured && (
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
          <p style={{ fontSize: 12 }}>mcp-secure-proxy keys were not found. Set up the proxy to enable external connections.</p>
        </div>
      )}

      {/* Error state */}
      {!loading && error && configured && (
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
          <AlertTriangle size={32} style={{ marginBottom: 12, color: "var(--warning)", opacity: 0.7 }} />
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Could not reach proxy</p>
          <p style={{ fontSize: 12 }}>{error}</p>
        </div>
      )}

      {/* Connection cards */}
      {!loading && !error && configured && routes.length === 0 && (
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
          No routes configured in the proxy.
        </div>
      )}

      {!loading && !error && routes.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
            gap: 12,
          }}
        >
          {routes.map((route) => (
            <div
              key={route.index}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "16px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Wifi size={18} style={{ color: "var(--accent)" }} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: 15, fontWeight: 600 }}>{route.name || `Route ${route.index}`}</h3>
                    {route.description && (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          display: "block",
                          marginTop: 1,
                        }}
                      >
                        {route.description}
                      </span>
                    )}
                  </div>
                </div>
                {route.docsUrl && (
                  <a href={route.docsUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)" }}>
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                <span style={{ fontFamily: "monospace", fontSize: 11, background: "var(--bg-secondary)", padding: "1px 5px", borderRadius: 4 }}>
                  {route.allowedEndpoints.length} endpoint{route.allowedEndpoints.length !== 1 ? "s" : ""}
                </span>
                {route.secretNames.length > 0 && (
                  <span
                    style={{ fontFamily: "monospace", fontSize: 11, background: "var(--bg-secondary)", padding: "1px 5px", borderRadius: 4, marginLeft: 6 }}
                  >
                    {route.secretNames.length} secret{route.secretNames.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
