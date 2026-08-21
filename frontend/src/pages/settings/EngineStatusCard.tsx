import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Cpu, ExternalLink, RefreshCw } from "lucide-react";
import CopyButton from "../../components/CopyButton";
import type { EngineInstallGuidance, EngineInstallRecipe, EngineStatus } from "../../api";

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
 * ## Phase 2 — the command, and only ever the command
 *
 * Under the rows sits {@link InstallGuidance}: the copyable text for the engines
 * that have one, the shape `web-tunnel.ts`'s `INSTALL_HINT` already used for
 * `cloudflared`, promoted from a log string to an affordance. It is a copy
 * block and a docs link — there is no install button here, and pressing
 * anything on this card cannot run a command.
 *
 * A **bundled** engine never gets one, however far behind it is. Not out of
 * caution: `npm i -g @cline/sdk@latest` cannot reach Callboard's nested
 * `node_modules`, so the button would be an inert no-op whose version row never
 * moved. Their action is a link to About — see {@link BundledUpdateNote}.
 *
 * @see plans/engine-availability-and-install.md — Phase 2, Decisions 2 and 5
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
      {/* Same backtick handling as the install block below, so `claude auth login`
          reads as a command in both places instead of as prose in one of them. */}
      {note ? <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{withInlineCode(note)}</div> : null}
    </>
  );
}

// ── Install guidance ────────────────────────────────────────────────

/**
 * Render backtick spans in a backend-authored string as `<code>`.
 *
 * The reasons and caveats are prose written next to the facts they describe, in
 * `engine-install-recipes.ts`, and they name binaries and paths the way the rest
 * of this card does. Splitting on backticks keeps that formatting without
 * shipping a markdown renderer into a settings card or duplicating the strings
 * as JSX on this side of the wire.
 */
function withInlineCode(text: string): React.ReactNode {
  const parts = text.split("`");
  return parts.map((part, i) => (i % 2 === 1 ? <code key={i} style={mono}>{part}</code> : <span key={i}>{part}</span>));
}

const noteStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 11, lineHeight: 1.55, marginTop: 6 };

/**
 * One copyable command, its docs link, and the conditions under which it would
 * not help.
 *
 * The caveats are rendered rather than hidden behind a disclosure because the
 * two they cover — a non-writable npm prefix, and an nvm global prefix that
 * belongs to a different Node than the daemon runs on — both end with a command
 * that *succeeded* and an engine that is still missing. Callboard does not
 * detect either in this phase, so it says so instead of implying it checked.
 */
