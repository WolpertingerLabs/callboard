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
  // `=== true` and not truthiness: "unknown" is a string, and a tri-state that
  // silently reads as configured is the bug this type exists to prevent.
  if (engine.credentials.configured === true) {
    return {
      color: "var(--success)",
      label: "Ready",
      title: `Ready${engine.credentials.source ? ` — credentials from ${engine.credentials.source}` : ""}`,
    };
  }
  return {
    color: "var(--warning)",
    label: engine.credentials.configured === "unknown" ? "Credentials not confirmed" : "Not configured",
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
          Bundled with Callboard — <code style={mono}>{runtime.package}</code> runs in-process. Nothing to install: a global install of it cannot reach
          Callboard&rsquo;s own <code style={mono}>node_modules</code>, which is where the copy that runs comes from.
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
            <>
              . Nothing to install: a global install of it cannot reach Callboard&rsquo;s own <code style={mono}>node_modules</code>.
            </>
          )}
        </>
      );
    case "external-preferred":
      if (runtime.resolvedPath) {
        return (
          <>
            Native <code style={mono}>{runtime.command}</code> at <code style={mono}>{runtime.resolvedPath}</code>, preferred over the bundled{" "}
            <code style={mono}>{runtime.fallbackPackage}</code>
            {runtime.fallbackVersion ? ` ${runtime.fallbackVersion}` : ""}.
          </>
        );
      }
      // The bundled binary is an optional dependency, so "no native CLI" does
      // not imply "the bundled one runs" — say which of the two states it is.
      return engine.installed ? (
        <>
          No native <code style={mono}>{runtime.command}</code> on PATH — running the binary bundled with <code style={mono}>{runtime.fallbackPackage}</code>
          {runtime.fallbackVersion ? ` ${runtime.fallbackVersion}` : ""}.
        </>
      ) : (
        <>
          No native <code style={mono}>{runtime.command}</code> on PATH, and no bundled binary for this platform in{" "}
          <code style={mono}>{runtime.fallbackPackage}</code> — this engine cannot run until one of the two is installed.
        </>
      );
    case "external":
      // `installed` decides found-or-not, and the path is shown when known:
      // the fallback built from /api/system-info knows the former but not the
      // latter, and keying the sentence off the path told a user with the CLI
      // on their PATH to go and install it.
      if (!engine.installed) {
        return (
          <>
            External CLI — <code style={mono}>{runtime.command}</code> not found on PATH. Install it to enable this engine.
          </>
        );
      }
      return runtime.resolvedPath ? (
        <>
          External CLI — <code style={mono}>{runtime.command}</code> at <code style={mono}>{runtime.resolvedPath}</code>. You install and update it yourself.
        </>
      ) : (
        <>
          External CLI — <code style={mono}>{runtime.command}</code>, found on PATH. You install and update it yourself.
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
 * The npm package this engine's "Latest" is about, when there is one.
 *
 * Optional only on `external`: an ACP vendor may ship a CLI that npm has never
 * heard of, and for that one nothing was ever asked.
 */
function trackedPackage(engine: EngineStatus): string | undefined {
  return engine.runtime.package;
}

/**
 * What, if anything, a user can do about a newer published version.
 *
 * A `switch` rather than a ternary chain so `pinned` / `dependencyRange` are
 * read only off the variants that carry them.
 */
function updateRemedy(runtime: EngineStatus["runtime"]): React.ReactNode {
  switch (runtime.kind) {
    case "external":
    case "external-preferred":
      return " · update available";
    case "bundled":
    case "bundled-overridable":
      if (runtime.pinned) {
        return (
          <>
            {" "}
            · newer than the version Callboard pins (<code style={mono}>{runtime.dependencyRange}</code>), which only moves when Callboard&rsquo;s manifest does
          </>
        );
      }
      if (runtime.dependencyRange) {
        return (
          <>
            {" "}
            · within Callboard&rsquo;s <code style={mono}>{runtime.dependencyRange}</code> range, so a Callboard update can pick it up
          </>
        );
      }
      return " · newer than the bundled copy";
  }
}

/**
 * The Latest row.
 *
 * An update being available is stated as a fact, and the *remedy* is stated only
 * where one exists. Three cases, and conflating them is how this row lies:
 *
 * - **Pinned** (`@cline/sdk`, `@earendil-works/pi-coding-agent` — exact
 *   versions in Callboard's manifest): updating Callboard changes nothing until
 *   a maintainer moves the pin, so the row states the pin and stops. The first
 *   cut of this said "updating Callboard picks it up", which was false for
 *   exactly the two engines it was rendered for.
 * - **Ranged** (`@openai/codex-sdk`, a caret): a Callboard update really can
 *   resolve the newer version, so saying so is honest.
 * - **External**: the user installs it, so "update available" is an action they
 *   can take. Phase 2 gives them the command.
 */
function latestSummary(engine: EngineStatus): React.ReactNode {
  if (!engine.latestVersion) {
    // Distinguish "asked and could not reach npm" from "never asked" — an
    // engine with no package to look up is not an offline daemon. The second
    // branch states Callboard's own state rather than a claim about what npm
    // does or does not carry, which is not something this knows either.
    return trackedPackage(engine) ? (
      <span style={{ color: "var(--text-muted)" }}>Unavailable — the npm registry could not be reached</span>
    ) : (
      <span style={{ color: "var(--text-muted)" }}>Not checked — Callboard tracks no npm package for this CLI</span>
    );
  }

  return (
    <>
      <code style={mono}>{engine.latestVersion}</code>
      {engine.updateAvailable === true ? (
        <span style={{ color: "var(--warning)" }}>{updateRemedy(engine.runtime)}</span>
      ) : engine.updateAvailable === false && !engine.latestVersionStale ? (
        <span style={{ color: "var(--text-muted)" }}> · up to date</span>
      ) : null}
      {/* An answer nobody could refresh is still worth showing, but it is a
          weaker claim than a fresh one — so it says when it was last true
          rather than asserting the present tense. */}
      {engine.latestVersionStale ? (
        <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
          Last checked {formatCheckedAt(engine.latestVersionCheckedAt)}; the registry could not be reached since.
        </div>
      ) : null}
    </>
  );
}

/** A cache timestamp as something a human can weigh — "3 days ago", not an ISO string. */
function formatCheckedAt(iso: string | undefined): string {
  if (!iso) return "at an unknown time";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const hours = Math.floor((Date.now() - then) / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The Credentials row: configured, not configured, or genuinely unknown.
 *
 * The third state is the point. "Not configured" is an assertion about the
 * user's machine, and for an ACP vendor — or an embedded runtime reading a key
 * from the process environment — Callboard has no standing to make it. It read
 * as a flat denial to users who *were* authenticated, printed directly above a
 * note explaining that a chat might work anyway.
 */
function credentialsSummary(engine: EngineStatus): React.ReactNode {
  const { configured, source, note } = engine.credentials;
  return (
    <>
      {configured === true ? (
        <>Configured{source ? <> — {source}</> : null}</>
      ) : configured === "unknown" ? (
        <span style={{ color: "var(--text-muted)" }}>Callboard cannot tell</span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>Not configured</span>
      )}
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
