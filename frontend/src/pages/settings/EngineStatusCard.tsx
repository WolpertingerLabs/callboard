import { Cpu } from "lucide-react";
import type { EngineStatus } from "../../api";

/**
 * The engine status card at the top of every engine tab in Settings → API.
 *
 * ## What it is for
 *
 * Four of the five engines ship *inside* the Callboard package, so an
 * "installed ✓/✗" line would print ✓ forever. The three rows below the header
 * are the facts that actually vary — where the engine came from, what version
 * it is against what npm publishes, and whether it has credentials — and they
 * are deliberately kept apart rather than collapsed into one verdict.
 *
 * The one place a verdict *is* rendered is {@link engineStatusDot}, on the tab
 * strip, where there is room for a dot and nothing else. Its title spells the
 * three facts back out.
 *
 * ## Phase 1 only
 *
 * No install command, no copy button, no "Recheck". Those are Phase 2, and the
 * card is shaped so they slot in under the rows rather than replacing them.
 *
 * @see plans/engine-availability-and-install.md
 */

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "12px 14px",
  background: "var(--bg)",
  marginBottom: 12,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  padding: "6px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: 12,
};

/**
 * One label/value row.
 *
 * Exported because `AcpProviderSection` renders its Permissions and Models rows
 * in the same shape directly beneath this card, and two row helpers that drift
 * apart would be visible as a seam mid-column.
 */
export function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--text)", textAlign: "right", lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}

const mono: React.CSSProperties = { fontSize: 11, fontFamily: "monospace" };

/**
 * The tab-strip dot: colour, a two-word verdict, and the sentence behind it.
 *
 * Three states, from existing tokens rather than new ones — `--success`,
 * `--warning` and `--text-muted` all already carry a checked light/dark pair.
 *
 * "Uncredentialed" is amber rather than red on purpose: for an ACP vendor it is
 * not a fault at all, just a question Callboard cannot ask (credentials live in
 * the vendor's CLI), and for the embedded runtimes the process environment may
 * still supply a key. `title` says which of those it is; `label` is what the
 * card header shows, because the reason is already spelled out one row below in
 * Credentials and printing it twice reads as noise.
 */
export function engineStatusDot(engine: EngineStatus | undefined): { color: string; label: string; title: string } {
  if (!engine) return { color: "var(--text-muted)", label: "Unknown", title: "Engine status unavailable" };
  if (!engine.installed) {
    const command = engine.runtime.kind === "external" ? engine.runtime.command : undefined;
    return { color: "var(--text-muted)", label: "Not installed", title: command ? `Not installed — no ${command} on PATH` : "Not installed" };
  }
  if (engine.credentials.configured) {
    return {
      color: "var(--success)",
      label: "Ready",
      title: `Ready${engine.credentials.source ? ` — credentials from ${engine.credentials.source}` : ""}`,
    };
  }
  return {
    color: "var(--warning)",
    label: "Credentials not confirmed",
    title: `Installed — ${engine.credentials.note ?? "no credentials configured"}`,
  };
}

/** A dot sized for the tab strip. */
export function EngineStatusDot({ engine }: { engine: EngineStatus | undefined }) {
  const { color, title } = engineStatusDot(engine);
  return <span title={title} aria-label={title} style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}

