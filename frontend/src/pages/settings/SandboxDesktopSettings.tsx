import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Box, Check, Hammer, Layers, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import {
  SANDBOX_DESKTOP_BOUNDS,
  SANDBOX_PROFILE_BUILD_COMMAND,
  type SandboxDesktopBuild,
  type SandboxDesktopMode,
  type SandboxDesktopNetwork,
  type SandboxDesktopStatus,
  type SandboxProfileStatus,
} from "shared/types/index.js";
import {
  buildSandboxDesktopImage,
  cancelSandboxBuild,
  getSandboxBuild,
  getSandboxDesktopStatus,
  removeSandboxProfile,
  updateSandboxDesktopSettings,
} from "../../api";
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
  keepHours: string;
  maxKept: string;
  deliverablesGb: string;
  profileMaxCpus: string;
  profileMaxMemoryMb: string;
  profileMaxHomeMb: string;
  profileMaxSessionMinutes: string;
}

function draftFrom(status: SandboxDesktopStatus): Draft {
  const s = status.settings;
  return {
    mode: s.mode ?? "auto",
    network: s.network ?? "internet",
    cpus: String(s.cpus ?? SANDBOX_DESKTOP_BOUNDS.cpus.default),
    memoryMb: String(s.memoryMb ?? SANDBOX_DESKTOP_BOUNDS.memoryMb.default),
    maxConcurrent: String(s.maxConcurrent ?? SANDBOX_DESKTOP_BOUNDS.maxConcurrent.default),
    keepHours: String(s.keepHours ?? SANDBOX_DESKTOP_BOUNDS.keepHours.default),
    maxKept: String(s.maxKept ?? SANDBOX_DESKTOP_BOUNDS.maxKept.default),
    deliverablesGb: String(s.deliverablesGb ?? SANDBOX_DESKTOP_BOUNDS.deliverablesGb.default),
    profileMaxCpus: String(s.profileMaxCpus ?? SANDBOX_DESKTOP_BOUNDS.profileMaxCpus.default),
    profileMaxMemoryMb: String(s.profileMaxMemoryMb ?? SANDBOX_DESKTOP_BOUNDS.profileMaxMemoryMb.default),
    profileMaxHomeMb: String(s.profileMaxHomeMb ?? SANDBOX_DESKTOP_BOUNDS.profileMaxHomeMb.default),
    profileMaxSessionMinutes: String(s.profileMaxSessionMinutes ?? SANDBOX_DESKTOP_BOUNDS.profileMaxSessionMinutes.default),
  };
}

