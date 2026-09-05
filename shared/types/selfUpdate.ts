/**
 * Self-update — "Callboard, install your own newer version and restart".
 *
 * The shapes behind `GET /api/self-update`, `POST /api/self-update` and its SSE
 * stream. Settings → About has told users about a newer release for a long
 * time, and what it offered was a command to paste into a terminal. On a machine
 * where the daemon *is* the globally installed copy, Callboard can run that
 * command itself — and the whole design problem is that this is only true on
 * *some* machines, so every type here is built to carry the "no, and here is
 * why" case as a first-class value rather than as an absence.
 *
 * ## Why this is not an engine install
 *
 * `shared/types/engines.ts` describes a sibling feature that also runs
 * `npm install -g`, and the two share their preflight and their child-process
 * plumbing. They are still separate because their **verdicts** are different
 * claims:
 *
 * - an engine install is verified by re-probing a binary and asking whether the
 *   daemon can now see it;
 * - a self-update is verified by the daemon *going away and coming back* — and
 *   the process that could report on that is the one being replaced.
 *
 * That second point drives the event list below. The stream cannot deliver the
 * final answer: it dies with the daemon. So the last frame a client receives is
 * {@link SelfUpdateRestartingEvent}, meaning "the helper is spawned, stop
 * listening and start polling", and the success signal is the daemon answering
 * again on a *new* connection.
 *
 * ## Not part of the SSE wire surface
 *
 * These ride their own endpoint, like engine installs, so the compatibility
 * rules in `shared/types/stream.ts` do not apply and
 * `wire-surface.snapshot.json` must not move. The ordinary courtesy still does:
 * a browser tab can be running a bundle older than the daemon it is talking to,
 * so fields are added rather than repurposed.
 */

/**
 * Why Callboard will not update itself here.
 *
 * The first five are inherited verbatim from the shared install preflight (see
 * `backend/src/services/npm-global-install.ts`) — a client that may not install
 * an engine on this machine may not upgrade Callboard on it either. The rest are
 * this feature's own, and the interesting one is:
 *
 * - **`not-global-install`** — the daemon is running from somewhere other than
 *   npm's global directory: a git checkout, `npm run dev`, a `node
 *   backend/dist/index.js` in a clone. `npm install -g` would then upgrade a
 *   *different* copy of Callboard and the restart would appear to change
 *   nothing, which is the most confusing outcome this feature can produce. It is
 *   also the common case for anyone working on Callboard itself. An `npm
 *   link`ed checkout lands here too: the global entry is a symlink *to* the
 *   checkout, so the paths compare equal, but an install would replace the link
 *   with a real package and restart from a different directory than the one the
 *   daemon reported running from.
 *
 * ## What the client does with a code, and what it does not
 *
 * The banner reads `oneClick` and renders `refusal`. It never switches on
 * `code`, and it is not expected to: a refusal's whole job is to be a sentence a
 * user can act on, and a client branching on the classification would end up
 * composing a second, worse sentence from it. The server does use the code —
 * `not-local` and `disabled` answer 403 while the machine-state ones answer 422,
 * and every one of them is logged.
 *
 * That is why the codes below are not pruned down to the two that change the
 * status line. They are a published classification with a live consumer (the
 * status mapping) and a real diagnostic one (the log), and collapsing five
 * distinct machine states into one placeholder would delete information this
 * daemon itself uses. The standard the note below applies is narrower and
 * different: a code **nothing can ever emit** is a false claim about a response
 * shape. A code that is emitted, logged, and not branched on by today's one
 * client is documentation doing its job.
 */
export type SelfUpdateRefusalCode =
  /** The request came from outside the LAN, or through a proxy. Answered 403. */
  | "not-local"
  /** `AgentSettings.allowEngineInstalls` is off — the same switch, deliberately, rather than a second one. Answered 403. */
  | "disabled"
  /** Callboard cannot spawn `npm` without a shell here (Windows). */
  | "unsupported-platform"
  /** `npm root -g` did not answer. */
  | "npm-unresolvable"
  /** npm's global prefix is not writable by the user running the daemon. */
  | "prefix-not-writable"
  /** This daemon is not the copy `npm install -g` would replace. */
  | "not-global-install"
  /** Callboard could not read its own `package.json`, so it cannot name the package to install. */
  | "package-unreadable"
  /** An update or an engine install is already holding npm's global tree. One at a time. Answered 409. */
  | "busy"
  /**
   * An update finished moments ago. The same shape the engine installer uses —
   * the lock alone does not stop an authenticated LAN client driving a
   * back-to-back `npm install -g` loop. Answered 429.
   */
  | "cooling-down"
  /**
   * The stream was asked for an update this daemon is not holding — it aged out
   * of the retention window, or (much more likely, and the reason the sentence
   * says so) the update worked and this is a different process that never heard
   * of it. Answered 404.
   *
   * This was called `update-failed` and documented as "npm could not be started,
   * or exited non-zero", which described nothing that ever emitted it: a failed
   * install is an `update_exit` frame carrying npm's own account, on a stream
   * that is by definition still connected, and never a refusal code at all.
   */
  | "run-not-found";

