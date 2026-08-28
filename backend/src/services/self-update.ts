/**
 * "Download the latest Callboard and restart" — the daemon upgrading itself.
 *
 * Settings → About has known about newer releases for a long time and offered a
 * command to paste into a terminal. This runs that command here instead, streams
 * npm's output, and then hands the machine to a detached helper that stops this
 * process and starts the new one. Everything below exists because each of those
 * three steps has a way of being *almost* right.
 *
 * ## Why this is not an engine install with a different id
 *
 * It shares a preflight and a child process with `engine-install.ts` — both live
 * in `npm-global-install.ts` — and nothing else. Routing Callboard through
 * `POST /api/engines/:id/install` would have meant adding it to
 * `INSTALLABLE_PACKAGES`, and then two things would be wrong rather than one:
 * `oneClickRecipeFor` selects from a registry of *engines*, and `finishSucceeded`
 * verifies an install by re-probing an **engine binary** and reporting whether a
 * chat could now run on it. Callboard is not an engine, and that verdict is not
 * merely unhelpful for it — it is a claim about the wrong thing.
 *
 * ## The gate that matters: is this daemon the copy npm would replace?
 *
 * `npm install -g @wolpertingerlabs/callboard` upgrades whatever is under
 * `npm root -g`. That is only *this* Callboard when this Callboard was installed
 * globally. Run from a git checkout — `npm run dev`, or `node
 * backend/dist/index.js` in a clone, which is how every contributor runs it —
 * the install would succeed, upgrade a different copy somewhere else, restart
 * this one from the same unchanged source, and present as "the update did
 * nothing". So {@link getSelfUpdateCapability} resolves `npm root -g`, joins the
 * package name onto it, and requires that directory to be the one this module
 * was loaded from, symlinks resolved. Failing that there is no button, and the
 * copy-and-paste command carries a sentence saying which directory Callboard is
 * actually running from.
 *
 * The second half of the same question is whether there is anything to restart.
 * `callboard start` writes `<DATA_DIR>/callboard.pid`; `callboard start
 * --foreground` and a bare `node backend/dist/index.js` write nothing, and the
 * CLI's `restart` would find no process to stop. The check is stricter than "a
 * pid file exists": it must name **this** process. A stale or foreign pid file
 * would otherwise aim a SIGTERM at something else entirely.
 *
 * ## Why the restart is a detached grandchild
 *
 * A process cannot restart itself, and a child of a dying parent is not
 * reliable: the helper's whole job runs *after* this process is gone.
 * `detached: true` puts it in its own process group so the daemon's death does
 * not reach it, `stdio: "ignore"` means it holds no descriptor of ours, and
 * `unref()` lets this event loop exit without waiting. It runs the CLI's
 * `restart`, which is `cmdStop` (SIGTERM the pid file, wait, SIGKILL if it must)
 * followed by `cmdStart` (spawn, then health-check) — exactly the sequence we
 * want, already written and already used by `POST /api/restart`.
 *
 * The helper is resolved from the **newly installed** global path, not from this
 * process's own package root, and that distinction is the point: npm replaces
 * that directory in place during the upgrade. Reading `bin/callboard.js` out of
 * the new package.json is reading the new CLI; reading it out of `__pkgRoot`
 * would be reading a path that may have been unlinked mid-upgrade.
 *
 * ## Why the restart can be refused after a successful install
 *
 * `gracefulShutdown` in `index.ts` kills in-flight agent turns. A restart during
 * a streaming chat or a mid-step job run destroys work the user is watching, so
 * {@link describeWorkInFlight} is consulted immediately before the helper is
 * spawned and the restart is declined — by name — when anything is busy. The
 * install itself is *not* gated on that: npm writing files harms nothing, and
 * refusing before it would mean an update button that does nothing while a chat
 * is open. The new version simply takes effect on the next restart, which the
 * banner says, and pressing the button again once idle is a cheap no-op install
 * followed by the restart that was deferred.
 *
 * ## No rollback, but a loud way back
 *
 * Callboard does not keep the old tarball and does not attempt to reinstate it:
 * a rollback path that has never been exercised is a second way to break a
 * machine that is already unhappy. What it does instead is record the version it
 * is replacing — in the event stream, in `<DATA_DIR>/self-update.json`, and in
 * the log at `warn` — so that a daemon which never comes back can be repaired
 * with one command the user already has in front of them.
 *
 * @see plans/self-update.md
 * @see plans/engine-availability-and-install.md — the sibling feature and its Decision 8
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SelfUpdateCapability, SelfUpdateEvent, SelfUpdateRefusalCode } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";
import { DATA_DIR } from "../utils/paths.js";
import { isInstallRunning } from "./engine-install.js";
import { listRuns } from "./job-store.js";
import { isNewerVersion } from "./npm-registry.js";
import {
  clearNpmInstallInFlight,
  getInstallCapability,
  npmInstallInFlight,
  npmSpawnRefusal,
  resetNpmRootCache,
  resolveNpmGlobalRoot,
  RunLog,
  RUN_RETENTION_MS,
  spawnNpmInstall,
} from "./npm-global-install.js";
import { sessionRegistry } from "./session-registry.js";

const log = createLogger("self-update");

/**
 * This daemon's package root — `backend/dist/services/self-update.js` up three.
 *
 * Derived here rather than passed in, unlike `buildSystemInfo`'s, because it is
 * *the* fact under test: the whole feature turns on whether this directory is
 * the one npm would overwrite, so it has to be this module's own location and
 * not a value a caller supplied.
 */
