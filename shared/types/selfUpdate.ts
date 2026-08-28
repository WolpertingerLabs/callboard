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
 * this feature's own, and two of them are the interesting ones:
 *
 * - **`not-global-install`** — the daemon is running from somewhere other than
 *   npm's global directory: a git checkout, `npm run dev`, a `node
 *   backend/dist/index.js` in a clone. `npm install -g` would then upgrade a
 *   *different* copy of Callboard and the restart would appear to change
 *   nothing, which is the most confusing outcome this feature can produce. It is
 *   also the common case for anyone working on Callboard itself.
 * - **`no-pid-file`** — nothing wrote `<DATA_DIR>/callboard.pid`, so this daemon
 *   was not started by `callboard start` and there is no process the CLI's
 *   `restart` would know to stop. A `--foreground` daemon lands here.
 */
export type SelfUpdateRefusalCode =
  /** The request came from outside the LAN, or through a proxy. */
  | "not-local"
  /** `AgentSettings.allowEngineInstalls` is off — the same switch, deliberately, rather than a second one. */
  | "disabled"
  /** Callboard cannot spawn `npm` without a shell here (Windows). */
  | "unsupported-platform"
  /** `npm root -g` did not answer. */
  | "npm-unresolvable"
  /** npm's global prefix is not writable by the user running the daemon. */
  | "prefix-not-writable"
  /** This daemon is not the copy `npm install -g` would replace. */
  | "not-global-install"
  /** No PID file, so there is nothing for `callboard restart` to stop. */
  | "no-pid-file"
  /** Callboard could not read its own `package.json`, so it cannot name the package to install. */
  | "package-unreadable"
  /** An update is already running. One at a time. */
  | "busy"
  /** Work is in flight — a chat is streaming, or a job run is mid-step — and a restart would kill it. */
  | "work-in-flight"
  /** npm could not be started, or exited non-zero. */
  | "update-failed";

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
  /** True-but-survivable condition to render beside the button — the nvm prefix note, and nothing else so far. */
  note?: string;
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
  /** The version this daemon is running, from its own `package.json`. */
  version: string;
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
