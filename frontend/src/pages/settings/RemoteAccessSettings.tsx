import { useState, useEffect } from "react";
import { Globe, ShieldAlert, Loader2, Check } from "lucide-react";
import { getAgentSettings, updateAgentSettings, getCallerIp } from "../../api";
import { errorMessage } from "../../utils/errorMessage";

export default function RemoteAccessSettings() {
  const [loading, setLoading] = useState(true);
  const [ipAllowlist, setIpAllowlist] = useState("");
  // Absent means on. Read as `!== false` on the backend too, so a settings file
  // written before this field existed keeps the documented default rather than
  // silently switching the capability off.
  const [allowEngineInstalls, setAllowEngineInstalls] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [callerIp, setCallerIp] = useState<string | null>(null);

  // ── Load persisted settings ──────────────────────────────────────────
  useEffect(() => {
    getAgentSettings()
      .then((s) => {
        setIpAllowlist((s.remoteAccessIpAllowlist || []).join("\n"));
        setAllowEngineInstalls(s.allowEngineInstalls !== false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    getCallerIp()
      .then(setCallerIp)
      .catch(() => {});
  }, []);

  // ── Persist ───────────────────────────────────────────────────────────
  const persistAllowlist = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateAgentSettings({ remoteAccessIpAllowlist: parseAllowlistInput(ipAllowlist) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(errorMessage(e, "Failed to save settings"));
    } finally {
      setSaving(false);
    }
  };

  const [installsSaving, setInstallsSaving] = useState(false);
  const [installsError, setInstallsError] = useState<string | null>(null);

  /**
   * Persist the one-click-install switch on its own, immediately — a switch
   * nobody flips until they want it to have already taken effect, so it does
   * not wait for the allowlist's **Save** button.
   */
  const persistEngineInstalls = async (next: boolean) => {
    if (installsSaving) return;
    setInstallsSaving(true);
    setInstallsError(null);
    const previous = allowEngineInstalls;
    setAllowEngineInstalls(next);
    try {
      await updateAgentSettings({ allowEngineInstalls: next });
    } catch (e) {
      // Put the switch back rather than leaving the UI showing a state the
      // daemon does not have — this one decides whether a command can run.
      setAllowEngineInstalls(previous);
      setInstallsError(errorMessage(e, "Failed to save"));
    } finally {
      setInstallsSaving(false);
    }
  };

  const addMyIp = () => {
    if (!callerIp) return;
    const lines = parseAllowlistInput(ipAllowlist);
    if (!lines.includes(callerIp)) {
      setIpAllowlist([...lines, callerIp].join("\n"));
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)" }}>
        <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Loading…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 680, display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Heading */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
          <Globe size={18} /> Remote access
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Callboard does not expose itself to the internet. To reach it from another device, put both on a private network
          such as <strong>Tailscale</strong> (or another VPN) and open this server&rsquo;s address and port from there.
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
          Anyone who can reach this port can reach your login page, and your password is what protects your sessions, files,
          and connected services. Use a strong, unique one, and keep the port off the public internet.
        </div>
      </div>

      {/* Generic error */}
      {error && <div style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* IP allowlist */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Allowed IP addresses</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Restrict which remote clients can reach callboard — one IP or CIDR range per line (e.g.{" "}
            <code>100.101.102.103</code>, or <code>100.64.0.0/10</code> and <code>fd7a:115c:a1e0::/48</code> for a whole
            Tailscale network). Leave empty to allow <strong>anyone who can reach this port</strong>. Direct local and LAN
            access is always allowed regardless of this list; Tailscale addresses are not LAN and are checked against it.
          </div>
          <textarea
            value={ipAllowlist}
            onChange={(e) => setIpAllowlist(e.target.value)}
            placeholder={"100.101.102.103\n100.64.0.0/10\nfd7a:115c:a1e0::/48"}
            rows={4}
            spellCheck={false}
            style={{ ...inputStyle, fontFamily: "monospace", resize: "vertical", lineHeight: 1.5 }}
          />
          {callerIp && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>
                Your current IP: <code>{callerIp}</code>
              </span>
              <button
                type="button"
                onClick={addMyIp}
                disabled={parseAllowlistInput(ipAllowlist).includes(callerIp)}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--text)",
                  fontSize: 12,
                  cursor: parseAllowlistInput(ipAllowlist).includes(callerIp) ? "default" : "pointer",
                  opacity: parseAllowlistInput(ipAllowlist).includes(callerIp) ? 0.6 : 1,
                }}
              >
                Add my IP
              </button>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => void persistAllowlist()}
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
              Save allowlist
            </button>
            {saved && <span style={{ color: "var(--success)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 4 }}><Check size={14} /> Saved</span>}
          </div>
        </div>

        {/* ── One-click engine installs ─────────────────────────────────
            Not strictly a remote-access setting — it applies to local clients,
            who are the only ones it can ever apply to — but this is the page an
            operator hardens, and the capability's whole shape is decided by who
            is allowed to reach this server. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>One-click engine installs</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Let <strong>Settings &rarr; API</strong> run an engine&rsquo;s <code>npm install -g</code> on this machine instead of only showing you the
                command. The package comes from a fixed list Callboard ships &mdash; nothing you type reaches a command line, and no shell is involved.
                Clients reaching Callboard from off the LAN or through a proxy (Tailscale included) never get this, whatever this
                switch says &mdash; so this switch governs your own local browsers, not a remote attacker, who is already refused by
                the client check. Turning it off leaves the copy-and-paste command, which is all there ever was before. Saved as soon
                as you flip it.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={allowEngineInstalls}
              aria-label="Allow one-click engine installs"
              onClick={() => void persistEngineInstalls(!allowEngineInstalls)}
              disabled={installsSaving}
              style={{
                position: "relative",
                width: 44,
                height: 24,
                borderRadius: 999,
                border: "none",
                cursor: installsSaving ? "default" : "pointer",
                flexShrink: 0,
                background: allowEngineInstalls ? "var(--accent)" : "var(--border)",
                transition: "background 0.15s",
                opacity: installsSaving ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: allowEngineInstalls ? 22 : 2,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "var(--toggle-knob)",
                  transition: "left 0.15s",
                }}
              />
            </button>
          </div>
          {installsError && <div style={{ color: "var(--danger)", fontSize: 12 }}>{installsError}</div>}
        </div>
      </div>
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

/** Split the allowlist textarea into trimmed, de-duplicated, non-empty entries. */
function parseAllowlistInput(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !seen.has(l) && seen.add(l));
}
