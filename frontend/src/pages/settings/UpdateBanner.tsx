import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Download, Loader2 } from "lucide-react";
import CopyButton from "../../components/CopyButton";
import { getSelfUpdateStatus, probeDaemonVersion, readSelfUpdateStream, startSelfUpdate } from "../../api";
import type { SelfUpdateEvent, SelfUpdateStatusResponse } from "../../api";

/**
 * "Update available", with a button when Callboard can honestly offer one.
 *
 * The banner this replaces printed a version pair and a command to paste into a
 * terminal. On a machine where the daemon is the globally installed copy it can
 * run that command itself and restart into the result, which is what the button
 * does — and every state below exists because that sequence has three places it
 * can stop short of what the user was promised.
 *
 * ## The copy-and-paste command is never removed
 *
 * Not in the refused states, not while installing, not after a failure. It is
 * the thing the whole feature degrades to, and it is the only action left when
 * the daemon cannot act for itself — a banner that hid it whenever the button
 * was unavailable would have taken away the original feature to add a
 * conditional one. Same rule the engine cards follow (Decision 8 of
 * `plans/engine-availability-and-install.md`); this is its second application.
 *
 * ## The success signal does not come from the stream
 *
 * The stream dies with the daemon. `update_restarting` is the last frame this
 * page can receive, so the phases run
 * *installing → verifying → restarting → done*, and the transition into `done`
 * comes from **polling** a daemon that has come back on a new connection and
 * reports the version that was installed. A stream that simply ends after
 * `update_restarting` is therefore success in progress, not an error — and a
 * stream that ends *before* it is the failure case, which is why the two are
 * distinguished rather than both treated as "finished".
 *
 * The page is never reloaded from here. `StaleBundleBanner` already watches the
 * daemon's build id and offers a reload the user chooses to take; reloading
 * underneath them would discard whatever they had typed elsewhere, which is the
 * exact trade that component was written to refuse.
 */

// ── State ───────────────────────────────────────────────────────────

export type SelfUpdatePhase =
  /** The POST has not answered yet. */
  | "starting"
  /** npm is running; `lines` is filling. */
  | "installing"
  /** npm exited 0; the daemon is reading what actually landed on disk. */
  | "verifying"
  /** The restart helper is spawned. This page is now polling for the daemon to answer again. */
  | "restarting"
  /** Terminal, whatever the verdict says. */
  | "done";

export type UpdateVerdictTone = "ok" | "warn" | "error";

export interface SelfUpdateRunState {
  phase: SelfUpdatePhase;
  /** What is being run — shown next to the transcript so the output is attributable. */
  command: string;
  fromVersion: string;
  /** The version read off disk after npm finished. Absent until `update_verified`. */
  installedVersion?: string;
  lines: { stream: "stdout" | "stderr"; line: string }[];
  /** Set only by a terminal state. `warn` is "something happened, and it was not what the button said". */
  verdict?: { tone: UpdateVerdictTone; text: string };
  /** A sentence about what is happening *now*, for the non-terminal phases. */
  progress?: string;
  /** `npm install -g <pkg>@<previous>` — how to go back, learned before the daemon went away. */
  rollbackCommand?: string;
}

/** Lines kept in the browser. The daemon caps its own buffer too; this is the render bound. */
const MAX_CONSOLE_LINES = 500;

/** How long to wait for the restarted daemon before saying so. Generous: stop, start and a health check. */
export const RESTART_POLL_TIMEOUT_MS = 90_000;

/** How often to ask. Slow enough not to hammer a booting daemon, fast enough to feel like a progress bar. */
export const RESTART_POLL_INTERVAL_MS = 2_000;

/**
 * Fold one stream event into the banner's state.
 *
 * The rule this encodes is the same one the engine card's reducer does, moved
 * one step along: **`update_exit` with `ok: true` produces no verdict.** npm
 * exiting 0 means npm wrote files; the version that landed is read off disk by
 * the daemon and arrives in `update_verified`, and even that is not the end —
 * a `restart: "pending"` verdict would be claiming a restart that has not
 * happened yet. Only the poll, or a refusal, closes this out.
 */