/*
 * Deliberately absent: a `work-in-flight` code. A restart declined because a
 * chat is streaming happens *after* a successful install, so it is not a
 * refusal to start anything — it is reported as `update_verified` carrying
 * `restart: "refused"` and a `restartRefusal` naming what is busy. A code here
 * that nothing emits would be a published claim about a response shape that
 * does not exist.
 *
 * `no-pid-file` was here and has gone for the same reason, from the other
 * direction: it is no longer emitted. A daemon with no PID file naming it can
 * still *install* perfectly well, and refusing the button told that population
 * — systemd, pm2, Docker, `--foreground` — "it can install the new version,
 * but" and then offered no way to. It is now a pre-declared restart
 * disposition: `SelfUpdateCapability.restart === "unavailable"`, the button
 * appears with a note, and the run lands on `restart: "refused"` carrying the
 * same sentence.
 */

/**
 * Whether this client may press the button, evaluated per request.
 *
 * Never cached: the same daemon answers "yes" to a browser on the LAN and "no"
 * to the same browser reaching it through the remote-access tunnel a minute
 * later. `oneClick: false` is a normal answer, not an error — Settings → About
 * keeps rendering the copy-and-paste command either way and prints
 * {@link refusal} underneath it.
 */
export interface SelfUpdateCapability {
  oneClick: boolean;
  /** One line explaining why not. Always present when `oneClick` is false. */
  refusal?: string;
  /** Which gate said no. Always present when `oneClick` is false. It classifies the sentence; it never builds it. */
  code?: SelfUpdateRefusalCode;
  /**
   * True-but-survivable conditions to render beside the button — the nvm prefix
   * note, and the "the restart will be yours to run" one. Several are joined
   * into one string rather than sent as a list, because the banner renders this
   * as a sentence.
   */
  note?: string;
  /**
   * What will happen to the restart, said **before** the install rather than
   * discovered after it.
   *
   * Absent means the ordinary path: install, then restart. `"unavailable"` means
   * Callboard can install here but cannot restart itself — no PID file names
   * this process, so it was not started by `callboard start` and the CLI's
   * `restart` would find nothing to stop. That used to be a refusal
   * (`no-pid-file`), which withheld a capability in the same breath as claiming
   * it: the sentence said "it can install the new version, but" and then there
   * was no button. The run lands on `restart: "refused"` carrying the same
   * reason, so the promise made here is the one kept at the end.
   *
   * Optional and additive: a bundle that does not know this field renders the
   * note, which says the same thing in words.
   */
  restart?: "unavailable";
}

/**
 * `GET /api/self-update` — may I press it, and what would it run?
 *
 * `command` is present in every response, including the refusals, because it is
 * the fallback the whole feature degrades to. A UI that hides the command when
 * the button is unavailable has removed the only thing the user could still do.
 */
export interface SelfUpdateStatusResponse {
  capability: SelfUpdateCapability;
  /**
   * The version this daemon is **running** — its manifest as read at boot, not
   * as it stands on disk now.
   *
   * The distinction is the whole of one bug. `npm install -g` replaces the
   * package tree in place, so a read taken after npm exits describes code that
   * is not executing yet; this field reported that read, so the daemon claimed
   * to be running a version it was not, and everything computed from it — "is
   * there an update?" first among them — went wrong in the one window that
   * mattered.
   */
  version: string;
  /**
   * The version in that same package directory **right now**, when it could be
   * read.
   *
   * Normally identical to {@link version}. It differs for exactly as long as new
   * files are on disk and this process has not restarted into them: between npm
   * exiting and the restart landing, after a restart that was deferred or
   * refused, and indefinitely for a *second* daemon sharing one global install,
   * which npm upgraded without ever being asked to and which nothing will
   * restart.
   */
  installedVersion?: string;
  /**
   * `installedVersion` differs from `version` — new code is on disk and this
   * process is not running it.
   *
   * Derivable from the two fields above and sent anyway, because the daemon is
   * the one that knows both readings are trustworthy: a client comparing them
   * cannot tell "they differ" from "one of them could not be read".
   */
  restartPending?: boolean;
  /** The package name, from that same file. Never from the request. */
  package: string;
  /** The equivalent shell command — what the copy button copies, and what the button runs. */
  command: string;
  /** An update already in flight, so a second tab can attach to its stream rather than start another. */
  activeUpdateId?: string;
}

