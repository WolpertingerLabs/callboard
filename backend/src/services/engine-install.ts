/**
 * Running an engine's install recipe because a user asked for it.
 *
 * Phase 3 of `plans/engine-availability-and-install.md`. Everything before it
 * described the machine; this changes it, on a daemon whose own Remote Access
 * feature can put it on the public internet with a password as the only barrier.
 * The design is therefore built around *not* being an arbitrary-command surface,
 * and around never claiming more than was observed.
 *
 * The preflight, the child-process discipline and the replay buffer live in
 * `npm-global-install.ts` — this module owns the *engine* half: which recipe an
 * id selects, and what a zero exit is allowed to claim about an engine
 * afterwards. `self-update.ts` is its sibling on the same core and deliberately
 * not a recipe in here; see that module for why.
 *
 * ## What can be run, and how the request reaches it
 *
 * Nothing from the request enters argv. `POST /api/engines/:id/install` passes an
 * engine id, that id **selects** a recipe through
 * {@link oneClickRecipeFor} — which checks method, allowlist membership, argv
 * shape and `visibleAfterRecheck` against the static registry — and the argv
 * that gets spawned is the frozen literal array from
 * `engine-install-recipes.ts`. An unknown id selects nothing and is refused. The
 * id is never interpolated into a string, there is no shell
 * (`spawn(..., { shell: false })`), and `script` recipes carry no argv at all,
 * so a `curl … | bash` installer cannot be reached from here even by mistake
 * (Decision 5).
 *
 * {@link assertSpawnable} re-checks all of it immediately before spawning, so
 * the guarantee does not depend on the caller having asked correctly.
 *
 * ## Who can run it
 *
 * Auth is inherited from `requireAuth`. On top of that, and checked by the
 * routes before anything here is reached:
 *
 * - **loopback/LAN only, with no proxy in between** (`utils/client-ip.ts`'s
 *   `isDirectLocalClient`): the socket's own peer address must be local *and*
 *   the request must carry no forwarding header at all. A client arriving
 *   through the remote-access tunnel gets the copy-command instead —
 *   "authenticated" is not a strong enough answer for command execution on a
 *   box that may be internet-facing.
 * - **`AgentSettings.allowEngineInstalls`**, default on, so an operator can
 *   remove the capability entirely.
 *
 * Both, plus the preflight below, are folded into one
 * {@link EngineInstallCapability} that is *also* what the status card reads, so
 * a client sees a button in the states where that client's capability permits
 * one.
 *
 * That is a claim about *capability*, and it is deliberately narrower than "the
 * button always works". A pressed button can still be refused, and two of those
 * are ordinary rather than exotic: `busy` (409) whenever a second tab presses
 * Install while one is running, and any capability that changed between the GET
 * that rendered the card and the POST — widened by the {@link NPM_ROOT_TTL_MS}
 * cache on `npm root -g`. What holds without qualification is the *user-facing*
 * half of Decision 8: every refusal, expected or not, returns a one-line
 * `refusal` and lands under a copy-and-paste command that was never removed.
 *
 * ## Why the preflight exists
 *
 * `npm install -g` under a global prefix the daemon's user cannot write produces
 * an EACCES wall of text and no install. That is the common failure on a
 * system-wide Node, and it is predictable from `npm root -g` plus an `access()`
 * check on **both** directories npm writes to — the package root
 * `<prefix>/lib/node_modules` and the bin directory `<prefix>/bin`. Checking
 * only the first is not enough: a user-owned `~/.npm-global` whose `bin/` was
 * created by an earlier `sudo npm i -g` fails on the second, which is a shape
 * that occurs in the wild and was reproduced. Both are checked, before
 * spawning, and the refusal lands on the same copy block the button sits next
 * to.
 *
 * ## Why a zero exit is not a success message
 *
 * `npm install -g` exiting 0 means npm wrote files. It does **not** mean
 * Callboard can see them: the global bin directory may not be on the PATH this
 * daemon inherited, and under nvm the prefix belongs to one Node version. So the
 * process exit and the verdict are separate events — {@link EngineInstallExitEvent}
 * carries no summary at all on success, and only the {@link EngineInstallVerifiedEvent}
 * that follows a *re-probe* may say an engine is installed. When the re-probe
 * still cannot find it, that is a refusal with a reason, not a tick.
 *
 * @see plans/engine-availability-and-install.md — Phase 3, Decisions 4, 5, 7, 8
 */
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  EngineInstallCapability,
  EngineInstallEvent,
  EngineInstallRecipe,
  EngineInstallRefusalCode,
  EngineStatus,
} from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";
import { INSTALLABLE_PACKAGES, oneClickRecipeFor } from "./engine-install-recipes.js";
import { MIN_REFRESH_INTERVAL_MS, refreshEngineStatuses } from "./engine-status.js";
import {
  clearNpmInstallInFlight,
  INSTALL_TIMEOUT_MS,
  npmInstallInFlight,
  npmSpawnRefusal,
  resetNpmRootCache,
  RunLog,
  RUN_RETENTION_MS,
  spawnNpmInstall,
} from "./npm-global-install.js";

