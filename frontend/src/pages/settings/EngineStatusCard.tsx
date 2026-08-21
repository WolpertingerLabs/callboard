import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Cpu, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import CopyButton from "../../components/CopyButton";
import { readEngineInstallStream, startEngineInstall } from "../../api";
import type { EngineInstallEvent, EngineInstallGuidance, EngineInstallRecipe, EngineOneClickOffer, EngineStatus } from "../../api";

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
 * ## Phase 2 — the command
 *
 * Under the rows sits {@link InstallGuidance}: the copyable text for the engines
 * that have one, the shape `web-tunnel.ts`'s `INSTALL_HINT` already used for
 * `cloudflared`, promoted from a log string to an affordance.
 *
 * A **bundled** engine never gets one, however far behind it is. Not out of
 * caution: `npm i -g @cline/sdk@latest` cannot reach Callboard's nested
 * `node_modules`, so the button would be an inert no-op whose version row never
 * moved. Their action is a link to About — see {@link BundledUpdateNote}.
 *
 * ## Phase 3 — the button, which is a shortcut and never a replacement
 *
 * `install.oneClick` adds an **Install** button beside the npm command, and the
 * copy block stays exactly where it was. That is Decision 8 rendered rather than
 * merely intended: every path that declines to run the install — a client
 * outside the LAN, `allowEngineInstalls` off, Windows, a non-writable npm
 * prefix, a spawn that failed, a non-zero exit, an install npm completed that
 * this daemon still cannot see — arrives here with a one-line reason printed
 * *under* the same command it always showed. There is no state on this card
 * where the user is offered a button, refused, and left with nothing to type.
 *
 * The copy that ships next to a button is held to the standard the rest of this
 * card is: {@link InstallRunner} says "Installing…" only while npm is running,
 * "Checking…" while the server re-probes, and "Installed" only for an
 * `install_verified` event that actually found the binary. A zero exit on its
 * own says nothing here, because it does not mean the daemon can see anything —
 * see `services/engine-install.ts`.
 *
 * @see plans/engine-availability-and-install.md — Phase 3, Decisions 2, 5 and 8
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
function RecipeBlock({ recipe, offer, runner }: { recipe: EngineInstallRecipe; offer?: EngineOneClickOffer; runner?: InstallRunner }) {
  // The button belongs to *this* recipe or to none: the offer names a package,
  // and only the recipe that installs that package may claim to be what the
  // button runs. A card with an npm recipe and a vendor script must not put an
  // Install button under the script — Decision 5 is not a styling preference.
  const runnable = offer && recipe.method === "npm-global" && recipe.package === offer.package;

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
        {/* `copy-btn` is a real class in index.css, unlike the invented
            `engine-install-copy-btn` this used to pass — CopyButton's prop is
            the hook its hover-reveal CSS keys on, so a name nothing defines is
            a name nothing styles. This block has no hover-reveal (the button is
            always visible), but the class still carries the shared chrome. */}
        <CopyButton text={recipe.command} title={`Copy: ${recipe.command}`} className="copy-btn" size={12} />
      </div>
      {runnable && runner && offer ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => runner.start(offer)}
            disabled={runner.busy}
            title={`Run \`${offer.command}\` on the machine running Callboard`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid var(--accent)",
              background: runner.busy ? "var(--surface)" : "var(--accent)",
              color: runner.busy ? "var(--text-muted)" : "var(--text-on-accent)",
              fontSize: 11,
              fontWeight: 500,
              cursor: runner.busy ? "default" : "pointer",
            }}
          >
            {runner.busy ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={11} />}
            {runner.busyLabel ?? "Install"}
          </button>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Runs it here, on the machine running Callboard.</span>
        </div>
      ) : null}
      {/* The nvm caveat, but *detected* rather than stated: the generic version
          of this sentence is already in `caveats` below, and it has to hedge
          because Phase 2 never looked. This one names the actual interpreter and
          the actual prefix, and it is a warning rather than a refusal because
          the daemon doing the install is the daemon that will look. */}
      {runnable && offer?.note ? <div style={{ ...noteStyle, marginTop: 6 }}>{withInlineCode(offer.note)}</div> : null}
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
 * ones — the backend decides, in `engine-install-recipes.ts`, so the gates are
 * testable rather than spread through JSX.
 *
 * Two shapes, and the difference matters:
 *
 * - **With recipes** — something to install. Heading "What to run".
 * - **Without** — the CLI is already there and only a login is missing, so
 *   there is a sentence and nothing to copy. Heading "What to do". Rendering
 *   the install version here would tell someone to install what they have,
 *   which is what the Codex block did to anyone who had just followed it.
 *
 * The closing line is conditional on {@link EngineInstallRecipe.visibleAfterRecheck}
 * rather than fixed. Telling a user to press Recheck after running a vendor
 * script is false by construction: those scripts install into a directory they
 * add to the shell rc, and a running daemon's PATH cannot pick that up.
 *
 * It is also conditional on whether one of these can be *run*. "Callboard does
 * not run it for you" was true of every recipe in Phase 2 and is now true of
 * some: a `script` recipe keeps that sentence forever (Decision 5), and an
 * `npm-global` one loses it only when a button was actually offered — the
 * server decided that, per client, and said why when the answer was no.
 */