const __pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** How long a finished update stays fetchable, so a stream that reconnects still gets the transcript. */
const RETENTION_MS = RUN_RETENTION_MS;

/** The record left behind for a daemon that does not come back. */
const STATE_FILE = path.join(DATA_DIR, "self-update.json");

/** How long the last two frames get to reach the browser before the daemon is asked to die. */
const RESTART_DELAY_MS = 500;

/**
 * npm's own package-name grammar, near enough.
 *
 * The name comes from this daemon's `package.json` — never from a request — but
 * it still reaches an argv, so it is checked rather than trusted. A fork that
 * renames the package keeps working; a `package.json` carrying something that is
 * not a package name at all is refused rather than spawned.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// ── What Callboard is, according to Callboard ───────────────────────

interface SelfPackage {
  name: string;
  version: string;
  /** The CLI entry, relative to the package root, as its own `bin` field declares it. */
  bin?: string;
}

/** Read a `package.json` and keep only the three fields this feature has any business with. */
function readPackageJson(root: string): SelfPackage | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
    const name = typeof parsed?.name === "string" ? parsed.name : "";
    const version = typeof parsed?.version === "string" ? parsed.version : "";
    if (!PACKAGE_NAME.test(name) || !version) return null;
    // `bin` is either a string or a map; both forms are npm's, and Callboard's
    // own is the map. Any entry will do — the package publishes one.
    const bin = parsed?.bin;
    const rel = typeof bin === "string" ? bin : bin && typeof bin === "object" ? Object.values(bin).find((v): v is string => typeof v === "string") : undefined;
    return { name, version, ...(rel ? { bin: rel } : {}) };
  } catch {
    return null;
  }
}

/** This daemon's own identity. Read per call rather than memoized — it is cheap, and it changes under us during an upgrade. */
export function selfPackage(): SelfPackage | null {
  return readPackageJson(__pkgRoot);
}

/** The command a user would type. The button runs this same argv; the copy block never disappears. */
export function selfUpdateCommand(packageName: string): string {
  return `npm install -g ${packageName}`;
}

/**
 * `realpath`, or the path as given.
 *
 * Both sides of the install-source comparison are resolved this way because a
 * global prefix is very often reached through a symlink — nvm's `versions/node`
 * tree, Homebrew's `/usr/local`, a `~/.npm-global` someone moved — and comparing
 * the unresolved strings would refuse a daemon that genuinely *is* the global
 * copy. A path that cannot be resolved (it does not exist) falls back to itself,
 * which then simply fails the comparison.
 */
function resolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Where npm would install this package, and whether that is where this daemon is running from. */
export interface InstallSource {
  /** `<npm root -g>/<package>`, when the root resolved. */
  globalPackageRoot?: string;
  /** The directory this daemon is actually running from. */
  runningFrom: string;
  /** True when the two are the same directory, symlinks resolved. */
  isGlobalInstall: boolean;
  /** Why the global root could not be resolved, when it could not. */
  error?: string;
}

export async function resolveInstallSource(packageName: string): Promise<InstallSource> {
  const runningFrom = resolved(__pkgRoot);
  const { root, error } = await resolveNpmGlobalRoot();
  if (!root) return { runningFrom, isGlobalInstall: false, ...(error ? { error } : {}) };
  // A scoped name joins as two segments, which is exactly how npm lays it out.
  const globalPackageRoot = path.join(root, ...packageName.split("/"));
  return { globalPackageRoot, runningFrom, isGlobalInstall: resolved(globalPackageRoot) === runningFrom };
}

// ── Is there anything to restart? ───────────────────────────────────

/** The PID file `callboard start` writes, and `callboard stop` reads. */
export const PID_FILE = path.join(DATA_DIR, "callboard.pid");

/**
 * Does the PID file name **this** process?
 *
 * Not merely "does it exist". `cmdStop` SIGTERMs whatever pid it reads, so a
 * file left behind by an earlier daemon — or written by a *different* Callboard
 * sharing this data directory — would aim the restart at the wrong process, and
 * this one would carry on running the old code while something else died. The
 * daemon `callboard start` spawns is the process whose pid it records, so the
 * equality holds for every install this feature is willing to act on.
 */
export function pidFileNamesThisProcess(): boolean {
  try {
    return parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10) === process.pid;
  } catch {
    return false;
  }
}

// ── Is anything in flight? ──────────────────────────────────────────

/**
 * Work a restart would destroy, named.
 *
 * Two sources, and both are needed. The session registry holds streaming chats —
 * `gracefulShutdown` aborts those turns outright — and a job run can be mid-step
 * with no *web* session attached to it (a parallel branch, a poll step). Only
 * `running` job runs count: `waiting_approval`, `sleeping` and the other
 * non-terminal statuses are resumed by `initJobRunner` on the next boot, so a
 * restart costs them nothing.
 *
 * CLI sessions are deliberately excluded. Those are `claude` processes this
 * daemon watches rather than owns; stopping the daemon does not stop them, and
 * counting them would make the button permanently unavailable to anyone who
 * leaves a terminal open.
 */
export function describeWorkInFlight(): { busy: boolean; summary: string } {
  const chats: string[] = [];
  try {
    for (const [chatId, info] of Object.entries(sessionRegistry.getAll())) {
      if (info.type === "web") chats.push(chatId);
    }
  } catch (err) {
    log.warn(`could not read the session registry: ${err instanceof Error ? err.message : String(err)}`);
  }

  let runs: string[] = [];
  try {
    runs = listRuns({ status: "running" }).map((r) => r.title || r.jobName || r.runId);
  } catch (err) {
    // A job store that cannot be listed is not permission to restart into it.
    log.warn(`could not list job runs: ${err instanceof Error ? err.message : String(err)}`);
    return { busy: true, summary: "Callboard could not check whether any job runs are active, and it will not restart without knowing" };
  }

  if (chats.length === 0 && runs.length === 0) return { busy: false, summary: "" };

  const parts: string[] = [];
  if (chats.length > 0) parts.push(`${chats.length} chat${chats.length === 1 ? " is" : "s are"} still streaming (${chats.slice(0, 3).join(", ")}${chats.length > 3 ? ", …" : ""})`);
  if (runs.length > 0) parts.push(`${runs.length} job run${runs.length === 1 ? " is" : "s are"} mid-step (${runs.slice(0, 3).join(", ")}${runs.length > 3 ? ", …" : ""})`);
  return { busy: true, summary: parts.join(" and ") };
}