/** `POST /api/self-update`, when it starts one. */
export interface SelfUpdateStartResponse {
  updateId: string;
  package: string;
  command: string;
  /** The version being replaced. Recorded here so the client can name it in a rollback instruction later. */
  fromVersion: string;
}

/** `POST /api/self-update`, when it does not. Always carries a one-line `refusal` for the banner. */
export interface SelfUpdateRefusalResponse {
  error: string;
  refusal: string;
  code: SelfUpdateRefusalCode;
}

/** The first frame: what is about to run, and what it is replacing. */
export interface SelfUpdateStartedEvent {
  type: "update_started";
  updateId: string;
  package: string;
  command: string;
  fromVersion: string;
  startedAt: string;
}

/** One line of npm's output, verbatim apart from ANSI stripping and a length clip. */
export interface SelfUpdateOutputEvent {
  type: "update_output";
  stream: "stdout" | "stderr";
  line: string;
}

/**
 * npm is over. **Not** the user-facing verdict.
 *
 * `ok: true` means only "npm exited 0" — the same distinction engine installs
 * draw, for the same reason. What was actually installed is read off disk
 * afterwards and reported by {@link SelfUpdateVerifiedEvent}. A non-zero exit is
 * terminal and carries the `refusal` that sends the user back to the copy block.
 */
export interface SelfUpdateExitEvent {
  type: "update_exit";
  updateId: string;
  ok: boolean;
  code: number | null;
  signal: string | null;
  durationMs: number;
  /** Present exactly when `ok` is false. */
  refusal?: string;
}

/**
 * What happens to the restart, decided after the install and never before.
 *
 * - `pending` — Callboard is about to spawn the restart helper. A
 *   {@link SelfUpdateRestartingEvent} follows.
 * - `skipped` — the version on disk did not move, so there is nothing to
 *   restart into. Killing every in-flight turn to load the same code would be a
 *   cost with no benefit.
 * - `refused` — a restart would have destroyed work in flight, or the helper
 *   could not be found. The new version is installed and takes effect on the
 *   next restart; `restartRefusal` says which.
 */
export type SelfUpdateRestartDisposition = "pending" | "skipped" | "refused";

/**
 * What Callboard observed on disk after npm exited 0, and what it intends to do
 * about it.
 *
 * `installedVersion` is read from the package.json under `npm root -g` — the
 * copy npm has just rewritten — rather than assumed from the registry's answer.
 * It is optional because a file that cannot be read is a thing that happened,
 * and inventing a version there would be exactly the sort of unchecked claim
 * this codebase keeps taking out.
 */
export interface SelfUpdateVerifiedEvent {
  type: "update_verified";
  updateId: string;
  fromVersion: string;
  installedVersion?: string;
  /** Did the version on disk actually move? False means npm found nothing newer to fetch. */
  changed: boolean;
  /** One line for the banner. States what was observed, never what was assumed. */
  summary: string;
  restart: SelfUpdateRestartDisposition;
  /** Present exactly when `restart` is `"refused"` — names what is busy, or what could not be found. */
  restartRefusal?: string;
  /** `npm install -g <pkg>@<fromVersion>`. The way back, computed while the daemon is still alive to compute it. */
  rollbackCommand: string;
}

/**
 * The last frame this stream can deliver, and the client's cue to stop reading
 * it.
 *
 * The daemon is about to be stopped by a detached helper, so everything after
 * this arrives on a *new* connection: the client polls until the server answers
 * again and then reads the version it reports. A stream that simply ends is
 * therefore not an error — it is the expected shape of a successful update.
 */
export interface SelfUpdateRestartingEvent {
  type: "update_restarting";
  updateId: string;
  fromVersion: string;
  installedVersion?: string;
  /** The CLI the helper runs, resolved from the freshly-installed global path rather than from this process's own root. */
  helper: string;
  rollbackCommand: string;
}

/**
 * The helper could not be spawned — so the daemon is still here, still running
 * the old code, with the new code on disk.
 *
 * Reachable precisely because the spawn failed: had it worked, this process
 * would be gone. Terminal, and it lands on the copy block like every other
 * refusal.
 */
export interface SelfUpdateRestartFailedEvent {
  type: "update_restart_failed";
  updateId: string;
  refusal: string;
  rollbackCommand: string;
}

/** Everything `GET /api/self-update/runs/:updateId/stream` emits. */
export type SelfUpdateEvent =
  | SelfUpdateStartedEvent
  | SelfUpdateOutputEvent
  | SelfUpdateExitEvent
  | SelfUpdateVerifiedEvent
  | SelfUpdateRestartingEvent
  | SelfUpdateRestartFailedEvent;
