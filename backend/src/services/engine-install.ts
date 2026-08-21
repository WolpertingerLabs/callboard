/**
 * The one place Callboard runs a command because a user asked it to.
 *
 * Phase 3 of `plans/engine-availability-and-install.md`. Everything before it
 * described the machine; this changes it, on a daemon whose own Remote Access
 * feature can put it on the public internet with a password as the only barrier.
 * The design is therefore built around *not* being an arbitrary-command surface,
 * and around never claiming more than was observed.
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
 * - **loopback/LAN only** (`utils/client-ip.ts`'s `isLocalClient`). A client
 *   arriving through the remote-access tunnel gets the copy-command instead —
 *   "authenticated" is not a strong enough answer for command execution on a
 *   box that may be internet-facing.
 * - **`AgentSettings.allowEngineInstalls`**, default on, so an operator can
 *   remove the capability entirely.
 *
 * Both, plus the preflight below, are folded into one
 * {@link EngineInstallCapability} that is *also* what the status card reads, so
 * the button is offered in exactly the states the install would be permitted.
 * There is no state where the UI shows a button and the endpoint refuses it.
 *
 * ## Why the preflight exists
 *
 * `npm install -g` under a global prefix the daemon's user cannot write produces
 * an EACCES wall of text and no install. That is the common failure on a
 * system-wide Node, it is entirely predictable from `npm root -g` plus one
 * `access()` call, and running the command anyway would spend thirty seconds to
 * arrive at a stack trace. So it is detected and refused *before* spawning, and
 * the refusal lands on the same copy block the button sits next to.
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
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type {
  EngineInstallCapability,
  EngineInstallEvent,
  EngineInstallRecipe,
  EngineInstallRefusalCode,
  EngineStatus,
} from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";
import { getAgentSettings } from "./agent-settings.js";
import { INSTALLABLE_PACKAGES, oneClickRecipeFor } from "./engine-install-recipes.js";
import { refreshEngineStatuses } from "./engine-status.js";

const log = createLogger("engine-install");
const execFileAsync = promisify(execFile);

// ── Bounds ──────────────────────────────────────────────────────────

/** Wall-clock ceiling on one install. A global npm install that has not finished in this long is not going to. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** How long `npm root -g` is remembered. Short, because a user who fixes their prefix should not have to wait long to be believed. */
const NPM_ROOT_TTL_MS = 60_000;

/** Longest single output line kept. npm's own lines are short; a runaway one is a memory leak with a progress bar. */
const MAX_LINE_CHARS = 2_000;

/** How many output lines one run retains for replay. Beyond this the oldest go, with a marker. */
const MAX_BUFFERED_LINES = 800;

/** How long a finished run stays fetchable, so a stream that reconnects still gets the transcript and the verdict. */
const RUN_RETENTION_MS = 15 * 60_000;

// ── Preflight ───────────────────────────────────────────────────────

/**
 * Where `npm install -g` would put things, and whether the daemon's user could.
 *
 * Cached for {@link NPM_ROOT_TTL_MS} because `npm root -g` is a ~200ms process
 * spawn and `GET /api/engines` is what a settings page loads — the writability
 * check itself is one `access()` syscall and is deliberately *not* cached, so a
 * `chown` takes effect on the next page load rather than on the next daemon
 * restart.
 */
let npmRootCache: { at: number; root: string | null; error?: string } | null = null;

async function resolveNpmGlobalRoot(): Promise<{ root: string | null; error?: string }> {
  if (npmRootCache && Date.now() - npmRootCache.at < NPM_ROOT_TTL_MS) {
    return { root: npmRootCache.root, ...(npmRootCache.error ? { error: npmRootCache.error } : {}) };
  }

  let root: string | null = null;
  let error: string | undefined;
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      timeout: 15_000,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    const line = stdout.trim().split("\n").pop()?.trim();
    if (line) root = line;
    else error = "`npm root -g` printed nothing";
  } catch (err) {
    // ENOENT here is the honest answer to "is npm even on this daemon's PATH",
    // and it is the same lookup the spawn would do — so a machine without npm
    // is refused at preflight rather than at a spawn error thirty seconds later.
    error = err instanceof Error ? err.message : String(err);
  }

  npmRootCache = { at: Date.now(), root, ...(error ? { error } : {}) };
  return { root, ...(error ? { error } : {}) };
}

/** Forget the cached `npm root -g`. Called after every install, so a prefix that appeared mid-session is seen. */
export function resetEngineInstallCaches(): void {
  npmRootCache = null;
}

/**
 * Is `dir` writable by this process — or, if it does not exist yet, is the
 * nearest directory that does?
 *
 * npm creates `lib/node_modules` on first global install, so a missing path is
 * not the same as an unwritable one and refusing on absence would be wrong on a
 * fresh prefix. Walks up until something exists, then asks about that.
 */