export function reduceSelfUpdateEvent(prev: SelfUpdateRunState, event: SelfUpdateEvent): SelfUpdateRunState {
  switch (event.type) {
    case "update_started":
      return { ...prev, phase: "installing", command: event.command, fromVersion: event.fromVersion };
    case "update_output": {
      const lines = [...prev.lines, { stream: event.stream, line: event.line }];
      return { ...prev, lines: lines.length > MAX_CONSOLE_LINES ? lines.slice(lines.length - MAX_CONSOLE_LINES) : lines };
    }
    case "update_exit":
      if (event.ok) return { ...prev, phase: "verifying", progress: "npm has finished. Checking what actually landed on disk." };
      return { ...prev, phase: "done", verdict: { tone: "error", text: event.refusal ?? `The update exited with code ${event.code}.` } };
    case "update_verified":
      if (event.restart === "pending") {
        return {
          ...prev,
          phase: "restarting",
          installedVersion: event.installedVersion,
          rollbackCommand: event.rollbackCommand,
          progress: event.summary,
        };
      }
      // `skipped` and `refused` are both "installed, and not restarted". Neither
      // is a failure and neither is what the button offered, which is exactly
      // what `warn` is for.
      return {
        ...prev,
        phase: "done",
        installedVersion: event.installedVersion,
        rollbackCommand: event.rollbackCommand,
        verdict: { tone: "warn", text: event.restartRefusal ?? event.summary },
      };
    case "update_restarting":
      return {
        ...prev,
        phase: "restarting",
        installedVersion: event.installedVersion,
        rollbackCommand: event.rollbackCommand,
        progress: `Restarting into v${event.installedVersion ?? "the new version"}. Waiting for Callboard to answer again…`,
      };
    case "update_restart_failed":
      return { ...prev, phase: "done", rollbackCommand: event.rollbackCommand, verdict: { tone: "error", text: event.refusal } };
  }
}

// ── The hook ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Own one self-update for one banner.
 *
 * The capability is fetched once on mount — it is a per-client answer the server
 * computes with a cached `npm root -g`, not something to poll — and the run is
 * driven from the POST through the stream and on into the poll that follows it.
 *
 * Nothing here is persisted across a reload, deliberately, and it is the one
 * place this feature is *less* capable than the engine installer next door:
 * reattaching would mean holding an id whose daemon is expected to be replaced,
 * and the honest recovery for "I reloaded during an update" is the version
 * printed at the top of this very page.
 */