function InstallGuidance({ install, runner }: { install: EngineInstallGuidance; runner?: InstallRunner }) {
  const hasRecipes = install.recipes.length > 0;
  const anyRecheckable = install.recipes.some((r) => r.visibleAfterRecheck);
  const allRecheckable = hasRecipes && install.recipes.every((r) => r.visibleAfterRecheck);
  const offer = install.oneClick;
  // "Copy one of these" is wrong when there is only one, and "Callboard does not
  // run it for you" is wrong when it just did. Two conditions, kept apart,
  // because the second is the one Phase 2 hard-coded.
  const copyOnlyRecipes = install.recipes.filter((r) => !(offer && r.method === "npm-global" && r.package === offer.package));

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{hasRecipes ? "What to run" : "What to do"}</div>
      <div style={{ ...noteStyle, marginTop: 0 }}>{withInlineCode(install.reason)}</div>
      {install.scope ? <div style={noteStyle}>{withInlineCode(install.scope)}</div> : null}
      {install.recipes.map((recipe) => (
        <RecipeBlock key={`${recipe.method}:${recipe.command}`} recipe={recipe} offer={offer} runner={runner} />
      ))}
      {/* Why there is no Install button, when a runnable recipe exists and one
          was not offered. Rendered *under* the command it declines to run, never
          in place of it — that structural ordering is the whole of Decision 8. */}
      {install.refusal ? (
        <div style={{ ...noteStyle, display: "flex", gap: 6, alignItems: "flex-start" }}>
          <AlertTriangle size={12} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }} />
          <span>{withInlineCode(install.refusal)}</span>
        </div>
      ) : null}
      {install.alternative ? <div style={noteStyle}>{withInlineCode(install.alternative)}</div> : null}
      <div style={noteStyle}>
        {copyOnlyRecipes.length > 0 ? (
          <>
            {copyOnlyRecipes.length === install.recipes.length
              ? `Copy ${install.recipes.length > 1 ? "one of these" : "this"} into your own terminal — Callboard does not run it for you. `
              : "Callboard runs only the npm command above; the other is yours to copy into a terminal. "}
          </>
        ) : offer ? (
          <>Press Install to run it here, or copy it into your own terminal — the two do the same thing. </>
        ) : null}
        {anyRecheckable ? (
          <>
            {/* The Install button already re-probes server-side and reports what
                that probe found, so telling someone who used it to press
                Recheck would be busywork. The instruction is for the copy path,
                which is the only path left when a button was refused. */}
            {offer ? <>If you run it in a terminal instead, press </> : <>Afterwards press </>}
            <strong>Recheck</strong> above: binary lookups are resolved once per daemon and cached, so until then this card keeps reporting what it found
            before.
            {allRecheckable ? null : <> Recheck cannot see the installer script&rsquo;s result — see its note above.</>}
          </>
        ) : hasRecipes ? (
          <>
            Recheck will not see this: the installer puts the binary somewhere it adds to your shell&rsquo;s PATH, and a running daemon&rsquo;s PATH is fixed at
            startup. Run <code style={mono}>callboard restart</code> from a terminal where the command works.
          </>
        ) : (
          <>
            Afterwards press <strong>Recheck</strong> above — it re-reads the credential too, not just the binary lookups.
          </>
        )}
      </div>
    </div>
  );
}