function writableTarget(dir: string): { writable: boolean; checked: string } {
  let cursor = dir;
  for (let depth = 0; depth < 32; depth++) {
    try {
      accessSync(cursor, constants.W_OK);
      return { writable: true, checked: cursor };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        const parent = dirname(cursor);
        if (parent === cursor) return { writable: false, checked: cursor };
        cursor = parent;
        continue;
      }
      return { writable: false, checked: cursor };
    }
  }
  return { writable: false, checked: cursor };
}

/** True when this daemon's Node came from nvm, whose global prefix is per-version. */
function isNvmManagedNode(): boolean {
  return /[/\\]\.nvm[/\\]/.test(process.execPath);
}

/**
 * Everything that decides whether this client sees an install button.
 *
 * Ordered cheapest-and-most-decisive first, and every branch returns a sentence
 * a user can act on rather than a code. `oneClick: false` is never the end of
 * the story — {@link installGuidanceFor} renders the reason directly under the
 * copy-and-paste command, which is Decision 8's structural fallback.
 */
export async function getInstallCapability(opts: { local: boolean }): Promise<EngineInstallCapability> {
  if (!opts.local) {
    return {
      oneClick: false,
      code: "not-local",
      refusal:
        "This browser is reaching Callboard from outside its local network, and running commands on the daemon's machine is a loopback/LAN-only capability — remote access puts this server behind nothing but a password. Copy the command into a terminal on the machine running Callboard.",
    };
  }

  let allowed = true;
  try {
    allowed = getAgentSettings().allowEngineInstalls !== false;
  } catch {
    // Settings unreadable. Refuse rather than assume the default: the default is
    // "on", and defaulting a security capability on from an error is how a
    // switched-off box quietly switches itself back on.
    return {
      oneClick: false,
      code: "disabled",
      refusal: "Callboard could not read its own settings to check whether one-click installs are permitted, so it will not run one. Copy the command into a terminal instead.",
    };
  }
  if (!allowed) {
    return {
      oneClick: false,
      code: "disabled",
      refusal: "One-click engine installs are switched off for this Callboard (Settings → Remote access → One-click engine installs). Copy the command into a terminal instead.",
    };
  }

  if (process.platform === "win32") {
    // `npm` on Windows is `npm.cmd`, a batch script, and Node will not run one
    // without `shell: true` — which is exactly the thing this endpoint does not
    // get to have. Refusing is the honest end of that: the command below still
    // works perfectly when the user types it.
    return {
      oneClick: false,
      code: "unsupported-platform",
      refusal: "Callboard runs installs without a shell, and `npm` on Windows is a batch script that needs one — so this command can only be run from your own terminal.",
    };
  }

  const { root, error } = await resolveNpmGlobalRoot();
  if (!root) {
    return {
      oneClick: false,
      code: "npm-unresolvable",
      refusal: `Callboard could not resolve npm's global package directory (\`npm root -g\` failed: ${error ?? "no output"}), so it cannot tell whether an install would succeed. Run the command in a terminal, where you will see npm's own error.`,
    };
  }

  const { writable, checked } = writableTarget(root);
  if (!writable) {
    return {
      oneClick: false,
      code: "prefix-not-writable",
      // The checked path is named separately only when it is not the directory
      // itself — npm creates `lib/node_modules` on first global install, so the
      // thing that actually refused is often an ancestor, and printing the same
      // path twice reads like a bug in the message.
      refusal: `npm's global package directory (\`${root}\`) is not writable by the user running Callboard${
        checked === root ? "" : ` — \`${checked}\`, the nearest directory that exists, refused`
      }. \`npm install -g\` would fail with EACCES, so Callboard will not run it. Point npm at a prefix you own (\`npm config set prefix ~/.npm-global\`), or run the command below with the privileges it needs.`,
    };
  }

  return {
    oneClick: true,
    ...(isNvmManagedNode()
      ? {
          note: `Callboard's Node is nvm-managed (\`${process.execPath}\`), so this installs into that version's global prefix — \`${root}\`. Callboard itself will see it, because it is that same Node; a shell on a different Node version will not.`,
        }
      : {}),
  };
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
  events: EngineInstallEvent[];
  droppedLines: number;
  emitter: EventEmitter;
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
  return run.events.slice();
}

export function isInstallRunDone(run: InstallRun): boolean {
  return run.done;
}