export function useSelfUpdate(currentVersion: string): {
  status: SelfUpdateStatusResponse | null;
  run: SelfUpdateRunState | null;
  start: () => void;
} {
  const [status, setStatus] = useState<SelfUpdateStatusResponse | null>(null);
  const [run, setRun] = useState<SelfUpdateRunState | null>(null);
  const stateRef = useRef<SelfUpdateRunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  /**
   * Advance the run, keeping the ref and the state in step.
   *
   * The ref is the source of truth and is written **eagerly**, not from inside a
   * `setState` updater. The async flow below has to read the phase between
   * awaits — "did the stream end at `update_restarting`, or before it?" is the
   * question that decides whether to poll or to report a broken connection — and
   * React runs an updater when it processes the update, not when it is queued.
   * Writing the ref in there left every one of those reads a step behind.
   *
   * Safe because this is the only writer: one run at a time, guarded by
   * `runningRef`.
   */
  const apply = useCallback((next: SelfUpdateRunState | ((prev: SelfUpdateRunState) => SelfUpdateRunState)) => {
    const prev = stateRef.current;
    const resolvedNext = typeof next === "function" ? (prev ? next(prev) : prev) : next;
    stateRef.current = resolvedNext;
    setRun(resolvedNext);
  }, []);

  useEffect(() => {
    let alive = true;
    // A failure here is not worth reporting: it means the banner shows the
    // command without a button, which is exactly what it did before this
    // feature existed.
    getSelfUpdateStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // A stream left open after the tab is gone is a socket the daemon holds for
  // nothing — and the update itself is server-side and carries on regardless,
  // which is why this aborts the read rather than trying to cancel anything.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    apply({ phase: "starting", command: status?.command ?? "", fromVersion: currentVersion, lines: [], progress: "Asking the daemon to start it…" });

    void (async () => {
      try {
        const started = await startSelfUpdate();
        apply((prev) => ({ ...prev, phase: "installing", command: started.command, fromVersion: started.fromVersion }));

        try {
          await readSelfUpdateStream(started.updateId, (event) => apply((prev) => reduceSelfUpdateEvent(prev, event)), controller.signal);
        } catch (streamErr) {
          if (controller.signal.aborted) return;
          // A *successful* update kills this connection. The daemon is stopped
          // by the helper without closing the response, so the read here can
          // reject with a network error rather than resolving — which is why
          // this catch checks the phase before believing it. Reporting it as a
          // failure would put "the update could not be started" on screen at
          // the exact moment the update was working.
          if (stateRef.current?.phase !== "restarting") throw streamErr;
        }

        // The stream is over. Which of the two ways it ended is the whole
        // question: after `update_restarting` the daemon is *supposed* to have
        // stopped answering, and anywhere else means the connection went first.
        const state = stateRef.current;
        if (state?.phase === "restarting") {
          await waitForDaemon(state, apply, controller.signal);
        } else if (state && state.phase !== "done") {
          apply((prev) => ({
            ...prev,
            phase: "done",
            verdict: {
              tone: "warn",
              text: "The connection to the update stream ended before Callboard reported a result. The install may still have finished — check the version at the top of this page.",
            },
          }));
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        apply((prev) => ({
          ...prev,
          phase: "done",
          // The server puts its one-line refusal in `error`, which is what
          // `assertOk` surfaces, so this is the sentence it wrote for the user.
          verdict: { tone: "error", text: err instanceof Error ? err.message : "The update could not be started." },
        }));
      } finally {
        runningRef.current = false;
      }
    })();
  }, [apply, currentVersion, status?.command]);

  return { status, run, start };
}

/**
 * Poll until the daemon answers on the version it said it installed.
 *
 * Comparing against `installedVersion` rather than merely "different from the
 * old one" matters for the first few seconds: the *old* daemon is still serving
 * between the helper spawning and the SIGTERM landing, so an early successful
 * probe proves nothing. When the daemon could not name the installed version,
 * "anything but the version we started from" is the weaker check that remains.
 */
async function waitForDaemon(state: SelfUpdateRunState, apply: (fn: (prev: SelfUpdateRunState) => SelfUpdateRunState) => void, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;
  while (Date.now() < deadline && !signal.aborted) {
    await sleep(RESTART_POLL_INTERVAL_MS);
    if (signal.aborted) return;
    const version = await probeDaemonVersion(signal);
    const landed = version !== undefined && (state.installedVersion ? version === state.installedVersion : version !== state.fromVersion);
    if (!landed) continue;
    apply((prev) => ({
      ...prev,
      phase: "done",
      installedVersion: version,
      verdict: { tone: "ok", text: `Callboard is running v${version}. This tab is still on the old bundle — reload when you're ready.` },
    }));
    return;
  }
  if (signal.aborted) return;
  apply((prev) => ({
    ...prev,
    phase: "done",
    verdict: {
      tone: "error",
      // The one place a user genuinely needs the way back, so it is spelled out
      // rather than linked: whatever is happening, this daemon is not answering.
      text: `Callboard did not come back within ${Math.round(RESTART_POLL_TIMEOUT_MS / 1000)} seconds. It may still be starting — check \`callboard status\` and \`callboard logs\`. To return to the version you were running: \`${prev.rollbackCommand ?? `npm install -g @wolpertingerlabs/callboard@${prev.fromVersion}`}\`.`,
    },
  }));
}

// ── Rendering ───────────────────────────────────────────────────────

/** Split on backticks so a `code`-quoted path in a server sentence renders as one. */
function withInlineCode(text: string): React.ReactNode {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} style={inlineCodeStyle}>
        {part}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/**
 * The banner, driven entirely by props.
 *
 * Split from {@link UpdateBanner} so every state — including the ones that need
 * a daemon mid-restart to reach — can be rendered and asserted directly. The
 * wrapper below is the only part that talks to the network.
 */
export function UpdateBannerView({
  currentVersion,
  latestVersion,
  command,
  capability,
  run,
  onUpdate,
}: {
  currentVersion: string;
  latestVersion: string;
  /** The copy-and-paste command. Rendered in every state; see this file's header. */
  command: string;
  capability?: SelfUpdateStatusResponse["capability"];
  run: SelfUpdateRunState | null;
  onUpdate: () => void;
}) {
  const [showOutput, setShowOutput] = useState(true);
  const busy = run !== null && run.phase !== "done";
  const canUpdate = capability?.oneClick === true;

  return (
    <div role="status" aria-live="polite" data-testid="update-banner" style={bannerStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <ArrowUpCircle size={20} style={{ color: "var(--accent-text)", flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>Update available</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            v{currentVersion} → v{latestVersion}
          </div>

          {/* Never conditional. Whatever else this banner is doing, this line is
              the action a user can always take themselves. */}
          <div style={commandRowStyle}>
            <code style={{ ...inlineCodeStyle, flex: 1, minWidth: 0, overflowX: "auto", whiteSpace: "pre", background: "transparent", padding: 0 }}>{command}</code>
            <CopyButton text={command} title={`Copy: ${command}`} className="copy-btn" size={12} />
          </div>

          {canUpdate ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={onUpdate}
                disabled={busy}
                title={`Run \`${command}\` on the machine running Callboard, then restart it`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--accent)",
                  background: busy ? "var(--surface)" : "var(--accent)",
                  color: busy ? "var(--text-muted)" : "var(--text-on-accent)",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                {busy ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />}
                {busyLabel(run) ?? "Download latest & restart"}
              </button>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Installs it here and restarts the daemon. Chats and jobs must be idle for the restart.</span>
            </div>
          ) : (
            // The refusal sits directly under the command it is explaining,
            // which is the arrangement the engine cards use: the reason there is
            // no button, next to the thing to do instead.
            capability?.refusal && <div style={noteStyle}>{withInlineCode(capability.refusal)}</div>
          )}
          {canUpdate && capability?.note && <div style={noteStyle}>{withInlineCode(capability.note)}</div>}
        </div>
      </div>

      {run && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Update output</span>
            <code style={{ ...inlineCodeStyle, color: "var(--text-muted)" }}>{run.command}</code>
            {run.lines.length > 0 && (
              <button type="button" onClick={() => setShowOutput((v) => !v)} style={toggleStyle}>
                {showOutput ? "Hide" : `Show (${run.lines.length} lines)`}
              </button>
            )}
          </div>
          {run.lines.length > 0 && showOutput ? <Console lines={run.lines} phase={run.phase} /> : null}
          <Verdict run={run} />
        </div>
      )}
    </div>
  );
}

function busyLabel(run: SelfUpdateRunState | null): string | undefined {
  switch (run?.phase) {
    case "starting":
      return "Starting…";
    case "installing":
      return "Installing…";
    case "verifying":
      return "Checking…";
    case "restarting":
      return "Restarting…";
    default:
      return undefined;
  }
}

/**
 * npm's own output, unedited apart from the ANSI stripping the daemon does.
 *
 * Shown rather than summarised for the reason the install console is: a failed
 * global install explains itself in its own words far better than any sentence
 * this page could compose, and a command Callboard ran on the user's machine
 * should not be something they have to take on trust.
 */
function Console({ lines, phase }: { lines: SelfUpdateRunState["lines"]; phase: SelfUpdatePhase }) {
  const scroller = useRef<HTMLPreElement | null>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop the moment the user scrolls up to read something.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, phase]);

  return (
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
      {/* One text node rather than an element per line: npm can emit hundreds.
          stdout and stderr are not styled differently — npm writes notices to
          stderr routinely, so colouring it as a warning would invent a severity
          npm never claimed. */}
      {lines.map((l) => `${l.line}\n`).join("")}
    </pre>
  );
}

