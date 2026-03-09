import { useEffect, useState } from "react";
import { Info, Server, Cpu, Shield, ExternalLink, Layers, ArrowUpCircle } from "lucide-react";
import { getSystemInfo, getAgentSettings } from "../../api";
import type { SystemInfo } from "../../api";
import type { AgentSettings } from "shared/types/index.js";

/** Compare two semver strings. Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 *  Handles pre-release segments: 1.0.0 > 1.0.0-alpha.1, alpha.10 > alpha.9. */
function compareVersions(a: string, b: string): number {
  const parseVer = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const parts = core.split(".").map(Number);
    return { parts, pre: pre || null };
  };
  const va = parseVer(a);
  const vb = parseVer(b);

  const maxLen = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const pa = va.parts[i] || 0;
    const pb = vb.parts[i] || 0;
    if (pa !== pb) return pa - pb;
  }

  // Same core: no pre-release > pre-release
  if (!va.pre && vb.pre) return 1;
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && !vb.pre) return 0;

  // Both have pre-release: compare segments
  const aParts = va.pre!.split(".");
  const bParts = vb.pre!.split(".");
  const preLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < preLen; i++) {
    const sa = aParts[i];
    const sb = bParts[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = Number(sa);
    const nb = Number(sb);
    const aIsNum = !isNaN(na);
    const bIsNum = !isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
    } else if (aIsNum) {
      return -1; // numbers sort before strings
    } else if (bIsNum) {
      return 1;
    } else {
      if (sa < sb) return -1;
      if (sa > sb) return 1;
    }
  }
  return 0;
}

/** Returns true if remote version is newer than local. */
function isNewerVersion(local: string, remote: string): boolean {
  if (!local || !remote || local === remote) return false;
  return compareVersions(remote, local) > 0;
}

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};

const headerStyle: React.CSSProperties = {
  marginBottom: 6,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 12,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  fontWeight: 500,
};

const valueStyle: React.CSSProperties = {
  color: "var(--text)",
  fontFamily: "monospace",
  fontSize: 12,
};

function InfoRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value || "—"}</span>
    </div>
  );
}

/** Truncate sensitive values showing first N and last N chars with ellipsis */
function truncateSensitive(value: string | undefined, edgeChars = 4): string {
  if (!value) return "—";
  if (value.length <= edgeChars * 2 + 3) return value;
  return `${value.slice(0, edgeChars)}...${value.slice(-edgeChars)}`;
}

export default function AboutSettings() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getSystemInfo(), getAgentSettings()])
      .then(([sys, settings]) => {
        setSystemInfo(sys);
        setAgentSettings(settings);
      })
      .catch(() => {
        // partial data is fine
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>;
  }

  const account = systemInfo?.account;
  const hasUpdate = systemInfo?.version && systemInfo?.latestVersion && isNewerVersion(systemInfo.version, systemInfo.latestVersion);

  return (
    <>
      {/* Update Notice */}
      {hasUpdate && (
        <div
          style={{
            border: "1px solid var(--accent)",
            borderRadius: 8,
            padding: "14px 20px",
            background: "var(--tint-info)",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <ArrowUpCircle size={20} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>Update available</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              v{systemInfo!.version} → v{systemInfo!.latestVersion}
              <span style={{ marginLeft: 8 }}>
                Run:{" "}
                <code style={{ fontSize: 11, background: "var(--surface)", padding: "2px 6px", borderRadius: 4 }}>
                  npm install -g @wolpertingerlabs/callboard
                </code>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Application Info */}
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <Info size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Application</span>
        </div>
        <div style={subtitleStyle}>Callboard version and build information.</div>
        <div>
          <InfoRow label="Version" value={systemInfo?.version} />
          {systemInfo?.latestVersion && <InfoRow label="Latest Version" value={`v${systemInfo.latestVersion}`} />}
          <InfoRow label="Environment" value={systemInfo?.environment} />
          <InfoRow label="Claude CLI" value={systemInfo?.claudeCliVersion} />
          <InfoRow label="Agent SDK" value={systemInfo?.sdkVersion ? `v${systemInfo.sdkVersion}` : undefined} />
        </div>
      </div>

      {/* Account & Auth */}
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <Shield size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Account</span>
        </div>
        <div style={subtitleStyle}>Claude account and authentication details.</div>
        <div>
          <InfoRow label="Email" value={truncateSensitive(account?.email, 4)} />
          <InfoRow label="Organization" value={truncateSensitive(account?.organization, 6)} />
          <InfoRow label="Subscription" value={account?.subscriptionType} />
          <InfoRow label="Token Source" value={account?.tokenSource} />
          {account?.apiKeySource && <InfoRow label="API Key Source" value={truncateSensitive(account.apiKeySource, 4)} />}
        </div>
      </div>

      {/* Supported Models */}
      {systemInfo?.models && systemInfo.models.length > 0 && (
        <div style={sectionStyle}>
          <div style={headerStyle}>
            <Layers size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Supported Models</span>
          </div>
          <div style={subtitleStyle}>Models available for use with your current account.</div>
          <div>
            {systemInfo.models.map((model) => (
              <div key={model.value} style={rowStyle}>
                <div>
                  <span style={{ color: "var(--text)", fontWeight: 500, fontSize: 13 }}>{model.displayName}</span>
                  {model.description && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{model.description}</div>}
                </div>
                <span style={{ ...valueStyle, flexShrink: 0 }}>{model.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Proxy & Connectivity */}
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <Server size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Proxy Configuration</span>
        </div>
        <div style={subtitleStyle}>Current proxy mode and server configuration.</div>
        <div>
          <InfoRow label="Proxy Mode" value={agentSettings?.proxyMode || "local"} />
          {agentSettings?.proxyMode === "remote" && <InfoRow label="Remote Server" value={agentSettings?.remoteServerUrl} />}
          <InfoRow label="Tunnel" value={agentSettings?.tunnelEnabled ? "Enabled" : "Disabled"} />
        </div>
      </div>

      {/* Runtime Environment */}
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <Cpu size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Runtime Environment</span>
        </div>
        <div style={subtitleStyle}>Server runtime and platform details.</div>
        <div>
          <InfoRow label="Node.js" value={systemInfo?.nodeVersion} />
          <InfoRow label="Platform" value={systemInfo?.platform} />
        </div>
      </div>

      {/* Links */}
      <div style={{ textAlign: "center", padding: "8px 0", fontSize: 12, color: "var(--text-muted)" }}>
        <a
          href="https://github.com/WolpertingerLabs/callboard"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <ExternalLink size={12} />
          GitHub
        </a>
        <span style={{ margin: "0 8px" }}>·</span>
        <span>MIT License</span>
      </div>
    </>
  );
}