const PROFILE_STATE_LABELS: Record<string, string> = {
  missing: "Not built",
  current: "Up to date",
  outdated: "Out of date",
  "rebuild-required": "Refused: recipe changed",
  unlabelled: "Refused: unlabelled",
  insecure: "Refused: rebuild",
  incompatible: "Refused: rebuild",
};
function profileStateColor(state: string): string {
  return state === "current" ? "var(--success)" : state === "outdated" ? "var(--warning)" : state === "missing" ? "var(--text-muted)" : "var(--danger)";
}
const formatMb = (mb: number) => (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GiB` : `${mb} MiB`);

const recipePreStyle: React.CSSProperties = {
  maxHeight: 240,
  overflow: "auto",
  fontSize: 11,
  background: "var(--code-bg)",
  color: "var(--text)",
  padding: 8,
  borderRadius: 6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  margin: "4px 0",
};

/** The output of the build in progress (or the last one), with its outcome. */
function BuildLog({ build, label }: { build: SandboxDesktopBuild; label: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 13, margin: "0 0 6px 0" }} role="status">
        {build.state === "running"
          ? `Building ${label}…`
          : build.state === "succeeded"
            ? `Built ${label}.`
            : `Building ${label} failed${build.error ? `: ${build.error}` : "."}`}
      </p>
      {build.phase === "queued" && <p style={{ ...helpStyle, margin: "0 0 6px 0" }}>Queued: builds run one at a time, in the order asked.</p>}
      {build.output && (
        <pre
          data-testid="sandbox-build-log"
          style={{
            maxHeight: 220,
            overflow: "auto",
            fontSize: 11,
            background: "var(--code-bg)",
            color: "var(--text)",
            padding: 8,
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {build.output.slice(-3000)}
        </pre>
      )}
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};
const isActive = (build: SandboxDesktopBuild) => build.phase === "queued" || build.phase === "running" || (!build.phase && build.state === "running");
const buildLabel = (build: SandboxDesktopBuild) =>
  build.kind === "profile" || build.profile ? `profile ${build.profileId ?? build.profile}` : "the base image";

/** Recent builds, newest first: each with its phase, its log on request, and Cancel while it is queued or running. */
function BuildList({ builds, editable, onChanged }: { builds: SandboxDesktopBuild[]; editable: boolean; onChanged: () => void }) {
  const [viewing, setViewing] = useState<SandboxDesktopBuild | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = async (id: string) => {
    setError(null);
    try {
      setViewing(await getSandboxBuild(id));
    } catch (e) {
      setError(errorMessage(e, "Failed to read the build"));
    }
  };
  const cancel = async (id: string) => {
    setError(null);
    try {
      await cancelSandboxBuild(id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Failed to cancel the build"));
    }
  };
  if (!builds.length) return null;
  return (
    <div style={{ marginTop: 16 }} data-testid="sandbox-build-list">
      <h4 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 6px 0" }}>Builds</h4>
      <p style={{ ...helpStyle, margin: "0 0 6px 0" }}>One runs at a time, in the order asked.</p>
      {error && (
        <p role="alert" style={{ ...helpStyle, color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {builds.slice(0, 10).map((build) => (
        <div
          key={build.id}
          data-testid={`sandbox-build-${build.id}`}
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 13, padding: "4px 0", borderTop: "1px solid var(--border)" }}
        >
          <span style={{ minWidth: 0, flex: "1 1 180px", wordBreak: "break-word" }}>
            {buildLabel(build)}
            {build.requestedAt ? <span style={{ color: "var(--text-muted)" }}> · {new Date(build.requestedAt).toLocaleString()}</span> : null}
          </span>
          <span role="status" style={{ color: isActive(build) ? "var(--accent)" : build.phase === "succeeded" ? "var(--success)" : "var(--text-muted)" }}>
            {PHASE_LABELS[build.phase ?? build.state] ?? build.phase ?? build.state}
          </span>
          {build.id && (
            <button style={secondaryButton} onClick={() => void view(build.id!)} aria-label={`View the log of ${buildLabel(build)}`}>
              View log
            </button>
          )}
          {build.id && isActive(build) && (
            <button
              style={{ ...secondaryButton, opacity: editable ? 1 : 0.5 }}
              disabled={!editable}
              onClick={() => void cancel(build.id!)}
              aria-label={`Cancel the build of ${buildLabel(build)}`}
            >
              <X size={14} /> Cancel
            </button>
          )}
        </div>
      ))}
      {viewing && <BuildLog build={viewing} label={buildLabel(viewing)} />}
    </div>
  );
}

/** One profile: what it is, what a session gets, its image, and (for a signed-in human) build and remove. */
function ProfileCard({
  profile,
  editable,
  busy,
  onBuild,
  onRemove,
}: {
  profile: SandboxProfileStatus;
  editable: boolean;
  busy: boolean;
  onBuild: () => void;
  onRemove: () => void;
}) {
  const { image, limits } = profile;
  const built = image.state !== "missing";
  const unsupported = profile.architectureSupported === false;
  const clamped = new Set(profile.clamped ?? []);
  const limit = (key: keyof typeof limits, text: string) => (
    <span>
      {text}
      {clamped.has(key) ? (
        <span style={{ color: "var(--warning)" }} title={`The recipe asks for ${String(profile.requested[key])}; capped below`}>
          {" "}
          (capped)
        </span>
      ) : null}
    </span>
  );
  return (
    <div
      data-testid={`sandbox-profile-${profile.name}`}
      style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginTop: 12, minWidth: 0 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <strong style={{ fontSize: 14 }}>
          {profile.name}
          {profile.scope && profile.scope !== "global" ? <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> ({profile.scope})</span> : null}
        </strong>
        <span
          role="status"
          style={{ fontSize: 12, color: profileStateColor(image.state), border: "1px solid currentColor", borderRadius: 10, padding: "1px 8px" }}
        >
          {PROFILE_STATE_LABELS[image.state] ?? image.state}
        </span>
      </div>
      <p style={{ ...helpStyle, margin: "6px 0" }}>{profile.description}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 13 }}>
        {limit("cpus", `${limits.cpus} CPU${limits.cpus === 1 ? "" : "s"}`)}
        {limit("memoryMb", `${formatMb(limits.memoryMb)} memory`)}
        {limit("homeMb", `${formatMb(limits.homeMb)} home (counts toward memory)`)}
        {limit("sessionMinutes", `${limits.sessionMinutes} min sessions`)}
        <span>{profile.gl === "software" ? "Software OpenGL" : "No OpenGL"}</span>
      </div>
      <p style={{ ...helpStyle, margin: "6px 0 0 0", wordBreak: "break-word" }}>
        <code style={codeStyle}>{image.name}</code>
        {image.sizeBytes ? ` · ${Math.round(image.sizeBytes / 1024 / 1024)} MB` : ""}
        {image.builtAt ? ` · built ${new Date(image.builtAt).toLocaleString()}` : ""}
        {image.detail ? ` · ${image.detail}` : ""}
      </p>
      {unsupported && (
        <p role="status" style={{ ...helpStyle, color: "var(--warning)" }}>
          Builds only on {(profile.architectures ?? []).join(", ")}; this Docker host is another architecture, so it cannot be built here.
        </p>
      )}
      <details style={{ marginTop: 6, fontSize: 12 }} data-testid={`sandbox-profile-recipe-${profile.name}`}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>What the build installs and runs (the full recipe)</summary>
        <p style={{ ...helpStyle, wordBreak: "break-word" }}>
          Debian packages (installed as root, from Debian only): {profile.packages.length ? profile.packages.join(", ") : "none"}
          {profile.gl === "software" ? " (plus Mesa for software OpenGL)" : ""}.
        </p>
        {profile.downloads.map((d) => (
          <p key={d.dest} style={{ ...helpStyle, wordBreak: "break-all" }}>
            /opt/{d.dest} ← {d.url} (sha256 {d.sha256})
          </p>
        ))}
        <p style={{ ...helpStyle, margin: "8px 0 4px 0" }}>Setup script (bash, run at build time as the unprivileged desktop user, with no network):</p>
        <pre style={recipePreStyle}>{profile.setup || "(none)"}</pre>
        {(profile.path?.length ?? 0) > 0 && <p style={{ ...helpStyle, wordBreak: "break-all" }}>PATH additions: {(profile.path ?? []).join(":")}</p>}
        {Object.keys(profile.env ?? {}).length > 0 && (
          <pre style={recipePreStyle}>
            {Object.entries(profile.env ?? {})
              .map(([key, value]) => `${key}=${value}`)
              .join("\n")}
          </pre>
        )}
        {profile.recipe && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>Canonical recipe (what is built and hashed)</summary>
            <pre style={recipePreStyle}>{profile.recipe}</pre>
          </details>
        )}
      </details>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <button
          style={{ ...(built ? secondaryButton : primaryButton), opacity: editable && !unsupported ? 1 : 0.5 }}
          disabled={!editable || unsupported}
          onClick={onBuild}
          aria-label={`${built ? "Rebuild" : "Build"} profile ${profile.name}`}
        >
          <Hammer size={14} />
          {!built ? "Build" : image.state === "current" ? "Rebuild" : "Rebuild (needed)"}
        </button>
        {built && (
          <button
            style={{ ...secondaryButton, opacity: editable && !busy ? 1 : 0.5 }}
            disabled={!editable || busy}
            onClick={onRemove}
            aria-label={`Remove profile ${profile.name}'s image`}
          >
            <Trash2 size={14} /> Remove image
          </button>
        )}
      </div>
    </div>
  );
}