const log = createLogger("engine-install");

export { INSTALL_TIMEOUT_MS };

/**
 * The preflight, re-exported rather than reimplemented.
 *
 * It moved to `npm-global-install.ts` when the self-update feature needed the
 * same gates, and it is re-exported here because the routes and the tests ask
 * this module the question "may this client install an engine?" — which is
 * still where that question belongs, even though the answer is now computed
 * next door.
 */
export { getInstallCapability } from "./npm-global-install.js";

/** Forget the cached `npm root -g`. Called after every install, so a prefix that appeared mid-session is seen. */
export function resetEngineInstallCaches(): void {
  resetNpmRootCache();
}

// ── The run ─────────────────────────────────────────────────────────

export interface InstallRun {
  installId: string;
  engineId: string;
  package: string;
  command: string;
  argv: readonly string[];
  capability: EngineInstallCapability;
  startedAt: number;
  finishedAt: number | null;
  log: RunLog<EngineInstallEvent>;
  child: ChildProcess | null;
  done: boolean;
}

/**
 * One install at a time, process-wide.
 *
 * A module-level singleton, the shape `web-tunnel.ts`'s supervisor already uses.
 * Two concurrent `npm install -g` runs against one global prefix are a genuine
 * hazard rather than merely wasteful — npm's global tree has no cross-process
 * lock — and serialising also bounds the whole endpoint's cost to one child
 * process however many tabs are open.
 *
 * The finished run stays here rather than being cleared, so a stream that
 * connects late (or reconnects) still replays the transcript and the verdict.
 * It is replaced by the next install, or dropped after {@link RUN_RETENTION_MS}.
 */
let current: InstallRun | null = null;

/** True while a child process is alive. The `busy` gate. */
export function isInstallRunning(): boolean {
  return current !== null && !current.done;
}

/** The run with this id, if it is still the one being retained. */
export function getInstallRun(installId: string): InstallRun | null {
  if (!current || current.installId !== installId) return null;
  if (current.done && current.finishedAt !== null && Date.now() - current.finishedAt > RUN_RETENTION_MS) return null;
  return current;
}

/** Every event this run has emitted so far, for replay on connect. */
export function installRunEvents(run: InstallRun): EngineInstallEvent[] {
  return run.log.snapshot();
}

export function isInstallRunDone(run: InstallRun): boolean {
  return run.done;
}

export function subscribeToInstallRun(run: InstallRun, listener: (event: EngineInstallEvent) => void): () => void {
  return run.log.subscribe(listener);
}

