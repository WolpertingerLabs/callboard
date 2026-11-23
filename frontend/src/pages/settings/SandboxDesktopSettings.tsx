import { useCallback, useEffect, useState } from "react";
import { Box, Check, Hammer, Loader2, RefreshCw, X } from "lucide-react";
import { SANDBOX_DESKTOP_BOUNDS, type SandboxDesktopMode, type SandboxDesktopNetwork, type SandboxDesktopStatus } from "shared/types/index.js";
import { buildSandboxDesktopImage, getSandboxDesktopStatus, updateSandboxDesktopSettings } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import { headerStyle, helpStyle, inputStyle, labelStyle, sectionStyle, subtitleStyle } from "./styles";

const primaryButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 13,
  cursor: "pointer",
};
const noticeStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--warning-bg)",
  color: "var(--text)",
  fontSize: 13,
  marginBottom: 12,
};
const errorStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger)",
  fontSize: 13,
  marginBottom: 12,
};
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, padding: "4px 0" };
const codeStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", background: "var(--code-bg)", padding: "1px 4px", borderRadius: 4 };

type ModeChoice = SandboxDesktopMode | "auto";
const MODE_LABELS: Record<ModeChoice, string> = {
  auto: "Automatic",
  managed: "Managed (local Docker)",
  endpoint: "Endpoint (one you run yourself)",
  off: "Off",
};

interface Draft {
  mode: ModeChoice;
  network: SandboxDesktopNetwork;
  cpus: string;
  memoryMb: string;
  maxConcurrent: string;
}

function draftFrom(status: SandboxDesktopStatus): Draft {
  const s = status.settings;
  return {
    mode: s.mode ?? "auto",
    network: s.network ?? "internet",
    cpus: String(s.cpus ?? SANDBOX_DESKTOP_BOUNDS.cpus.default),
    memoryMb: String(s.memoryMb ?? SANDBOX_DESKTOP_BOUNDS.memoryMb.default),
    maxConcurrent: String(s.maxConcurrent ?? SANDBOX_DESKTOP_BOUNDS.maxConcurrent.default),
  };
}

function Diagnostic({ ok, label, children }: { ok: boolean | undefined; label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle} data-testid={`sandbox-diagnostic-${label.toLowerCase()}`}>
      <span
        aria-hidden
        style={{ color: ok === undefined ? "var(--text-muted)" : ok ? "var(--success)" : "var(--danger)", display: "inline-flex", marginTop: 2 }}
      >
        {ok === false ? <X size={14} /> : <Check size={14} />}
      </span>
      <span>
        <strong>{label}:</strong> {children}
      </span>
    </div>
  );
}

/**
 * Settings → Sandbox desktop: where sandbox desktops come from (managed
 * containers on the local Docker, an endpoint you run, or off), their network
 * and limits, diagnostics, and the explicit image build. Reading is open to
 * any signed-in caller; changing needs a session (`canEdit`).
 */