function Diagnostic({ ok, label, children }: { ok: boolean | "warn" | undefined; label: string; children: React.ReactNode }) {
  const color = ok === undefined ? "var(--text-muted)" : ok === "warn" ? "var(--warning)" : ok ? "var(--success)" : "var(--danger)";
  return (
    <div style={rowStyle} data-testid={`sandbox-diagnostic-${label.toLowerCase()}`}>
      <span aria-hidden style={{ color, display: "inline-flex", marginTop: 2 }}>
        {ok === false ? <X size={14} /> : ok === "warn" ? <AlertTriangle size={14} /> : <Check size={14} />}
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
  // From the list of builds when the daemon sends one: `build` alone is one record, and a queued build is not the running one.
  const activeBuilds = (status?.builds ?? (status?.build.state === "running" ? [status.build] : [])).filter(isActive);
  const building = activeBuilds.length > 0 || status?.build.state === "running";
  const baseBuilding = activeBuilds.some((b) => b.kind === "base" || (!b.kind && !b.profile));
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(false), 2000);
    return () => clearInterval(timer);
  }, [building, refresh]);

  const save = async () => {
    if (!draft || !status) return;
    // A mode change ends every live sandbox session (routes/sandbox-desktop.ts); say how many first.
    const running = status.diagnostics.running.sessions;
    // Compare the mode in force, not the stored setting: Automatic and Managed are the same mode when
    // Automatic resolves to managed, and the daemon ends sessions only when the mode in force changes.
    const automaticResolves = status.diagnostics.endpoint.configured ? "endpoint" : "managed";
    const before = status.automatic ? automaticResolves : status.effectiveMode;
    const after = draft.mode === "auto" ? automaticResolves : draft.mode;
    const modeChanges = before !== after;
    if (modeChanges && running > 0 && !window.confirm(`Changing the mode ends ${running} running sandbox session${running === 1 ? "" : "s"}. Continue?`))
      return;
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
        keepHours: Number(draft.keepHours),
        maxKept: Number(draft.maxKept),
        deliverablesGb: Number(draft.deliverablesGb),
        profileMaxCpus: Number(draft.profileMaxCpus),
        profileMaxMemoryMb: Number(draft.profileMaxMemoryMb),
        profileMaxHomeMb: Number(draft.profileMaxHomeMb),
        profileMaxSessionMinutes: Number(draft.profileMaxSessionMinutes),
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

  const build = async (profile?: string, scope?: string) => {
    setError(null);
    try {
      const state = await buildSandboxDesktopImage(profile, scope);
      setStatus((current) => (current ? { ...current, build: state } : current));
    } catch (e) {
      setError(errorMessage(e, "Failed to start the image build"));
    }
  };

  const remove = async (profile: string, scope?: string) => {
    if (!window.confirm(`Remove profile ${profile}'s image? Building it again downloads and installs everything again.`)) return;
    setError(null);
    try {
      const { status: next } = await removeSandboxProfile(profile, scope);
      setStatus(next);
    } catch (e) {
      setError(errorMessage(e, `Failed to remove profile ${profile}`));
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
  const { cpus, memoryMb, maxConcurrent, keepHours, maxKept, deliverablesGb, profileMaxCpus, profileMaxMemoryMb, profileMaxHomeMb, profileMaxSessionMinutes } =
    SANDBOX_DESKTOP_BOUNDS;
  const profiles = status.profiles ?? [];
  const capField = (id: string, key: keyof Draft, label: string, bound: { min: number; max: number }, step: number) => (
    <div>
      <label style={labelStyle} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        style={inputStyle}
        type="number"
        min={bound.min}
        max={bound.max}
        step={step}
        value={draft[key]}
        disabled={!editable}
        onChange={field(key)}
      />
      <p style={helpStyle}>
        {bound.min}–{bound.max}
      </p>
    </div>
  );
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
          {status.warning === "image-outdated" && (
            <span role="status" style={{ display: "block", marginTop: 6, color: "var(--warning)" }}>
              Image out of date: {status.warningHint ?? "rebuild it."}
            </span>
          )}
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
          <p style={helpStyle}>Applies to sandboxes started after saving; running ones keep theirs.</p>
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
          <div>
            <label style={labelStyle} htmlFor="sandbox-keep-hours">
              Keep for recovery (hours)
            </label>
            <input
              id="sandbox-keep-hours"
              style={inputStyle}
              type="number"
              min={keepHours.min}
              max={keepHours.max}
              step={1}
              value={draft.keepHours}
              disabled={!editable}
              onChange={field("keepHours")}
            />
            <p style={helpStyle}>
              {keepHours.min}–{keepHours.max}. A sandbox whose files could not all be copied out is paused and kept this long, then removed
            </p>
          </div>
          <div>
            <label style={labelStyle} htmlFor="sandbox-max-kept">
              Kept at once
            </label>
            <input
              id="sandbox-max-kept"
              style={inputStyle}
              type="number"
              min={maxKept.min}
              max={maxKept.max}
              step={1}
              value={draft.maxKept}
              disabled={!editable}
              onChange={field("maxKept")}
            />
            <p style={helpStyle}>
              {maxKept.min}–{maxKept.max}, across all chats; each holds its memory while paused. 0 never keeps one
            </p>
          </div>
          <div>
            <label style={labelStyle} htmlFor="sandbox-deliverables-gb">
              Deliverables storage (GiB)
            </label>
            <input
              id="sandbox-deliverables-gb"
              style={inputStyle}
              type="number"
              min={deliverablesGb.min}
              max={deliverablesGb.max}
              step={1}
              value={draft.deliverablesGb}
              disabled={!editable}
              onChange={field("deliverablesGb")}
            />
            <p style={helpStyle}>
              {deliverablesGb.min}–{deliverablesGb.max}, across all chats. Past it new files are refused, never old ones deleted; deleting a chat frees its
              files
            </p>
          </div>
        </div>
        <p style={helpStyle}>Limits apply to sandboxes started after saving; running ones keep theirs.</p>

        <h3 style={{ fontSize: 13, fontWeight: 600, margin: "16px 0 4px 0" }}>Profile caps</h3>
        <p style={helpStyle}>
          A sandbox profile asks for its own CPUs, memory, home size and session length; each is capped here. The home is a memory-backed tmpfs, so it counts
          toward the memory limit: a profile&apos;s home is kept small enough to leave the desktop a quarter of its memory (at least 512 MiB). The base desktop
          keeps the limits above and 15-minute sessions.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 8 }}>
          {capField("sandbox-profile-max-cpus", "profileMaxCpus", "Max CPUs per profile", profileMaxCpus, 0.5)}
          {capField("sandbox-profile-max-memory", "profileMaxMemoryMb", "Max memory (MiB)", profileMaxMemoryMb, 256)}
          {capField("sandbox-profile-max-home", "profileMaxHomeMb", "Max home size (MiB)", profileMaxHomeMb, 256)}
          {capField("sandbox-profile-max-minutes", "profileMaxSessionMinutes", "Max session (minutes)", profileMaxSessionMinutes, 5)}
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
        <Diagnostic
          ok={
            !d.docker.reachable
              ? undefined
              : !(d.image.present && d.image.compatible && d.image.secure !== false)
                ? false
                : d.image.current === false
                  ? "warn"
                  : true
          }
          label="Image"
        >
          <code style={codeStyle}>{d.image.name}</code>{" "}
          {!d.image.present
            ? "is not built"
            : !d.image.compatible
              ? `protocol ${d.image.protocol ?? "unlabelled"}, but this Callboard speaks ${d.image.expectedProtocol}: rebuild it`
              : d.image.secure === false
                ? `has a known security issue (security level ${d.image.securityFloor ?? "unlabelled"}, at least ${d.image.requiredSecurityFloor ?? 1} required): sandboxes are refused until you rebuild it below`
                : d.image.current === false
                  ? `protocol ${d.image.protocol} (compatible), but out of date: not built from the files this Callboard ships, so it may lack driver-host fixes. Sandboxes still start; rebuild it below.`
                  : `protocol ${d.image.protocol} (compatible), up to date, version ${d.image.version ?? "unknown"}`}
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
          <code style={codeStyle}>{status.buildCommand}</code>. A build takes a few minutes and downloads the pinned base image and Debian packages. Rebuilding
          it from new files makes every profile out of date: profiles still start, but keep running the driver host and hardening they were built with until you
          rebuild them.
        </p>
        <button style={{ ...primaryButton, opacity: editable && !baseBuilding ? 1 : 0.5 }} disabled={!editable || baseBuilding} onClick={() => void build()}>
          {baseBuilding ? <Loader2 size={14} className="spin" /> : <Hammer size={14} />}
          {baseBuilding
            ? "Building…"
            : !d.image.present
              ? "Build image"
              : d.image.secure === false
                ? "Rebuild image (security fix)"
                : d.image.current === false
                  ? "Rebuild image (out of date)"
                  : "Rebuild image"}
        </button>
        {status.build.state !== "idle" && !status.build.profile && <BuildLog build={status.build} label="the image" />}
      </section>

      {profiles.length > 0 && (
        <section style={sectionStyle} aria-labelledby="sandbox-profiles-heading">
          <div style={headerStyle}>
            <Layers size={16} />
            <h3 id="sandbox-profiles-heading" style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
              Profiles
            </h3>
          </div>
          <p style={subtitleStyle}>
            A profile is a pre-built image for one purpose, such as Blender with software OpenGL, built once from a recipe and started fresh for every session
            with the same hardening as the base desktop. An agent asks for one by name; you still consent in the chat. Build them here or with{" "}
            <code style={codeStyle}>{SANDBOX_PROFILE_BUILD_COMMAND} &lt;name&gt;</code>; a build downloads the recipe&apos;s pinned files and Debian packages,
            and can take several minutes.
          </p>
          {profiles.map((profile) => (
            <ProfileCard
              key={profile.name}
              profile={profile}
              editable={editable}
              busy={activeBuilds.some((b) => b.profileId === profile.id || (!b.profileId && b.profile === profile.name))}
              onBuild={() => void build(profile.name, profile.scope)}
              onRemove={() => void remove(profile.name, profile.scope)}
            />
          ))}
          {status.build.state !== "idle" && status.build.profile && <BuildLog build={status.build} label={`profile ${status.build.profile}`} />}
          <BuildList builds={status.builds ?? []} editable={editable} onChanged={() => void refresh(false)} />
        </section>
      )}
    </div>
  );
}