/** Test seam: forget the retained run so the next start is not refused as busy. */
export function resetEngineInstallState(): void {
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

export type StartInstallResult =
  | { ok: true; installId: string; engineId: string; package: string; command: string }
  | { ok: false; code: EngineInstallRefusalCode; refusal: string; status: number };

/**
 * The last gate before `spawn`, and the one that does not trust its caller.
 *
 * Everything here is already true by construction of the registry — which is why
 * it is asserted rather than computed. If any of it is false, the registry has
 * been edited into a shape the security argument does not cover, and the correct
 * behaviour is to run nothing at all.
 *
 * It is therefore **unreachable in production**, which is exactly what makes it
 * easy to delete by accident: removing it changes no observable behaviour
 * against the committed registry. Exported so `engine-install.test.ts` can drive
 * it with the hand-built recipes the registry will not produce — that suite
 * fails to import if this function goes away, which is the point of having it.
 */
export function assertSpawnable(recipe: EngineInstallRecipe): { argv: readonly string[]; package: string } | null {
  if (recipe.method !== "npm-global") return null;
  if (!recipe.package || !INSTALLABLE_PACKAGES.has(recipe.package)) return null;
  const argv = recipe.argv;
  if (!Array.isArray(argv) || argv.length !== 4) return null;
  if (argv[0] !== "npm" || argv[1] !== "install" || argv[2] !== "-g") return null;
  if (argv[3] !== recipe.package) return null;
  if (argv.some((part) => typeof part !== "string" || part.length === 0)) return null;
  return { argv, package: recipe.package };
}

/**
 * Start an install, or say why not.
 *
 * `capability` is passed in rather than recomputed so that the button the user
 * pressed and the check this makes are provably the same decision — the routes
 * build it once per request from the same {@link getInstallCapability} the
 * status card was rendered from.
 */
export function startEngineInstall(opts: {
  engineId: string;
  capability: EngineInstallCapability;
  /** For the log line. Never reaches argv, a path, or a command. */
  clientKey?: string;
}): StartInstallResult {
  const { engineId, capability } = opts;

  if (!capability.oneClick) {
    log.warn(`refused install of "${engineId}" for ${opts.clientKey ?? "unknown client"}: ${capability.refusal ?? "no capability"}`);
    return {
      ok: false,
      code: capability.code ?? "disabled",
      refusal: capability.refusal ?? "Callboard will not run this install on this machine.",
      status: capability.code === "prefix-not-writable" || capability.code === "npm-unresolvable" ? 422 : 403,
    };
  }

  const recipe = oneClickRecipeFor(engineId);
  if (!recipe) {
    return {
      ok: false,
      code: "no-recipe",
      refusal:
        "Callboard has no install for this engine that it can run itself. Bundled engines ship inside Callboard and a global install of them would be inert; vendor install scripts are copy-only by design.",
      status: 404,
    };
  }

  const spawnable = assertSpawnable(recipe);
  if (!spawnable) {
    // Unreachable against the committed registry — `engine-install.test.ts`
    // proves both directions — so reaching it means the registry no longer
    // matches the shape the allowlist argument assumes.
    log.error(`install recipe for "${engineId}" failed its own spawn assertions; refusing`);
    return { ok: false, code: "no-recipe", refusal: "Callboard's install registry is not in a state it is willing to execute. Copy the command into a terminal instead.", status: 500 };
  }

  if (isInstallRunning()) {
    return {
      ok: false,
      code: "busy",
      refusal: `Callboard is already installing ${current?.package ?? "another engine"} and runs one install at a time. Wait for it to finish, or copy the command into a terminal.`,
      status: 409,
    };
  }

  // The other direction of the same lock, and it is not symmetric by accident:
  // `isInstallRunning` only knows about *this* module's runs, so without this
  // an engine install would start while a self-update's npm is part-way through
  // rewriting the global tree — including this daemon's own package directory,
  // which `resolveRestartHelper` then reads out of. Two `npm install -g` runs
  // against one prefix have no cross-process lock to fall back on.
  const other = npmInstallInFlight();
  if (other) {
    return {
      ok: false,
      code: "busy",
      refusal: `Callboard is already running ${other} and runs one global install at a time. Wait for it to finish, or copy the command into a terminal.`,
      status: 409,
    };
  }

  // The cooldown, and why an accepted install needs one at all.
  //
  // Every completed install ends in `refreshEngineStatuses({ force: true })` —
  // deliberately, because verifying against a cached probe is how a success
  // message gets asserted on evidence that predates the install. But `force`
  // bypasses the minimum interval Phase 2 added for a measured reason: a probe
  // drops five caches and pays for a `which` per engine, two synchronous
  // `--version` spawns and an Agent SDK query.
  //
  // A warm repeat install cycle is roughly four seconds, so an authenticated LAN
  // client looping the endpoint drove a forced full re-probe every ~4s — under
  // the 10s bound, through a door this feature opened. Refusing here restores
  // that bound at its source: at most one accepted install, and therefore at
  // most one forced probe, per {@link MIN_REFRESH_INTERVAL_MS}.
  //
  // Measured from the previous install's *completion*, so a user installing two
  // engines back to back waits at most that long and is told why. That cost is
  // real and is the reason this is not longer.
  const sinceLast = current?.finishedAt ? Date.now() - current.finishedAt : Infinity;
  if (sinceLast < MIN_REFRESH_INTERVAL_MS) {
    const waitSeconds = Math.max(1, Math.ceil((MIN_REFRESH_INTERVAL_MS - sinceLast) / 1000));
    return {
      ok: false,
      code: "cooling-down",
      refusal: `Callboard re-checks every engine after an install, and that is rate-limited — it just finished one. Try again in ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}, or copy the command into a terminal.`,
      status: 429,
    };
  }

  const run: InstallRun = {
    installId: randomUUID(),
    engineId,
    package: spawnable.package,
    command: recipe.command,
    argv: spawnable.argv,
    capability,
    startedAt: Date.now(),
    finishedAt: null,
    // `install_output` is the droppable frame: the started/exit/verified ones
    // are structural, and a transcript that has aged out its own header is not
    // a transcript.
    log: new RunLog<EngineInstallEvent>("install_output"),
    child: null,
    done: false,
  };
  current = run;

  emit(run, {
    type: "install_started",
    installId: run.installId,
    engineId: run.engineId,
    package: run.package,
    command: run.command,
    startedAt: new Date(run.startedAt).toISOString(),
  });

  log.info(`installing ${run.package} for engine "${run.engineId}" (install ${run.installId}, requested by ${opts.clientKey ?? "unknown client"}): ${run.argv.join(" ")}`);
  spawnInstall(run);

  return { ok: true, installId: run.installId, engineId: run.engineId, package: run.package, command: run.command };
}

// ── Running one ─────────────────────────────────────────────────────

function emit(run: InstallRun, event: EngineInstallEvent): void {
  run.log.emit(event);
}

/**
 * Hand the argv to the shared runner and translate its outcome into this
 * feature's sentences.
 *
 * The wording is deliberately not shared: "Callboard has not changed anything
 * about this engine" is a claim about an engine, and the self-update's
 * equivalent is a claim about the daemon. Only the mechanics are common.
 */
function spawnInstall(run: InstallRun): void {
  run.child = spawnNpmInstall({
    argv: run.argv,
    label: `install ${run.installId}`,
    what: `an install of ${run.package}`,
    isDone: () => run.done,
    onLine: (stream, line) => emit(run, { type: "install_output", stream, line }),
    onDone: (outcome) => {
      if (outcome.kind === "spawn-error") {
        finishFailed(run, null, null, npmSpawnRefusal(run.command, outcome.error));
        return;
      }
      const { code, signal } = outcome;
      if (code === 0) {
        void finishSucceeded(run);
        return;
      }
      const killed = signal !== null;
      const refusal = killed
        ? `\`${run.command}\` was killed (${signal})${signal === "SIGKILL" ? " — it ran past Callboard's ten-minute limit" : ""}. Nothing was installed as far as Callboard can tell. Run the command in a terminal, where you can watch it without a timeout.`
        : `\`${run.command}\` exited with code ${code}. The output above is npm's; Callboard has not changed anything about this engine. Run the same command in a terminal to retry it interactively.`;
      finishFailed(run, code, signal, refusal);
    },
  });
}

function finishFailed(run: InstallRun, code: number | null, signal: NodeJS.Signals | null, refusal: string): void {
  run.done = true;
  run.finishedAt = Date.now();
  run.child = null;
  resetEngineInstallCaches();
  log.warn(`install ${run.installId} of ${run.package} failed (code=${code}, signal=${signal}): ${refusal}`);
  emit(run, {
    type: "install_exit",
    installId: run.installId,
    engineId: run.engineId,
    ok: false,
    code,
    signal,
    durationMs: run.finishedAt - run.startedAt,
    refusal,
  });
}

/**
 * npm exited 0. Now find out whether that means anything.
 *
 * The exit event goes out first and says nothing about the engine — deliberately,
 * because "exited 0" and "installed" are different claims and the gap between
 * them is the failure this whole feature keeps producing. Then the server runs
 * the Phase-2 refresh **itself**, forced past the throttle, and reports what it
 * found. Only that second event is allowed to use the word installed.
 */
async function finishSucceeded(run: InstallRun): Promise<void> {
  run.done = true;
  run.finishedAt = Date.now();
  run.child = null;
  resetEngineInstallCaches();
  log.info(`install ${run.installId} of ${run.package} exited 0 after ${run.finishedAt - run.startedAt}ms; re-probing`);

  emit(run, {
    type: "install_exit",
    installId: run.installId,
    engineId: run.engineId,
    ok: true,
    code: 0,
    signal: null,
    durationMs: run.finishedAt - run.startedAt,
  });

  let engines: EngineStatus[] = [];
  let refreshError: string | undefined;
  try {
    // Forced: a warm npm cache can finish an install inside the refresh
    // throttle's window, and verifying against statuses probed before the
    // install ran is exactly the "success message on stale evidence" bug.
    const result = await refreshEngineStatuses({ capability: run.capability, force: true });
    engines = result.engines;
  } catch (err) {
    refreshError = err instanceof Error ? err.message : String(err);
  }

  const engine = engines.find((e) => e.id === run.engineId);

  if (refreshError || !engine) {
    const refusal = refreshError
      ? `\`${run.command}\` exited 0, but Callboard could not re-check the engine afterwards (${refreshError}), so it cannot confirm the install landed. Press Recheck, or run the command in a terminal to see for yourself.`
      : `\`${run.command}\` exited 0, but Callboard could not find this engine when it looked again, so it cannot confirm anything about the install.`;
    log.warn(`install ${run.installId}: ${refusal}`);
    emit(run, {
      type: "install_verified",
      installId: run.installId,
      engineId: run.engineId,
      visible: false,
      summary: refusal,
      refusal,
      engines,
    });
    return;
  }

  const path = observedPath(engine);
  const cli = cliName(engine);

  if (!path) {
    // The install genuinely succeeded and the daemon genuinely cannot see it.
    // This is the nvm / PATH-inheritance case, and it is the single most
    // confusing outcome this feature can produce — so it is stated in full
    // rather than smoothed into a tick.
    const refusal = `\`${run.command}\` exited 0, but Callboard still finds no \`${cli}\` on the PATH its daemon inherited. npm installed it somewhere this process cannot see — usually a global bin directory that was not on PATH when Callboard started, or (under nvm) a prefix belonging to a different Node version. Run \`callboard restart\` from a terminal where \`${cli} --version\` works.`;
    log.warn(`install ${run.installId}: ${run.package} installed but ${cli} is not visible to this daemon`);
    emit(run, { type: "install_verified", installId: run.installId, engineId: run.engineId, visible: false, summary: refusal, refusal, engines });
    return;
  }

  const summary = `Installed. Callboard now finds \`${cli}\` at \`${path}\`${engine.version ? ` (version ${engine.version})` : ""}.`;
  log.info(`install ${run.installId}: ${run.package} installed; ${cli} resolves to ${path}`);
  emit(run, { type: "install_verified", installId: run.installId, engineId: run.engineId, visible: true, summary, engines });
}

/**
 * The path this install was supposed to produce, as re-probed — or `undefined`.
 *
 * Both lookups count, and for the same reason Phase 2 had to widen its own gate:
 * `runtime.resolvedPath` is what Callboard would *run*, `userCliPath` is what the
 * user can *type*, and an install that produces only the second still did the
 * thing the card asked for (`codex login`, `claude auth login`).
 */
function observedPath(engine: EngineStatus): string | undefined {
  const runtime = engine.runtime;
  if (runtime.kind === "external" || runtime.kind === "external-preferred") return runtime.resolvedPath ?? engine.userCliPath;
  return engine.userCliPath;
}

/** The binary a user would type, which is the runtime's command for the external kinds and the engine id for Codex. */
function cliName(engine: EngineStatus): string {
  const runtime = engine.runtime;
  if (runtime.kind === "external" || runtime.kind === "external-preferred") return runtime.command;
  return engine.id;
}