// ── Capability ──────────────────────────────────────────────────────

/**
 * May this client press "Download latest & restart", and if not, why not?
 *
 * The shared install preflight first — LAN-only, `allowEngineInstalls`, the
 * platform, a resolvable and writable global prefix — then this feature's own
 * two gates. The order is deliberate: the shared refusals are about the machine
 * and are the ones an operator can act on, while "you are running from a
 * checkout" is only interesting once everything else would have allowed it.
 *
 * Never throws. A preflight that cannot answer is a refusal, and a refusal still
 * renders the copy-and-paste command.
 */
export async function getSelfUpdateCapability(opts: { local: boolean }): Promise<SelfUpdateCapability> {
  const base = await getInstallCapability(opts);
  if (!base.oneClick) {
    return {
      oneClick: false,
      // Every code the shared preflight can produce is in this feature's union
      // too; `disabled` is the conservative default for one that is not.
      code: (base.code as SelfUpdateRefusalCode) ?? "disabled",
      refusal: base.refusal ?? "Callboard will not run installs on this machine.",
    };
  }

  const pkg = selfPackage();
  if (!pkg) {
    return {
      oneClick: false,
      code: "package-unreadable",
      refusal: `Callboard could not read its own \`package.json\` (looked in \`${__pkgRoot}\`), so it cannot tell which package to install or which version it is replacing. Run the command in a terminal instead.`,
    };
  }

  const source = await resolveInstallSource(pkg.name);
  if (!source.isGlobalInstall) {
    return {
      oneClick: false,
      code: "not-global-install",
      refusal: source.globalPackageRoot
        ? `This Callboard is running from \`${source.runningFrom}\`, which is not npm's global copy (\`${source.globalPackageRoot}\`). \`npm install -g ${pkg.name}\` would upgrade that other copy and restart this one from the same unchanged files, so Callboard will not offer it as a button. Update this checkout the way you installed it.`
        : `Callboard could not work out where npm keeps its global packages (${source.error ?? "no output"}), so it cannot confirm that it is the copy an install would replace. Run the command in a terminal instead.`,
    };
  }

  if (!pidFileNamesThisProcess()) {
    return {
      oneClick: false,
      code: "no-pid-file",
      refusal: `Callboard has no PID file naming this process (\`${PID_FILE}\`), which means it was not started by \`callboard start\` — a foreground run, or a process manager of your own. It can install the new version, but \`callboard restart\` would find nothing to stop, so the restart is yours to do. Run the command in a terminal and restart Callboard however you started it.`,
    };
  }

  return { oneClick: true, ...(base.note ? { note: base.note } : {}) };
}

// ── The run ─────────────────────────────────────────────────────────

export interface SelfUpdateRun {
  updateId: string;
  package: string;
  command: string;
  argv: readonly string[];
  fromVersion: string;
  /** `<npm root -g>/<package>` — where the new files land, and where the restart helper is read from. */
  globalPackageRoot: string;
  startedAt: number;
  finishedAt: number | null;
  log: RunLog<SelfUpdateEvent>;
  child: ChildProcess | null;
  done: boolean;
  /** The pending hand-over to the restart helper, so an abandoned run does not restart the daemon behind its back. */
  restartTimer: NodeJS.Timeout | null;
}

/**
 * One self-update at a time, process-wide — the same singleton shape
 * `engine-install.ts` uses, and for the same reason: npm's global tree has no
 * cross-process lock.
 *
 * The finished run is retained rather than cleared so a stream that connects
 * late still replays the transcript. In the ordinary case nothing ever reads it,
 * because the daemon it belongs to is gone by then; it matters for the runs that
 * *failed*, which are the ones a user needs the transcript of.
 */
let current: SelfUpdateRun | null = null;

export function isSelfUpdateRunning(): boolean {
  return current !== null && !current.done;
}