export default function SandboxDesktopSettings() {
  const [status, setStatus] = useState<SandboxDesktopStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (resetDraft: boolean) => {
    try {
      const next = await getSandboxDesktopStatus();
      setStatus(next);
      if (resetDraft) setDraft(draftFrom(next));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Failed to read the sandbox desktop status"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  // Poll while a build runs, so its output and outcome appear without a reload.
  const building = status?.build.state === "running";
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(false), 2000);
    return () => clearInterval(timer);
  }, [building, refresh]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateSandboxDesktopSettings({
        mode: draft.mode === "auto" ? null : draft.mode,
        network: draft.network,
        cpus: Number(draft.cpus),
        memoryMb: Number(draft.memoryMb),
        maxConcurrent: Number(draft.maxConcurrent),
      });
      setStatus(next);
      setDraft(draftFrom(next));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(errorMessage(e, "Failed to save the sandbox desktop settings"));
    } finally {
      setSaving(false);
    }
  };

  const build = async () => {
    setError(null);
    try {
      const state = await buildSandboxDesktopImage();
      setStatus((current) => (current ? { ...current, build: state } : current));
    } catch (e) {
      setError(errorMessage(e, "Failed to start the image build"));
    }
  };

  if (loading)
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)" }}>
        <Loader2 size={16} className="spin" /> Loading sandbox desktop settings…
      </div>
    );
  if (!status || !draft) return <div style={errorStyle}>{error ?? "Sandbox desktop settings are unavailable."}</div>;

  const { diagnostics: d } = status;
  const editable = status.canEdit;
  const { cpus, memoryMb, maxConcurrent } = SANDBOX_DESKTOP_BOUNDS;
  const field = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((current) => (current ? { ...current, [key]: event.target.value } : current));

  return (
    <div style={{ maxWidth: 760 }}>
      <section style={sectionStyle} aria-labelledby="sandbox-desktop-heading">
        <div style={headerStyle}>
          <Box size={16} />
          <h2 id="sandbox-desktop-heading" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
            Sandbox desktop
          </h2>
        </div>
        <p style={subtitleStyle}>
          A disposable Linux desktop in a hardened container, for agent work that should not touch this machine. In managed mode Callboard starts one container
          per session when a chat enables Sandbox desktop, and removes it when the session ends. Each chat still needs Sandbox desktop permission and your
          consent.
        </p>

        {error && (
          <div style={errorStyle} role="alert">
            {error}
          </div>
        )}
        {!editable && (
          <div style={noticeStyle} role="note">
            Read only: changing these settings or building the image needs a signed-in session, not an API key.
          </div>
        )}

        <p style={{ fontSize: 13, margin: "0 0 12px 0" }} data-testid="sandbox-effective-mode">
          In force: <strong>{MODE_LABELS[status.effectiveMode]}</strong>
          {status.automatic ? " (automatic)" : ""}
          {status.hint ? <> — {status.hint}</> : null}
        </p>

        <label style={labelStyle} htmlFor="sandbox-mode">
          Mode
        </label>
        <select id="sandbox-mode" style={inputStyle} value={draft.mode} disabled={!editable} onChange={field("mode")}>
          {(Object.keys(MODE_LABELS) as ModeChoice[]).map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
        <p style={helpStyle}>
          Automatic uses an endpoint when <code style={codeStyle}>CALLBOARD_SANDBOX_DESKTOP_URL</code> is set, and otherwise managed containers once Docker and
          the image are ready. Changing the mode ends any live sandbox session.
        </p>

        <div style={{ marginTop: 16 }}>
          <label style={labelStyle} htmlFor="sandbox-network">
            Network (managed)
          </label>
          <select id="sandbox-network" style={inputStyle} value={draft.network} disabled={!editable} onChange={field("network")}>
            <option value="internet">Internet access</option>
            <option value="none">No internet</option>
          </select>
          <p style={helpStyle}>
            Both keep sandboxes from reaching each other. &ldquo;No internet&rdquo; uses an <code style={codeStyle}>--internal</code> Docker network with no
            route off the bridge. Neither stops a sandbox reaching services on this machine that listen on all interfaces.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 16 }}>
          <div>
            <label style={labelStyle} htmlFor="sandbox-cpus">
              CPUs per sandbox
            </label>
            <input
              id="sandbox-cpus"
              style={inputStyle}
              type="number"
              min={cpus.min}
              max={cpus.max}
              step={0.5}
              value={draft.cpus}
              disabled={!editable}
              onChange={field("cpus")}
            />
            <p style={helpStyle}>
              {cpus.min}–{cpus.max}
            </p>
          </div>
          <div>
            <label style={labelStyle} htmlFor="sandbox-memory">
              Memory per sandbox (MiB)
            </label>
            <input
              id="sandbox-memory"
              style={inputStyle}
              type="number"
              min={memoryMb.min}
              max={memoryMb.max}
              step={256}
              value={draft.memoryMb}
              disabled={!editable}
              onChange={field("memoryMb")}
            />
            <p style={helpStyle}>
              {memoryMb.min}–{memoryMb.max}
            </p>
          </div>
          <div>
            <label style={labelStyle} htmlFor="sandbox-max">
              Sandboxes at once
            </label>
            <input
              id="sandbox-max"
              style={inputStyle}
              type="number"
              min={maxConcurrent.min}
              max={maxConcurrent.max}
              step={1}
              value={draft.maxConcurrent}
              disabled={!editable}
              onChange={field("maxConcurrent")}
            />
            <p style={helpStyle}>
              {maxConcurrent.min}–{maxConcurrent.max}, across all chats
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
          <button style={{ ...primaryButton, opacity: editable && !saving ? 1 : 0.5 }} disabled={!editable || saving} onClick={() => void save()}>
            {saving ? <Loader2 size={14} className="spin" /> : saved ? <Check size={14} /> : null}
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      </section>

      <section style={sectionStyle} aria-labelledby="sandbox-diagnostics-heading">
        <div style={{ ...headerStyle, justifyContent: "space-between" }}>
          <h3 id="sandbox-diagnostics-heading" style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            Diagnostics
          </h3>
          <button style={secondaryButton} onClick={() => void refresh(false)}>
            <RefreshCw size={14} /> Recheck
          </button>
        </div>
        <Diagnostic ok={d.docker.reachable} label="Docker">
          {d.docker.reachable ? `reachable (server ${d.docker.version || "unknown"})` : (d.docker.error ?? "not reachable")}
        </Diagnostic>
        <Diagnostic ok={d.docker.reachable ? d.image.present && d.image.compatible : undefined} label="Image">
          <code style={codeStyle}>{d.image.name}</code>{" "}
          {!d.image.present
            ? "is not built"
            : d.image.compatible
              ? `protocol ${d.image.protocol} (compatible), version ${d.image.version ?? "unknown"}${d.image.version && d.image.version !== d.image.packageVersion ? `; this Callboard ships ${d.image.packageVersion}, so a rebuild is recommended` : ""}`
              : `protocol ${d.image.protocol ?? "unlabelled"}, but this Callboard speaks ${d.image.expectedProtocol}: rebuild it`}
        </Diagnostic>
        <Diagnostic ok={d.docker.reachable ? d.network.state !== "misconfigured" : undefined} label="Network">
          <code style={codeStyle}>{d.network.name}</code> {d.network.internal ? "(internal, no internet)" : "(internet access)"}:{" "}
          {d.network.state === "ok" ? "ready" : d.network.state}
          {d.network.detail ? `. ${d.network.detail}` : ""}
        </Diagnostic>
        <Diagnostic ok={d.running.sessions < d.running.limit} label="Running">
          {d.running.sessions} of {d.running.limit} managed sandbox{d.running.limit === 1 ? "" : "es"}
          {d.running.containers !== undefined ? ` (${d.running.containers} labelled container${d.running.containers === 1 ? "" : "s"} for this Callboard)` : ""}
        </Diagnostic>
        <Diagnostic ok={undefined} label="Endpoint">
          {d.endpoint.configured ? `configured${d.endpoint.url ? ` (${d.endpoint.url})` : ""}` : "not configured"}
        </Diagnostic>
        <p style={helpStyle}>
          Containers are labelled with owner <code style={codeStyle}>{status.owner}</code>, derived from this Callboard&apos;s data directory. Leftovers from a
          crash are removed at startup and every few minutes; containers of another Callboard are never touched.
        </p>
      </section>

      <section style={sectionStyle} aria-labelledby="sandbox-image-heading">
        <h3 id="sandbox-image-heading" style={{ fontSize: 14, fontWeight: 600, margin: "0 0 6px 0" }}>
          Image
        </h3>
        <p style={subtitleStyle}>
          Callboard never builds or downloads the image on its own. Build it once here, or on the service host with{" "}
          <code style={codeStyle}>{status.buildCommand}</code>. A build takes a few minutes and downloads the pinned base image and Debian packages.
        </p>
        <button style={{ ...primaryButton, opacity: editable && !building ? 1 : 0.5 }} disabled={!editable || building} onClick={() => void build()}>
          {building ? <Loader2 size={14} className="spin" /> : <Hammer size={14} />}
          {building ? "Building…" : d.image.present ? "Rebuild image" : "Build image"}
        </button>
        {status.build.state !== "idle" && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: 13, margin: "0 0 6px 0" }} role="status">
              {status.build.state === "running"
                ? "Building…"
                : status.build.state === "succeeded"
                  ? "Build succeeded."
                  : `Build failed${status.build.error ? `: ${status.build.error}` : "."}`}
            </p>
            {status.build.output && (
              <pre
                style={{
                  maxHeight: 220,
                  overflow: "auto",
                  fontSize: 11,
                  background: "var(--code-bg)",
                  color: "var(--text)",
                  padding: 8,
                  borderRadius: 6,
                  whiteSpace: "pre-wrap",
                }}
              >
                {status.build.output.slice(-3000)}
              </pre>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