function Verdict({ run }: { run: SelfUpdateRunState }) {
  const tone = run.verdict?.tone;
  const toneColor = tone === "ok" ? "var(--success)" : tone === "error" ? "var(--danger)" : "var(--warning)";

  return (
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
            {run.progress ?? "Running on the machine hosting Callboard. Leaving this page does not stop it."}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The wired-up banner: capability from the daemon, one update at a time.
 *
 * Rendered by Settings → About only when it has already decided a newer version
 * exists, so this component never has to answer "is there an update" — only
 * "can Callboard install it here".
 */
export default function UpdateBanner({ currentVersion, latestVersion }: { currentVersion: string; latestVersion: string }) {
  const { status, run, start } = useSelfUpdate(currentVersion);
  return (
    <UpdateBannerView
      currentVersion={currentVersion}
      latestVersion={latestVersion}
      // Until the capability call answers, the command is still known: it is the
      // same one this banner has printed since long before there was a button.
      command={status?.command ?? "npm install -g @wolpertingerlabs/callboard"}
      capability={status?.capability}
      run={run}
      onUpdate={start}
    />
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const bannerStyle: CSSProperties = {
  border: "1px solid var(--accent)",
  borderRadius: 8,
  padding: "14px 20px",
  // `--accent-bg`, not the `--tint-info` this banner used to name: that token
  // does not exist in `index.css`, so the tint has silently been transparent.
  background: "var(--accent-bg)",
  marginBottom: 16,
};

const inlineCodeStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  background: "var(--surface)",
  padding: "1px 5px",
  borderRadius: 4,
  color: "var(--text)",
};

const commandRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 8,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
};

const noteStyle: CSSProperties = { color: "var(--text-muted)", fontSize: 11, lineHeight: 1.55, marginTop: 8 };

const toggleStyle: CSSProperties = {
  marginLeft: "auto",
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: 11,
  cursor: "pointer",
};