/** The id of an update currently in flight, so a second tab attaches instead of starting another. */
export function activeSelfUpdateId(): string | undefined {
  return current && !current.done ? current.updateId : undefined;
}

export function getSelfUpdateRun(updateId: string): SelfUpdateRun | null {
  if (!current || current.updateId !== updateId) return null;
  if (current.done && current.finishedAt !== null && Date.now() - current.finishedAt > RETENTION_MS) return null;
  return current;
}

export function selfUpdateRunEvents(run: SelfUpdateRun): SelfUpdateEvent[] {
  return run.log.snapshot();
}

export function isSelfUpdateRunDone(run: SelfUpdateRun): boolean {
  return run.done;
}

export function subscribeToSelfUpdateRun(run: SelfUpdateRun, listener: (event: SelfUpdateEvent) => void): () => void {
  return run.log.subscribe(listener);
}

/** Test seam: forget the retained run, and kill anything still attached to it. */
export function resetSelfUpdateState(): void {
  // The restart is scheduled rather than immediate, so abandoning a run has to
  // cancel it — otherwise a run nobody is watching any more still stops the
  // daemon half a second later.
  if (current?.restartTimer) clearTimeout(current.restartTimer);
  if (current?.child && !current.done) {
    try {
      current.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  current = null;
  clearNpmInstallInFlight();
  resetNpmRootCache();
}

// ── Starting one ────────────────────────────────────────────────────

export type StartSelfUpdateResult =
  | { ok: true; updateId: string; package: string; command: string; fromVersion: string }
  | { ok: false; code: SelfUpdateRefusalCode; refusal: string; status: number };

/**
 * The last gate before `spawn`, and the one that does not trust its caller.
 *
 * Everything here is true by construction — the argv is assembled two lines
 * above from a name this daemon read out of its own manifest — which is exactly
 * why it is asserted rather than assumed. Exported so the suite can drive it
 * with argv shapes the assembler will not produce.
 */
export function assertSelfUpdateArgv(argv: readonly string[], packageName: string): boolean {
  if (!Array.isArray(argv) || argv.length !== 4) return false;
  if (argv[0] !== "npm" || argv[1] !== "install" || argv[2] !== "-g") return false;
  if (argv[3] !== packageName) return false;
  if (!PACKAGE_NAME.test(packageName)) return false;
  return argv.every((part) => typeof part === "string" && part.length > 0);
}

/**
 * Start an update, or say why not.
 *
 * `capability` is passed in rather than recomputed, so the button the user
 * pressed and the check this makes are provably the same decision — the route
 * builds it once per request from the same {@link getSelfUpdateCapability} the
 * banner was rendered from.
 */
export function startSelfUpdate(opts: {
  capability: SelfUpdateCapability;
  /** The package and paths the capability check already resolved. Re-resolving here would be a second, possibly different, answer. */
  source: { packageName: string; fromVersion: string; globalPackageRoot: string };
  /** For the log line. Never reaches argv, a path, or a command. */
  clientKey?: string;
}): StartSelfUpdateResult {
  const { capability, source } = opts;

  if (!capability.oneClick) {
    log.warn(`refused self-update for ${opts.clientKey ?? "unknown client"}: ${capability.refusal ?? "no capability"}`);
    return {
      ok: false,
      code: capability.code ?? "disabled",
      refusal: capability.refusal ?? "Callboard will not update itself on this machine.",
      // A permission answer is 403; a machine-state answer is 422. The client
      // renders the same sentence either way — the distinction is for logs and
      // for anything that ever automates against this.
      status: capability.code === "not-local" || capability.code === "disabled" ? 403 : 422,
    };
  }

  const argv = Object.freeze(["npm", "install", "-g", source.packageName]);
  if (!assertSelfUpdateArgv(argv, source.packageName)) {
    log.error(`self-update argv failed its own assertions for package "${source.packageName}"; refusing`);
    return { ok: false, code: "package-unreadable", refusal: "Callboard will not run an install it cannot verify the shape of. Run the command in a terminal instead.", status: 500 };
  }

  if (isSelfUpdateRunning()) {
    return { ok: false, code: "busy", refusal: "Callboard is already updating itself and runs one update at a time. Watch that one, or copy the command into a terminal.", status: 409 };
  }
  if (isInstallRunning() || npmInstallInFlight()) {
    // Whichever feature got there first. `npmInstallInFlight` is the general
    // answer and `isInstallRunning` the specific one; both are asked because the
    // first is cleared the moment npm exits, while an engine install is still
    // re-probing for a few seconds after that.
    return {
      ok: false,
      code: "busy",
      refusal: `Callboard is already running ${npmInstallInFlight() ?? "an engine install"} and runs one global install at a time. Wait for it to finish, or copy the command into a terminal.`,
      status: 409,
    };
  }

  const command = selfUpdateCommand(source.packageName);
  const run: SelfUpdateRun = {
    updateId: randomUUID(),
    package: source.packageName,
    command,
    argv,
    fromVersion: source.fromVersion,
    globalPackageRoot: source.globalPackageRoot,
    startedAt: Date.now(),
    finishedAt: null,
    log: new RunLog<SelfUpdateEvent>("update_output"),
    child: null,
    done: false,
    restartTimer: null,
  };
  current = run;

  run.log.emit({
    type: "update_started",
    updateId: run.updateId,
    package: run.package,
    command: run.command,
    fromVersion: run.fromVersion,
    startedAt: new Date(run.startedAt).toISOString(),
  });

  log.info(`self-update ${run.updateId} from v${run.fromVersion} (requested by ${opts.clientKey ?? "unknown client"}): ${run.argv.join(" ")}`);
  spawnUpdate(run);

  return { ok: true, updateId: run.updateId, package: run.package, command: run.command, fromVersion: run.fromVersion };
}

// ── Running one ─────────────────────────────────────────────────────

function rollbackCommandFor(run: SelfUpdateRun): string {
  return `npm install -g ${run.package}@${run.fromVersion}`;
}

function spawnUpdate(run: SelfUpdateRun): void {
  run.child = spawnNpmInstall({
    argv: run.argv,
    label: `self-update ${run.updateId}`,
    what: "a Callboard self-update",
    isDone: () => run.done,
    onLine: (stream, line) => run.log.emit({ type: "update_output", stream, line }),
    onDone: (outcome) => {
      if (outcome.kind === "spawn-error") {
        finishFailed(run, null, null, npmSpawnRefusal(run.command, outcome.error));
        return;
      }
      const { code, signal } = outcome;
      if (code === 0) {
        finishInstalled(run);
        return;
      }
      const refusal =
        signal !== null
          ? `\`${run.command}\` was killed (${signal})${signal === "SIGKILL" ? " — it ran past Callboard's ten-minute limit" : ""}. Callboard is still running v${run.fromVersion} and has not restarted. Run the command in a terminal, where you can watch it without a timeout.`
          : `\`${run.command}\` exited with code ${code}. The output above is npm's; Callboard is still running v${run.fromVersion} and has not restarted. Run the same command in a terminal to retry it interactively.`;
      finishFailed(run, code, signal, refusal);
    },
  });
}

function finishFailed(run: SelfUpdateRun, code: number | null, signal: NodeJS.Signals | null, refusal: string): void {
  run.done = true;
  run.finishedAt = Date.now();
  run.child = null;
  resetNpmRootCache();
  log.warn(`self-update ${run.updateId} failed (code=${code}, signal=${signal}): ${refusal}`);
  run.log.emit({
    type: "update_exit",
    updateId: run.updateId,
    ok: false,
    code,
    signal,
    durationMs: run.finishedAt - run.startedAt,
    refusal,
  });
}

/**
 * npm exited 0. Now find out what is actually on disk, and whether to restart.
 *
 * The exit event goes out first and claims nothing, because "npm exited 0" and
 * "a newer Callboard is installed" are different statements — the same split
 * engine installs make. Then the version is *read from the package.json npm has
 * just rewritten*, and only that reading is allowed to name a version.
 */
function finishInstalled(run: SelfUpdateRun): void {
  run.done = true;
  run.finishedAt = Date.now();
  run.child = null;
  resetNpmRootCache();

  run.log.emit({
    type: "update_exit",
    updateId: run.updateId,
    ok: true,
    code: 0,
    signal: null,
    durationMs: run.finishedAt - run.startedAt,
  });

  const rollbackCommand = rollbackCommandFor(run);
  const installed = readPackageJson(run.globalPackageRoot);
  const installedVersion = installed?.version;
  const changed = installedVersion !== undefined && installedVersion !== run.fromVersion;

  if (!installedVersion) {
    const refusal = `\`${run.command}\` exited 0, but Callboard could not read \`${path.join(run.globalPackageRoot, "package.json")}\` afterwards, so it cannot tell what is installed — and it will not restart into a version it has not seen. Check the output above, then restart Callboard yourself with \`callboard restart\`.`;
    log.warn(`self-update ${run.updateId}: ${refusal}`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      changed: false,
      summary: refusal,
      restart: "refused",
      restartRefusal: refusal,
      rollbackCommand,
    });
    return;
  }

  if (!changed) {
    // npm found nothing newer. Restarting would kill every in-flight turn to
    // load exactly the same code, which is a cost with no benefit — and the
    // honest reading of it is that the "update available" the banner showed came
    // from a version check that has since been overtaken.
    const summary = `\`${run.command}\` finished and the installed version is still v${installedVersion} — npm had nothing newer to fetch. Callboard has not restarted, because there is nothing to restart into.`;
    log.info(`self-update ${run.updateId}: already on v${installedVersion}; no restart`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      installedVersion,
      changed: false,
      summary,
      restart: "skipped",
      rollbackCommand,
    });
    return;
  }

  // A version that moved *backwards* is not an error — `npm install -g` installs
  // whatever the registry calls latest, and a release can be unpublished or
  // deprecated out from under a cached "update available". It is worth saying,
  // because the banner promised an upgrade.
  const direction = isNewerVersion(run.fromVersion, installedVersion) ? "" : " (which is not newer than what was running — npm's `latest` has moved)";

  const work = describeWorkInFlight();
  if (work.busy) {
    const refusal = `v${installedVersion} is installed, but Callboard did not restart: ${work.summary}, and a restart stops those mid-turn. The new version takes effect the next time Callboard restarts — press this again when things are idle, or run \`callboard restart\` yourself.`;
    log.warn(`self-update ${run.updateId}: installed v${installedVersion} but did not restart — ${work.summary}`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      installedVersion,
      changed: true,
      summary: refusal,
      restart: "refused",
      restartRefusal: refusal,
      rollbackCommand,
    });
    return;
  }

  const helper = resolveRestartHelper(run.globalPackageRoot);
  if (!helper) {
    const refusal = `v${installedVersion} is installed, but Callboard could not find the \`callboard\` CLI inside \`${run.globalPackageRoot}\` to restart itself with. The new version takes effect on the next restart — run \`callboard restart\` in a terminal.`;
    log.warn(`self-update ${run.updateId}: ${refusal}`);
    run.log.emit({
      type: "update_verified",
      updateId: run.updateId,
      fromVersion: run.fromVersion,
      installedVersion,
      changed: true,
      summary: refusal,
      restart: "refused",
      restartRefusal: refusal,
      rollbackCommand,
    });
    return;
  }

  run.log.emit({
    type: "update_verified",
    updateId: run.updateId,
    fromVersion: run.fromVersion,
    installedVersion,
    changed: true,
    summary: `v${installedVersion} is installed${direction}. Restarting Callboard now — this connection will drop, and the page will reconnect on its own.`,
    restart: "pending",
    rollbackCommand,
  });

  recordUpdate(run, installedVersion);

  // Loud, in the place a user looks when the daemon does not come back: this is
  // the last line the old process writes, and `callboard logs` still shows it
  // afterwards because the new process appends to the same file.
  log.warn(`self-update ${run.updateId}: restarting into v${installedVersion} from v${run.fromVersion}. If Callboard does not come back, run: ${rollbackCommand}`);

  run.log.emit({
    type: "update_restarting",
    updateId: run.updateId,
    fromVersion: run.fromVersion,
    installedVersion,
    helper,
    rollbackCommand,
  });

  // A beat, so the two frames above reach the browser before the socket dies
  // with the process. The helper's first act is to SIGTERM this pid, and an SSE
  // frame that was written but not flushed is a client left waiting on a stream
  // that will never say anything again.
  run.restartTimer = setTimeout(() => {
    run.restartTimer = null;
    const spawned = spawnRestartHelper(helper, run.globalPackageRoot);
    if (spawned) return;
    const refusal = `v${installedVersion} is installed, but Callboard could not start the helper that restarts it. Callboard is still running v${run.fromVersion}; run \`callboard restart\` in a terminal to pick up the new version.`;
    log.error(`self-update ${run.updateId}: ${refusal}`);
    run.log.emit({ type: "update_restart_failed", updateId: run.updateId, refusal, rollbackCommand });
  }, RESTART_DELAY_MS);
}