export function subscribeToInstallRun(run: InstallRun, listener: (event: EngineInstallEvent) => void): () => void {
  run.emitter.on("event", listener);
  return () => run.emitter.off("event", listener);
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
  npmRootCache = null;
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
 */
function assertSpawnable(recipe: EngineInstallRecipe): { argv: readonly string[]; package: string } | null {
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

  const run: InstallRun = {
    installId: randomUUID(),
    engineId,
    package: spawnable.package,
    command: recipe.command,
    argv: spawnable.argv,
    capability,
    startedAt: Date.now(),
    finishedAt: null,
    events: [],
    droppedLines: 0,
    emitter: new EventEmitter(),
    child: null,
    done: false,
  };
  // One listener per open stream; several tabs on the settings page is ordinary.
  run.emitter.setMaxListeners(64);
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

/**
 * ANSI CSI sequences.
 *
 * `no-control-regex` is disabled rather than worked around: matching ESC is the
 * entire purpose. npm colours its output and draws a spinner whenever it thinks
 * it has a terminal, and those bytes replayed as text in a browser are noise at
 * best. Built with `new RegExp` so the source carries no literal control
 * character.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = new RegExp("\\u001B\\[[0-9;?]*[ -/]*[@-~]", "g");

function cleanLine(raw: string): string {
  const stripped = raw.replace(/\r/g, "").replace(ANSI_ESCAPE, "");
  return stripped.length > MAX_LINE_CHARS ? `${stripped.slice(0, MAX_LINE_CHARS)}… (line truncated)` : stripped;
}

function emit(run: InstallRun, event: EngineInstallEvent): void {
  run.events.push(event);
  if (run.events.length > MAX_BUFFERED_LINES) {
    // Drop from the front, but never the `install_started` frame — a replayed
    // transcript that does not say what was run is not a transcript.
    const dropAt = run.events.findIndex((e, i) => i > 0 && e.type === "install_output");
    if (dropAt > 0) {
      run.events.splice(dropAt, 1);
      run.droppedLines++;
    }
  }
  run.emitter.emit("event", event);
}

function spawnInstall(run: InstallRun): void {
  const [command, ...args] = run.argv;

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // No shell, ever. The argv above is a frozen literal from the registry and
      // there is nothing in it for a shell to reinterpret — which is only true
      // while there is no shell.
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        // Readability only; none of these change what is installed. npm emits a
        // spinner and colour codes when it thinks it has a terminal, and a
        // progress bar replayed as text is unreadable.
        NO_COLOR: "1",
        npm_config_color: "false",
        npm_config_progress: "false",
        npm_config_fund: "false",
      },
    });
  } catch (err) {
    finishFailed(run, null, null, spawnRefusal(run, err));
    return;
  }

  run.child = child;

  const timer = setTimeout(() => {
    if (run.done) return;
    log.warn(`install ${run.installId} exceeded ${INSTALL_TIMEOUT_MS}ms; killing`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, INSTALL_TIMEOUT_MS);

  const flushers: Array<() => void> = [];
  for (const stream of ["stdout", "stderr"] as const) {
    let pending = "";
    const source = stream === "stdout" ? child.stdout : child.stderr;
    source?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf-8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(run, { type: "install_output", stream, line: cleanLine(line) });
      // A process that writes a lot without a newline (a progress bar with no
      // TTY still happens) must not grow this buffer without bound.
      if (pending.length > MAX_LINE_CHARS) {
        emit(run, { type: "install_output", stream, line: cleanLine(pending) });
        pending = "";
      }
    });
    flushers.push(() => {
      if (pending.trim()) emit(run, { type: "install_output", stream, line: cleanLine(pending) });
      pending = "";
    });
  }

  child.on("error", (err) => {
    if (run.done) return;
    clearTimeout(timer);
    for (const flush of flushers) flush();
    finishFailed(run, null, null, spawnRefusal(run, err));
  });

  child.on("close", (code, signal) => {
    if (run.done) return;
    clearTimeout(timer);
    for (const flush of flushers) flush();
    if (code === 0) {
      void finishSucceeded(run);
      return;
    }
    const killed = signal !== null;
    const refusal = killed
      ? `\`${run.command}\` was killed (${signal})${signal === "SIGKILL" ? " — it ran past Callboard's ten-minute limit" : ""}. Nothing was installed as far as Callboard can tell. Run the command in a terminal, where you can watch it without a timeout.`
      : `\`${run.command}\` exited with code ${code}. The output above is npm's; Callboard has not changed anything about this engine. Run the same command in a terminal to retry it interactively.`;
    finishFailed(run, code, signal, refusal);
  });
}

function spawnRefusal(run: InstallRun, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ENOENT") {
    return `Callboard could not start \`npm\` — there is none on the PATH the daemon inherited. Run \`${run.command}\` in a terminal instead.`;
  }
  return `Callboard could not start \`npm\` (${message}). Run \`${run.command}\` in a terminal instead.`;
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