// ── One-click install ───────────────────────────────────────────────

/** How the install is going, in the only four states this card can honestly distinguish. */
type InstallPhase =
  /** The POST is in flight. Nothing is installing yet. */
  | "starting"
  /** npm is running. This is the only state that may say "Installing". */
  | "running"
  /** npm exited 0 and the server is re-probing. A zero exit is not yet a result. */
  | "verifying"
  /** There is a verdict. */
  | "done";

/** Colour and icon follow the verdict, and the verdict is never inferred from the exit code alone. */
type VerdictTone = "ok" | "warn" | "error";

interface InstallRunState {
  engineId: string;
  command: string;
  phase: InstallPhase;
  lines: { stream: "stdout" | "stderr"; line: string }[];
  /** Set only by a terminal event. `tone: "warn"` is "npm succeeded and Callboard still cannot see it". */
  verdict?: { tone: VerdictTone; text: string };
}

/** What {@link RecipeBlock} needs to render a button, and nothing more. */
interface InstallRunner {
  start: (offer: EngineOneClickOffer) => void;
  busy: boolean;
  busyLabel?: string;
}

/** Lines kept in the browser. The server caps its own buffer too; this is the render bound. */
const MAX_CONSOLE_LINES = 500;

/**
 * Own one install for one card.
 *
 * State lives here, on the card, rather than inside {@link InstallGuidance} —
 * and that is load-bearing, not tidiness. A successful install makes the
 * guidance disappear (the engine is fine now), and if the transcript lived
 * inside it the console and the "Installed" line would unmount at the exact
 * moment they became the answer to "did that work?".
 */
function useInstallRunner(onEnginesUpdated?: (engines: EngineStatus[]) => void): { runner: InstallRunner; run: InstallRunState | null } {
  const [run, setRun] = useState<InstallRunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  // A stream left open after the tab is gone is a socket the daemon holds for
  // nothing. The install itself is server-side and carries on regardless, which
  // is why this aborts the read rather than trying to cancel the install.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    (offer: EngineOneClickOffer) => {
      if (runningRef.current) return;
      runningRef.current = true;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRun({ engineId: offer.engineId, command: offer.command, phase: "starting", lines: [] });

      void (async () => {
        try {
          const started = await startEngineInstall(offer.engineId);
          setRun((prev) => (prev ? { ...prev, phase: "running", command: started.command } : prev));

          await readEngineInstallStream(
            started.installId,
            (event: EngineInstallEvent) => {
              setRun((prev) => (prev ? reduceInstallEvent(prev, event) : prev));
              // Push the re-probed statuses up so every tab's dot, every version
              // row and this card's own guidance move together. The server did
              // the probing; this is the only place its answer enters the page.
              if (event.type === "install_verified") onEnginesUpdated?.(event.engines);
            },
            controller.signal,
          );

          // The server closes the stream on its terminal event, so arriving here
          // without a verdict means the connection dropped first. Say that,
          // rather than leaving a spinner that will never stop.
          setRun((prev) =>
            prev && prev.phase !== "done"
              ? {
                  ...prev,
                  phase: "done",
                  verdict: {
                    tone: "warn",
                    text: "The connection to the install stream ended before Callboard reported a result. The install may still have finished — press Recheck above to see where this engine stands.",
                  },
                }
              : prev,
          );
        } catch (err) {
          if (controller.signal.aborted) return;
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  phase: "done",
                  // The message is the server's `refusal` where there was one:
                  // `assertOk` surfaces the `error` field, and the endpoint puts
                  // the same sentence in both.
                  verdict: { tone: "error", text: err instanceof Error ? err.message : "The install could not be started." },
                }
              : prev,
          );
        } finally {
          runningRef.current = false;
        }
      })();
    },
    [onEnginesUpdated],
  );

  const busy = run !== null && run.phase !== "done";
  return {
    run,
    runner: {
      start,
      busy,
      busyLabel: run?.phase === "starting" ? "Starting…" : run?.phase === "running" ? "Installing…" : run?.phase === "verifying" ? "Checking…" : undefined,
    },
  };
}