// ── Restarting ──────────────────────────────────────────────────────

/**
 * The `callboard` CLI inside the freshly-installed package, or nothing.
 *
 * Read from the *new* package's own `bin` field, which is both more honest than
 * hardcoding `bin/callboard.js` and the only way to notice that the thing npm
 * installed is not shaped like Callboard at all. The result must live inside the
 * package root — a `bin` pointing anywhere else is not a path this daemon is
 * going to hand to `spawn`.
 */
export function resolveRestartHelper(globalPackageRoot: string): string | null {
  const pkg = readPackageJson(globalPackageRoot);
  if (!pkg?.bin) return null;
  const helper = path.resolve(globalPackageRoot, pkg.bin);
  if (helper !== globalPackageRoot && !helper.startsWith(globalPackageRoot + path.sep)) return null;
  return existsSync(helper) ? helper : null;
}

/**
 * Hand the machine over.
 *
 * `detached` is the load-bearing option: it gives the helper its own process
 * group, so the SIGTERM that this process is about to receive — and the death
 * that follows it — does not reach the thing doing the restarting. `stdio:
 * "ignore"` because there is no one left to read it (the CLI's own `cmdStart`
 * reopens the log file for the new daemon), and `unref()` so this event loop is
 * not held open by a child that will outlive it.
 *
 * `--port` is forwarded when this process has one in its environment, which is
 * how `callboard start` launches it. Without that the CLI would fall back to
 * whatever `.env` says, and a daemon started on a port that lives only in an
 * environment variable would come back on a different one — the browser would
 * poll for a server that is running perfectly well somewhere else.
 */
function spawnRestartHelper(helper: string, cwd: string): boolean {
  try {
    const port = process.env.PORT?.trim();
    const argv = port ? [helper, "restart", "--port", port] : [helper, "restart"];
    const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore", env: process.env, cwd });
    child.unref();
    log.info(`spawned restart helper ${helper} (PID ${child.pid})`);
    return true;
  } catch (err) {
    log.error(`failed to spawn restart helper: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Leave a note for the version that may not come back.
 *
 * Best-effort and deliberately tiny. The browser is told the same thing in
 * {@link SelfUpdateRestartingEvent}, but a browser can be closed, and the daemon
 * that could answer questions about this is the one being replaced. Overwritten
 * by the next update; nothing reads it automatically, which is the point — it is
 * evidence, not state.
 */
function recordUpdate(run: SelfUpdateRun, installedVersion: string): void {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          updateId: run.updateId,
          package: run.package,
          previousVersion: run.fromVersion,
          installedVersion,
          rollbackCommand: rollbackCommandFor(run),
          at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  } catch (err) {
    // Not a reason to abandon the restart: the same facts are in the log line
    // immediately below the call site and in the event stream above it.
    log.warn(`could not write ${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