/** Prose for the Runtime row — the one fact that differs per runtime kind. */
function runtimeSummary(engine: EngineStatus): React.ReactNode {
  const runtime = engine.runtime;
  switch (runtime.kind) {
    case "bundled":
      return (
        <>
          Bundled with Callboard — <code style={mono}>{runtime.package}</code> runs in-process. Nothing to install; it updates when Callboard does.
        </>
      );
    case "bundled-overridable":
      return (
        <>
          Bundled with Callboard — <code style={mono}>{runtime.package}</code>
          {runtime.overridePath ? (
            <>
              , overridden by <code style={mono}>{runtime.overridePath}</code>
            </>
          ) : (
            <>. It updates when Callboard does.</>
          )}
        </>
      );
    case "external-preferred":
      return runtime.resolvedPath ? (
        <>
          Native <code style={mono}>{runtime.command}</code> at <code style={mono}>{runtime.resolvedPath}</code>, preferred over the bundled{" "}
          <code style={mono}>{runtime.fallbackPackage}</code>
          {runtime.fallbackVersion ? ` ${runtime.fallbackVersion}` : ""}.
        </>
      ) : (
        <>
          No native <code style={mono}>{runtime.command}</code> on PATH — running the binary bundled with <code style={mono}>{runtime.fallbackPackage}</code>
          {runtime.fallbackVersion ? ` ${runtime.fallbackVersion}` : ""}.
        </>
      );
    case "external":
      return runtime.resolvedPath ? (
        <>
          External CLI — <code style={mono}>{runtime.command}</code> at <code style={mono}>{runtime.resolvedPath}</code>. You install and update it yourself.
        </>
      ) : (
        <>
          External CLI — <code style={mono}>{runtime.command}</code> not found on PATH. Install it to enable this engine.
        </>
      );
  }
}

/** What the Version row says, and what the version is *of*. */
function versionSummary(engine: EngineStatus): React.ReactNode {
  if (engine.version) return <code style={mono}>{engine.version}</code>;
  if (engine.runtime.kind === "external-preferred") return <span style={{ color: "var(--text-muted)" }}>No native install to report a version for</span>;
  if (!engine.installed) return <span style={{ color: "var(--text-muted)" }}>Not installed</span>;
  return <span style={{ color: "var(--text-muted)" }}>Unknown</span>;
}

/**
 * The Latest row.
 *
 * An update being available is stated as a fact and never as a button: a
 * bundled engine is pinned by Callboard's own manifest, and installing a newer
 * one into its tree is a silent way to break the adapter. Phase 2 turns this
 * into an action only for the two engines where the action is honest.
 */
function latestSummary(engine: EngineStatus): React.ReactNode {
  if (!engine.latestVersion) return <span style={{ color: "var(--text-muted)" }}>Unavailable — the npm registry could not be reached</span>;
  const bundled = engine.runtime.kind === "bundled" || engine.runtime.kind === "bundled-overridable";
  return (
    <>
      <code style={mono}>{engine.latestVersion}</code>
      {engine.updateAvailable === true ? (
        <span style={{ color: "var(--warning)" }}>{bundled ? " · newer than the bundled copy; updating Callboard picks it up" : " · update available"}</span>
      ) : engine.updateAvailable === false ? (
        <span style={{ color: "var(--text-muted)" }}> · up to date</span>
      ) : null}
    </>
  );
}

/** The Credentials row: configured-or-not, its source, and the caveat when there is one. */
function credentialsSummary(engine: EngineStatus): React.ReactNode {
  const { configured, source, note } = engine.credentials;
  return (
    <>
      {configured ? <>Configured{source ? <> — {source}</> : null}</> : <span style={{ color: "var(--text-muted)" }}>Not configured</span>}
      {note ? <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{note}</div> : null}
    </>
  );
}

export default function EngineStatusCard({ engine, loading }: { engine: EngineStatus | undefined; loading?: boolean }) {
  if (!engine) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{loading ? "Checking engine status…" : "Engine status unavailable."}</div>
      </div>
    );
  }

  const { label, title } = engineStatusDot(engine);

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
        <Cpu size={14} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{engine.label}</span>
        <EngineStatusDot engine={engine} />
        <span
          title={title}
          style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {label}
        </span>
      </div>

      <StatusRow label="Runtime">{runtimeSummary(engine)}</StatusRow>
      <StatusRow label="Version">{versionSummary(engine)}</StatusRow>
      <StatusRow label="Latest">{latestSummary(engine)}</StatusRow>
      <StatusRow label="Credentials">{credentialsSummary(engine)}</StatusRow>
    </div>
  );
}
