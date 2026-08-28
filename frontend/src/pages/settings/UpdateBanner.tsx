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
 * page can receive *when the restart works*, so the phases run
 * *installing → verifying → restarting → done*, and the transition into `done`
 * comes from **polling** a daemon that has come back on a new connection and
 * reports the version that was installed. A stream that simply ends after
 * `update_restarting` is therefore success in progress, not an error — and a
 * stream that ends *before* it is the failure case, which is why the two are
 * distinguished rather than both treated as "finished".
 *
 * One frame can still arrive after it, and only one: `update_restart_failed`.
 * It exists precisely because the helper did *not* start, which means this
 * daemon is still alive to say so — so the route keeps the response open past
 * `update_restarting` rather than closing on it.
 *
 * What *how the read ended* never tells this page is whether anything went
 * wrong. The read rejecting is the ordinary shape of success; the read
 * resolving cleanly happens on a refusal. Every classification below is made
 * from the phase.
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

/**
 * The command, before the daemon has said which package it is.
 *
 * The same string in both places it is needed — the banner's copy block and a
 * run that started before `GET /api/self-update` answered — so that a run in
 * `starting` never renders an empty `<code>` beside "Update output".
 */
const FALLBACK_COMMAND = "npm install -g @wolpertingerlabs/callboard";

/**
 * The longest an update may sit in `installing`/`verifying` before this page
 * stops believing in it.
 *
 * The daemon kills npm at ten minutes, so a stream that has said nothing
 * conclusive past that is not waiting on npm any more — it is a socket that
 * stopped delivering. Without a bound, a reverse proxy that buffers, a
 * half-open TCP connection or a lost FIN leaves the phase where it is forever,
 * with the button disabled and no way out but a reload that discards the run.
 *
 * It *does* span the restart phase — the response is deliberately kept open past
 * `update_restarting` so that `update_restart_failed` can still be delivered, so
 * this timer is still armed there. What used to say otherwise was a comment, not
 * a mechanism, and the mechanism did the wrong thing: firing during `restarting`
 * reported "Callboard stopped reporting on this update 11 minutes ago" for a
 * daemon that was restarting exactly as designed, instead of running the poll
 * that is the only way this page can learn the restart worked. So expiry no
 * longer decides anything on its own — the phase does, as everywhere else in
 * this file, and expiring in `restarting` hands over to
 * {@link RESTART_POLL_TIMEOUT_MS} like an ordinary stream ending would.
 */