/**
 * Fold one stream event into the card's state.
 *
 * The one rule this encodes: **`install_exit` with `ok: true` produces no
 * verdict.** npm exiting 0 means npm wrote files, not that this daemon can find
 * them, and the difference is the whole reason the server sends a second event.
 * Every "Installed" string on this card comes from an `install_verified` whose
 * `visible` is true — which is a path the server observed, not an exit code it
 * interpreted.
 */
function reduceInstallEvent(prev: InstallRunState, event: EngineInstallEvent): InstallRunState {
  switch (event.type) {
    case "install_started":
      return { ...prev, phase: "running", command: event.command };
    case "install_output": {
      const lines = [...prev.lines, { stream: event.stream, line: event.line }];
      return { ...prev, lines: lines.length > MAX_CONSOLE_LINES ? lines.slice(lines.length - MAX_CONSOLE_LINES) : lines };
    }
    case "install_exit":
      if (event.ok) return { ...prev, phase: "verifying" };
      return { ...prev, phase: "done", verdict: { tone: "error", text: event.refusal ?? `The install exited with code ${event.code}.` } };
    case "install_verified":
      return { ...prev, phase: "done", verdict: { tone: event.visible ? "ok" : "warn", text: event.summary } };
  }
}

/**
 * The transcript, and the verdict under it.
 *
 * npm's own output, unedited apart from ANSI stripping server-side. It is shown
 * rather than summarised because a failed global install says why in its own
 * words far better than any sentence this card could compose, and because a
 * command Callboard ran on the user's machine should not be something they have
 * to take on trust.
 */
function InstallConsole({ run }: { run: InstallRunState }) {
  const scroller = useRef<HTMLPreElement | null>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop following the moment the user scrolls up to read
  // something — an auto-scroll that fights the reader is worse than none.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [run.lines.length, run.phase]);

  const tone = run.verdict?.tone;
  const toneColor = tone === "ok" ? "var(--success)" : tone === "error" ? "var(--danger)" : "var(--warning)";

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Install output</span>
        <code style={{ ...mono, color: "var(--text-muted)" }}>{run.command}</code>
      </div>
      {run.lines.length > 0 ? (
        <pre
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          style={{
            margin: 0,
            maxHeight: 200,
            overflowY: "auto",
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text-muted)",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {/* One text node rather than an element per line: npm can emit
              hundreds, and a `<pre>` renders them identically either way.
              stdout and stderr are not styled differently — npm writes notices
              to stderr routinely, so colouring it as a warning would invent a
              severity npm never claimed. */}
          {run.lines.map((l) => `${l.line}\n`).join("")}
        </pre>
      ) : (
        <div style={{ ...noteStyle, marginTop: 0 }}>{run.phase === "starting" ? "Asking the daemon to start it…" : "No output yet."}</div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 8, fontSize: 11, lineHeight: 1.55 }}>
        {run.verdict ? (
          <>
            {tone === "ok" ? (
              <CheckCircle2 size={12} style={{ color: toneColor, flexShrink: 0, marginTop: 2 }} />
            ) : (
              <AlertTriangle size={12} style={{ color: toneColor, flexShrink: 0, marginTop: 2 }} />
            )}
            <span style={{ color: tone === "ok" ? "var(--text)" : "var(--text-muted)" }}>{withInlineCode(run.verdict.text)}</span>
          </>
        ) : (
          <>
            <Loader2 size={12} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 2, animation: "spin 1s linear infinite" }} />
            <span style={{ color: "var(--text-muted)" }}>
              {run.phase === "verifying"
                ? "npm has finished. Checking whether Callboard can actually find it — a global install that exits 0 is not the same thing as one this daemon can see."
                : "Running on the machine hosting Callboard. Leaving this page does not stop it."}
            </span>
          </>
        )}
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
 * What a Recheck actually did, as the server reports it.
 *
 * `probed: false` means the call was coalesced with a concurrent one or landed
 * inside the server's minimum interval. The endpoint drops five caches and
 * re-runs a `which` per engine, two `--version` spawns and an Agent SDK query —
 * two of them synchronously on a single-threaded server — so it is rate-limited,
 * and the button has to be able to say "that did not re-probe" rather than
 * flashing a success it did not earn.
 */