function RecipeBlock({ recipe }: { recipe: EngineInstallRecipe }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{recipe.label}</span>
        <a
          href={recipe.docsUrl}
          target="_blank"
          rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--accent-text)", textDecoration: "none" }}
        >
          Docs
          <ExternalLink size={9} />
        </a>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <code style={{ ...mono, flex: 1, minWidth: 0, overflowX: "auto", whiteSpace: "pre", color: "var(--text)" }}>{recipe.command}</code>
        <CopyButton text={recipe.command} title={`Copy: ${recipe.command}`} className="engine-install-copy-btn" size={12} />
      </div>
      {recipe.caveats?.length ? (
        <ul style={{ ...noteStyle, margin: "6px 0 0", paddingLeft: 16 }}>
          {recipe.caveats.map((caveat) => (
            <li key={caveat} style={{ marginBottom: 2 }}>
              {withInlineCode(caveat)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The block that appears when an engine is not usable and something can be
 * typed about it.
 *
 * Absent for every engine that is fine, and permanently absent for the bundled
 * ones — the backend decides, in `engine-install-recipes.ts`, so the three gates
 * are testable rather than spread through JSX.
 */
function InstallGuidance({ install }: { install: EngineInstallGuidance }) {
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>What to run</div>
      <div style={{ ...noteStyle, marginTop: 0 }}>{withInlineCode(install.reason)}</div>
      {install.scope ? <div style={noteStyle}>{withInlineCode(install.scope)}</div> : null}
      {install.recipes.map((recipe) => (
        <RecipeBlock key={`${recipe.method}:${recipe.command}`} recipe={recipe} />
      ))}
      {install.alternative ? <div style={noteStyle}>{withInlineCode(install.alternative)}</div> : null}
      <div style={noteStyle}>
        Copy one of these into your own terminal — Callboard does not run it for you. Afterwards press <strong>Recheck</strong> above: binary lookups are
        resolved once per daemon and cached, so until then this card keeps reporting what it found before.
      </div>
    </div>
  );
}

/**
 * The bundled engine's version action: a link to About, and no button.
 *
 * Shown only when there is genuinely a newer release, and worded so it promises
 * nothing this page cannot see. Whether a Callboard update exists at all lives
 * on the About page, and whether *that* update moves this dependency depends on
 * Callboard's manifest — which is why the Latest row above already distinguishes
 * a pinned dependency from a ranged one, and why this says "check" rather than
 * "this will fix it".
 */
function BundledUpdateNote({ engine }: { engine: EngineStatus }) {
  const runtime = engine.runtime;
  if (runtime.kind !== "bundled" && runtime.kind !== "bundled-overridable") return null;
  if (engine.updateAvailable !== true) return null;

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>What to do</div>
      <div style={{ ...noteStyle, marginTop: 0 }}>
        Nothing to install: <code style={mono}>{runtime.package}</code> ships inside Callboard, and a global install of it would resolve to a second copy that
        Callboard never loads. This version moves when Callboard&rsquo;s own dependency does
        {runtime.pinned ? <> — and Callboard pins it exactly, so only a release that moves the pin changes it</> : null}.
      </div>
      <Link
        to="/settings/about"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          marginTop: 8,
          padding: "5px 9px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          fontSize: 11,
          textDecoration: "none",
        }}
      >
        Check for a Callboard update
        <ExternalLink size={10} style={{ color: "var(--text-muted)" }} />
      </Link>
    </div>
  );
}

/**
 * "Recheck" — drop the daemon's cached binary lookups and probe again.
 *
 * The button that makes the copy block above worth anything. Four caches
 * memoize "is it installed" for the process lifetime, and without clearing them
 * a user who follows the instructions is told, correctly as far as the daemon
 * knows, that nothing changed.
 *
 * It re-probes and never installs; the failure text says so rather than
 * suggesting a retry might do something different.
 */
function RecheckButton({ onRecheck }: { onRecheck: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const handle = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onRecheck();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [onRecheck]);

  return (
    <>
      <button
        type="button"
        onClick={handle}
        disabled={busy}
        title="Re-probe every engine, ignoring the paths Callboard resolved earlier in this daemon's life"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 8px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text-muted)",
          fontSize: 11,
          cursor: busy ? "default" : "pointer",
          flexShrink: 0,
        }}
      >
        <RefreshCw size={11} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
        {busy ? "Rechecking…" : "Recheck"}
      </button>
      {failed ? <span style={{ fontSize: 11, color: "var(--danger)" }}>Recheck failed — the daemon did not answer.</span> : null}
    </>
  );
}

export default function EngineStatusCard({
  engine,
  loading,
  onRecheck,
}: {
  engine: EngineStatus | undefined;
  loading?: boolean;
  /** Re-probe every engine. Omitted where there is no handler to give it — the button then does not render. */
  onRecheck?: () => void | Promise<void>;
}) {
  if (!engine) {
    return (
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1 }}>{loading ? "Checking engine status…" : "Engine status unavailable."}</span>
          {/* Offered here too: "unavailable" is precisely the state someone
              would want to retry, and the handler does not need an engine. */}
          {!loading && onRecheck ? <RecheckButton onRecheck={onRecheck} /> : null}
        </div>
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
          style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {label}
        </span>
        {onRecheck ? <RecheckButton onRecheck={onRecheck} /> : null}
      </div>

      <StatusRow label="Runtime">{runtimeSummary(engine)}</StatusRow>
      <StatusRow label="Version">{versionSummary(engine)}</StatusRow>
      <StatusRow label="Latest">{latestSummary(engine)}</StatusRow>
      <StatusRow label="Credentials">{credentialsSummary(engine)}</StatusRow>

      {engine.install ? <InstallGuidance install={engine.install} /> : <BundledUpdateNote engine={engine} />}
    </div>
  );
}