export const RUN_DEADLINE_MS = 11 * 60_000;

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
 * ## Reattaching, and the one case it does not cover
 *
 * `Settings.tsx` unmounts the About tab when the user switches tabs, so a
 * component remount during a live update is not exotic — it is one click. The
 * old behaviour was to come back to an idle banner with an enabled button, over
 * a daemon that was still installing and might restart with nothing on screen;
 * pressing that button 409'd with "already updating" on a page showing no
 * update. So `GET /api/self-update` reports `activeUpdateId`, the stream route
 * replays the whole transcript on connect, and mounting with one in hand
 * attaches to it.
 *
 * That is *not* the page-reload case `plans/self-update.md` declines to
 * support, and the distinction is which process is expected to survive. Here it
 * is the same daemon and the same page, and the id is one the daemon just
 * handed over. There it is a new bundle asking a daemon that has been replaced
 * about a run its predecessor was serving, and the honest answer really is the
 * version printed at the top of this page.
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
    // A functional update with nothing to update is dropped, not applied to
    // `null` and written back — which is what this used to do, quietly turning
    // a live run into no run at all. It should be unreachable (the functional
    // form is only used once a run exists), and keeping the old state is the
    // failure that loses nothing if it ever becomes reachable.
    if (typeof next === "function" && !prev) return;
    const resolvedNext = typeof next === "function" ? next(prev as SelfUpdateRunState) : next;
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

  /**
   * Follow an update that is already running: its stream, then whatever the
   * stream's ending turns out to have meant.
   *
   * Shared by the button and by the reattach below, because "watch this
   * updateId" is the same job whether this page started it or found it.
   */
  const follow = useCallback(
    async (updateId: string, controller: AbortController, fallbackPackage: string | undefined) => {
      // See {@link RUN_DEADLINE_MS}. Aborting the read is the only way to get
      // out of a socket that has stopped delivering without also stopping the
      // update, which is server-side and carries on either way.
      //
      // The deadline aborts a controller of its own rather than the caller's.
      // They mean different things — "stop reading this socket" and "this
      // component is gone" — and collapsing them cost the restart poll: the
      // deadline firing left `controller.signal.aborted` true, so the poll below
      // returned instantly on a signal that was never about unmounting. The
      // caller's abort still propagates inward, which is the direction that has
      // to work.
      const readController = new AbortController();
      const relayAbort = () => readController.abort();
      if (controller.signal.aborted) readController.abort();
      else controller.signal.addEventListener("abort", relayAbort, { once: true });

      let expired = false;
      const deadline = setTimeout(() => {
        expired = true;
        readController.abort();
      }, RUN_DEADLINE_MS);

      try {
        await readSelfUpdateStream(updateId, (event) => apply((prev) => reduceSelfUpdateEvent(prev, event)), readController.signal);
      } catch {
        // Swallowed on purpose, and this is the correction that matters most in
        // this file: *how the read ended* is not evidence of anything, because
        // a successful update kills the connection without closing the
        // response. The phase below is the evidence. Rethrowing here — which is
        // what this did unless the phase was exactly `restarting` — put a raw
        // "Failed to fetch" on screen as the entire account of a global npm
        // install running on the user's machine, for every Wi-Fi drop, laptop
        // sleep and SIGKILLed daemon.
      } finally {
        clearTimeout(deadline);
        controller.signal.removeEventListener("abort", relayAbort);
      }

      if (controller.signal.aborted) return;

      // The stream is over. Which of the ways it ended is the whole question:
      // after `update_restarting` the daemon is *supposed* to have stopped
      // answering, and anywhere else means the connection went first.
      //
      // The phase is asked *before* `expired`, deliberately. A run that reached
      // `restarting` and then sat on a socket for eleven minutes is a restart
      // this page has not witnessed the end of, not an update that went missing
      // — and the only instrument that can tell the difference is the poll.
      // Answering it with "Callboard stopped reporting 11 minutes ago" reported
      // a failure while skipping the one check that could have found the
      // success.
      const state = stateRef.current;
      if (state?.phase === "restarting") {
        await waitForDaemon(state, apply, controller.signal, fallbackPackage);
      } else if (expired) {
        apply((prev) => ({
          ...prev,
          phase: "done",
          verdict: {
            tone: "warn",
            text: `Callboard stopped reporting on this update ${Math.round(RUN_DEADLINE_MS / 60_000)} minutes ago, so this page has given up following it. The install may still have finished — check the version at the top of this page, and \`callboard logs\` on the machine running Callboard.`,
          },
        }));
      } else if (state && state.phase !== "done") {
        // Not `done`, deliberately. A socket error arriving after a terminal
        // frame — an `update_exit` carrying npm's own refusal, say — must not
        // overwrite that account with this vaguer one.
        apply((prev) => ({
          ...prev,
          phase: "done",
          verdict: {
            tone: "warn",
            text: "The connection to the update stream ended before Callboard reported a result. The install may still have finished — check the version at the top of this page.",
          },
        }));
      }
    },
    [apply],
  );

  const start = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    apply({ phase: "starting", command: status?.command ?? FALLBACK_COMMAND, fromVersion: currentVersion, lines: [], progress: "Asking the daemon to start it…" });

    void (async () => {
      try {
        const started = await startSelfUpdate();
        if (controller.signal.aborted) return;
        apply((prev) => ({ ...prev, phase: "installing", command: started.command, fromVersion: started.fromVersion }));
        await follow(started.updateId, controller, started.package);
      } catch (err) {
        if (controller.signal.aborted) return;
        // Reached only by the POST failing, now that the stream read is
        // classified by phase rather than by exception. Here `err.message`
        // really is the server's one-line refusal — `assertOk` puts the
        // `error` field in it — which is why this one is rendered raw.
        apply((prev) => ({
          ...prev,
          phase: "done",
          verdict: { tone: "error", text: err instanceof Error ? err.message : "The update could not be started." },
        }));
      } finally {
        runningRef.current = false;
      }
    })();
  }, [apply, currentVersion, follow, status?.command]);

  // Attach to an update this page did not start. See the hook's header for why
  // this is the tab-switch case and not the page-reload one.
  const activeUpdateId = status?.activeUpdateId;
  const statusCommand = status?.command;
  const statusPackage = status?.package;
  useEffect(() => {
    if (!activeUpdateId || runningRef.current || stateRef.current) return;
    runningRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Seeded at `installing` rather than `starting`: there is nothing to ask
    // for. The transcript the stream replays on connect immediately overwrites
    // the command and the version with what the run actually holds.
    apply({
      phase: "installing",
      command: statusCommand ?? FALLBACK_COMMAND,
      fromVersion: currentVersion,
      lines: [],
      progress: "Attaching to an update that was already running…",
    });

    void follow(activeUpdateId, controller, statusPackage).finally(() => {
      runningRef.current = false;
    });
  }, [activeUpdateId, apply, currentVersion, follow, statusCommand, statusPackage]);

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
 *
 * That first paragraph was a false claim about a real hazard until the daemon
 * had a boot version. `probeDaemonVersion` reads `system-info.version`, and that
 * used to be a per-request read of a `package.json` npm had *already* replaced —
 * so the old daemon answered with the new version, and this comparison matched
 * on the very first tick, before the restart had begun. The guard is the field's
 * meaning, not the choice of comparison: `version` is now the version the
 * answering process booted on, so an early probe of the old daemon returns the
 * old version and this correctly keeps waiting. Comparing against
 * `installedVersion` is still the stronger of the two checks and is still worth
 * preferring — it just is not what was holding the line.
 */
