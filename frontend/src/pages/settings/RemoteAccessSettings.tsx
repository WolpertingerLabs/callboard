import { useState, useEffect, useRef, useCallback } from "react";
import { Globe, ShieldAlert, Loader2, Check, Copy, ExternalLink, AlertTriangle, X } from "lucide-react";
import { getAgentSettings, updateAgentSettings, getRemoteAccessStatus } from "../../api";
import type { RemoteAccessStatus } from "../../api";

const CLOUDFLARED_INSTALL_URL = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

type Mode = "quick" | "named";

export default function RemoteAccessSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<Mode>("quick");
  const [token, setToken] = useState("");
  const [hostname, setHostname] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [copied, setCopied] = useState(false);

  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load persisted settings ──────────────────────────────────────────
  useEffect(() => {
    getAgentSettings()
      .then((s) => {
        setEnabled(!!s.remoteAccessEnabled);
        setMode(s.remoteAccessMode === "named" ? "named" : "quick");
        setToken(s.cloudflaredToken || "");
        setHostname(s.remoteAccessHostname || "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── Poll live tunnel status ───────────────────────────────────────────
  const refreshStatus = useCallback(() => {
    getRemoteAccessStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    pollRef.current = setInterval(refreshStatus, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshStatus]);

  // ── Persist + apply ───────────────────────────────────────────────────
  const persist = async (nextEnabled: boolean) => {
    setSaving(true);
    setError(null);
    setNeedsPassword(false);
    setSaved(false);
    try {
      await updateAgentSettings({
        remoteAccessEnabled: nextEnabled,
        remoteAccessMode: mode,
        cloudflaredToken: token,
        remoteAccessHostname: hostname,
      });
      setEnabled(nextEnabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Give the backend a beat to spawn/kill cloudflared, then refresh.
      setTimeout(refreshStatus, 600);
    } catch (e: any) {
      const msg = e?.message || "Failed to save settings";
      setError(msg);
      // The backend blocks enabling without a password — surface that distinctly.
      if (/password/i.test(msg)) setNeedsPassword(true);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = () => {
    if (saving) return;
    if (!enabled) {
      // Turning ON — confirm the global-exposure warning first.
      setShowWarning(true);
    } else {
      void persist(false);
    }
  };

  const confirmEnable = () => {
    setShowWarning(false);
    void persist(true);
  };

  const handleCopy = (url: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)" }}>
        <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Loading…
      </div>
    );
  }

  const cloudflaredMissing = status?.available === false;

  return (
    <div style={{ maxWidth: 680, display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Heading */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
          <Globe size={18} /> Remote access
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Expose this callboard to the public internet through a Cloudflare tunnel so you can reach it from outside your
          local network. Off by default.
        </p>
      </div>

      {/* Persistent security warning */}
      <div
        style={{
          display: "flex",
          gap: 10,
          padding: "12px 14px",
          borderRadius: 8,
          background: "var(--warning-bg)",
          border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)",
          color: "var(--text)",
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
      >
        <ShieldAlert size={18} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 1 }} />
        <div>
          When enabled, <strong>anyone with the URL can reach your login page</strong>. Your password is the only barrier
          to your sessions, files, and connected services — make sure it is strong and unique.
        </div>
      </div>

      {/* Master toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>Enable remote access</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Starts a cloudflared tunnel pointed at this server.</div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={handleToggle}
          disabled={saving}
          style={{
            position: "relative",
            width: 44,
            height: 24,
            borderRadius: 999,
            border: "none",
            cursor: saving ? "default" : "pointer",
            flexShrink: 0,
            background: enabled ? "var(--accent)" : "var(--border)",
            transition: "background 0.15s",
            opacity: saving ? 0.6 : 1,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: enabled ? 22 : 2,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "var(--toggle-knob)",
              transition: "left 0.15s",
            }}
          />
        </button>
      </div>

      {/* No-password error */}
      {needsPassword && (
        <div
          style={{
            display: "flex",
            gap: 10,
            padding: "12px 14px",
            borderRadius: 8,
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-border)",
            color: "var(--text)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <AlertTriangle size={18} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 1 }} />
          <div>
            No login password is set. Set one in the <strong>Account</strong> tab before enabling remote access.
          </div>
        </div>
      )}

      {/* Generic error */}
      {error && !needsPassword && (
        <div style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</div>
      )}

      {/* Mode + config */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Tunnel type</div>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="radio" name="ra-mode" checked={mode === "quick"} onChange={() => setMode("quick")} style={{ marginTop: 3 }} />
          <div>
            <div style={{ fontSize: 13, color: "var(--text)" }}>Quick tunnel</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Free, no Cloudflare account. Gets a random <code>*.trycloudflare.com</code> URL that changes each restart.
            </div>
          </div>
        </label>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="radio" name="ra-mode" checked={mode === "named"} onChange={() => setMode("named")} style={{ marginTop: 3 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: "var(--text)" }}>Named tunnel</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Stable hostname via a token from the Cloudflare Zero Trust dashboard. Create a tunnel there, route your
              hostname to <code>http://localhost:8000</code>, then paste the token below.
            </div>
          </div>
        </label>

        {mode === "named" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 28 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Cloudflare tunnel token</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="eyJ…"
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Public hostname</span>
              <input
                type="text"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="callboard.example.com"
                style={inputStyle}
              />
            </label>
          </div>
        )}

        {/* Apply button (re-spawns the tunnel with the latest config when enabled) */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => void persist(enabled)}
            disabled={saving}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 14px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
              cursor: saving ? "default" : "pointer",
            }}
          >
            {saving ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />}
            {enabled ? "Save & apply" : "Save"}
          </button>
          {saved && <span style={{ color: "var(--success)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 4 }}><Check size={14} /> Saved</span>}
        </div>
      </div>

      {/* Live status panel */}
      <div
        style={{
          padding: "14px 16px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bg-secondary)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusDot status={status?.status} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{statusLabel(status?.status)}</span>
        </div>

        {status?.url && status.status === "up" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <a
              href={status.url}
              target="_blank"
              rel="noreferrer"
              style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--accent)", fontSize: 13, textDecoration: "none", wordBreak: "break-all" }}
            >
              {status.url} <ExternalLink size={13} />
            </a>
            <button
              onClick={() => handleCopy(status.url!)}
              title="Copy URL"
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}

        {status?.error && (
          <div style={{ fontSize: 12.5, color: "var(--danger)", lineHeight: 1.5 }}>{status.error}</div>
        )}

        {cloudflaredMissing && (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
            The <code>cloudflared</code> binary is not installed.{" "}
            <a href={CLOUDFLARED_INSTALL_URL} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              Install it
            </a>{" "}
            and try again.
          </div>
        )}
      </div>

      {/* Enable confirmation modal */}
      {showWarning && (
        <div
          onClick={() => setShowWarning(false)}
          style={{ position: "fixed", inset: 0, background: "var(--overlay-bg)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, maxWidth: 440, width: "100%", display: "flex", flexDirection: "column", gap: 14 }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
                <ShieldAlert size={18} style={{ color: "var(--warning)" }} /> Make callboard public?
              </div>
              <button onClick={() => setShowWarning(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", display: "flex" }}>
                <X size={18} />
              </button>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55 }}>
              This starts a Cloudflare tunnel that makes callboard reachable from the public internet. Anyone who learns
              the URL will see your login page, and your <strong>password is the only thing protecting your data</strong>.
              Make sure it is strong before continuing.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setShowWarning(false)}
                style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 13, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={confirmEnable}
                style={{ padding: "8px 14px", borderRadius: 7, border: "none", background: "var(--accent)", color: "var(--text-on-accent)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
              >
                Enable remote access
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "inherit",
};

function statusLabel(s?: RemoteAccessStatus["status"]): string {
  switch (s) {
    case "up":
      return "Tunnel active";
    case "starting":
      return "Starting tunnel…";
    case "error":
      return "Tunnel error";
    default:
      return "Tunnel inactive";
  }
}

function StatusDot({ status }: { status?: RemoteAccessStatus["status"] }) {
  const color =
    status === "up" ? "var(--success)" : status === "starting" ? "var(--warning)" : status === "error" ? "var(--danger)" : "var(--text-muted)";
  return <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}