export interface EngineRecheckOutcome {
  probed: boolean;
  retryAfterMs?: number;
}

/**
 * "Recheck" — drop the daemon's cached lookups and probe again.
 *
 * The button that makes the copy block above worth anything. Five caches
 * memoize "is it installed" and "who is signed in" for the process lifetime,
 * and without clearing them a user who follows the instructions is told,
 * correctly as far as the daemon knows, that nothing changed.
 *
 * It re-probes and never installs. Three terminal states, all of them honest:
 * a success, a throttled call that says so, and a failure that does not suggest
 * retrying would do something different.
 */
function RecheckButton({ onRecheck }: { onRecheck: () => void | Promise<void | EngineRecheckOutcome> }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "failed" | "throttled">("idle");

  const handle = useCallback(async () => {
    setBusy(true);
    setStatus("idle");
    try {
      const outcome = await onRecheck();
      setStatus(outcome && outcome.probed === false ? "throttled" : "idle");
    } catch {
      setStatus("failed");
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
        title="Re-probe every engine, ignoring the paths and credentials Callboard resolved earlier in this daemon's life"
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
      {status === "failed" ? <span style={{ fontSize: 11, color: "var(--danger)" }}>Recheck failed — the daemon did not answer.</span> : null}
      {status === "throttled" ? (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }} title="Re-probing spawns processes, so it is limited to once every few seconds">
          Checked moments ago — showing that result.
        </span>
      ) : null}
    </>
  );
}

export default function EngineStatusCard({
  engine,
  loading,
  onRecheck,
  onEnginesUpdated,
}: {
  engine: EngineStatus | undefined;
  loading?: boolean;
  /** Re-probe every engine. Omitted where there is no handler to give it — the button then does not render. */
  onRecheck?: () => void | Promise<void | EngineRecheckOutcome>;
  /**
   * The statuses the server re-probed after an install it ran, so the page can
   * adopt them without a second round trip. Omitted ⇒ the install still runs and
   * still reports honestly; only the rest of the page stays stale until Recheck.
   */
  onEnginesUpdated?: (engines: EngineStatus[]) => void;
}) {
  // Before the early return, because hooks are not optional — and because a
  // card that has lost its engine mid-install must still render the transcript.
  const { runner, run } = useInstallRunner(onEnginesUpdated);

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

      {engine.install ? <InstallGuidance install={engine.install} runner={runner} /> : <BundledUpdateNote engine={engine} />}
      {/* Outside the guidance on purpose: a successful install removes the
          guidance block, and the transcript that proves it worked must not
          vanish with it. */}
      {run ? <InstallConsole run={run} /> : null}
    </div>
  );
}