async function waitForDaemon(
  state: SelfUpdateRunState,
  apply: (fn: (prev: SelfUpdateRunState) => SelfUpdateRunState) => void,
  signal: AbortSignal,
  /** The package the daemon named, for the one message that has to compose a rollback command itself. */
  fallbackPackage: string | undefined,
): Promise<void> {
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
      //
      // The package name in the fallback comes from the daemon's own manifest
      // via `GET /api/self-update`, not from a literal here — a fork or a
      // rename would otherwise be told to reinstall the upstream package.
      text: `Callboard did not come back within ${Math.round(RESTART_POLL_TIMEOUT_MS / 1000)} seconds. It may still be starting — check \`callboard status\` and \`callboard logs\`. To return to the version you were running: \`${prev.rollbackCommand ?? `npm install -g ${fallbackPackage ?? "@wolpertingerlabs/callboard"}@${prev.fromVersion}`}\`.`,
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
  installedVersion,
  restartPending,
  command,
  capability,
  run,
  onUpdate,
}: {
  /** The version the daemon is **running** — its boot manifest, not what is on disk. */
  currentVersion: string;
  /** npm's `latest`, when the registry answered. Absent is a normal state: a restart can be pending with no newer release. */
  latestVersion?: string;
  /** What is in the daemon's package directory now, when that differs from what it is running. */
  installedVersion?: string;
  /**
   * New code is on disk and the daemon has not restarted into it.
   *
   * A headline rather than a footnote, because it is the *only* thing on screen
   * for a daemon whose files a sibling replaced: same global install, different
   * data directory and port, upgraded without being asked and with nothing to
   * restart it.
   */
  restartPending?: boolean;
  /** The copy-and-paste command. Rendered in every state; see this file's header. */
  command: string;
  capability?: SelfUpdateStatusResponse["capability"];
  run: SelfUpdateRunState | null;
  onUpdate: () => void;
}) {
  const [showOutput, setShowOutput] = useState(true);
  const busy = run !== null && run.phase !== "done";
  const canUpdate = capability?.oneClick === true;
  // A restart that is already owed takes the headline: telling someone about a
  // release they could download is less useful than telling them the download
  // already happened and is not what is running. Not while a run is on screen —
  // that has its own progress line and its own verdict.
  const leadWithRestart = restartPending === true && !busy;

  return (
    <div role="status" aria-live="polite" data-testid="update-banner" style={bannerStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <ArrowUpCircle size={20} style={{ color: "var(--accent-text)", flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{leadWithRestart ? "Restart pending" : "Update available"}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {leadWithRestart
              ? `Running v${currentVersion}${installedVersion ? `, but v${installedVersion} is installed on disk` : ", and newer files are installed on disk"}. Callboard picks it up on the next restart.`
              : `v${currentVersion}${latestVersion ? ` → v${latestVersion}` : ""}`}
          </div>
          {leadWithRestart && (
            // Said outright rather than left to be worked out, because the way
            // to reach this state that nobody expects is the one a single
            // process cannot see from the inside.
            <div style={noteStyle}>
              A restart may have been deferred — or a second Callboard sharing this same global install updated itself. npm replaces the package files in place, so both daemons got the new
              files and only the one that pressed the button was restarted.
            </div>
          )}

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
                {/* The label states what will happen, so a daemon that has
                    already said it cannot restart itself does not offer a
                    button promising one. */}
                {busyLabel(run) ?? (capability?.restart === "unavailable" ? "Download latest" : "Download latest & restart")}
              </button>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {capability?.restart === "unavailable"
                  ? "Installs it here. Restarting Callboard is yours to do — see below."
                  : "Installs it here and restarts the daemon. Chats and jobs must be idle for the restart."}
              </span>
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
            {/* Conditional only for the tick before the POST answers: an empty
                `<code>` is a stray grey box beside the heading. */}
            {run.command && <code style={{ ...inlineCodeStyle, color: "var(--text-muted)" }}>{run.command}</code>}
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
export default function UpdateBanner({
  currentVersion,
  latestVersion,
  installedVersion,
  restartPending,
}: {
  currentVersion: string;
  latestVersion?: string;
  installedVersion?: string;
  restartPending?: boolean;
}) {
  const { status, run, start } = useSelfUpdate(currentVersion);
  return (
    <UpdateBannerView
      currentVersion={currentVersion}
      latestVersion={latestVersion}
      // `GET /api/self-update` is the fresher of the two answers — About's
      // system-info call happens once on mount, and an install started since
      // then would have moved these. Falls back to what the page was rendered
      // with, so the banner never loses the reason it exists while that request
      // is in flight.
      installedVersion={status?.installedVersion ?? installedVersion}
      // Not `??`: the daemon omits `restartPending` rather than sending `false`,
      // so a `??` chain reads "no restart pending" as "no answer" and falls back
      // to the prop — able to set the flag from the fresher answer but never to
      // clear it. Once `status` has arrived it is the answer, absent field and all.
      restartPending={status ? status.restartPending === true : restartPending}
      // Until the capability call answers, the command is still known: it is the
      // same one this banner has printed since long before there was a button.
      command={status?.command ?? FALLBACK_COMMAND}
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
