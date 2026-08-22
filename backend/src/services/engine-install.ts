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
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  EngineInstallCapability,
  EngineInstallEvent,
  EngineInstallRecipe,
  EngineInstallRefusalCode,
  EngineStatus,
} from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";
import { readAgentSettings } from "./agent-settings.js";
import { INSTALLABLE_PACKAGES, oneClickRecipeFor } from "./engine-install-recipes.js";
import { MIN_REFRESH_INTERVAL_MS, refreshEngineStatuses } from "./engine-status.js";

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
 * checks themselves are two `access()` syscalls (the package root and the bin
 * directory) and are deliberately *not* cached, so a `chown` takes effect on the
 * next page load rather than on the next daemon restart.
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
 * The directory `npm install -g` links binaries into, derived from `npm root -g`.
 *
 * `npm root -g` prints `<prefix>/lib/node_modules` on POSIX, and the bin
 * directory is `<prefix>/bin` — two levels up and across. Derived rather than
 * asked for, because `npm bin -g` was removed in npm 9 and a second spawn on a
 * settings-page load is not worth it.
 *
 * Returns `undefined` when the root does not have that shape, in which case the
 * caller must not assert anything about the bin directory — an unrecognised
 * layout is a reason to say nothing, not to guess.
 */
function globalBinDirFor(root: string): string | undefined {
  const parts = root.split(/[/\\]/);
  if (parts.length < 3) return undefined;
  if (parts[parts.length - 1] !== "node_modules" || parts[parts.length - 2] !== "lib") return undefined;
  return join(parts.slice(0, -2).join("/"), "bin");
}

/**
 * Is `dir` one of the entries on the PATH this process inherited?
 *
 * The literal question, asked literally. `npm install -g` writing a binary into
 * a directory the daemon cannot search is the single most confusing outcome this
 * feature produces, and it is knowable *before* the install rather than only
 * from the verdict afterwards.
 *
 * Compared with trailing separators normalised and nothing else — no `realpath`,
 * because a symlinked PATH entry that resolves to the same place is a case this
 * cannot confirm and must therefore not claim either way.
 */
function isOnDaemonPath(dir: string): boolean {
  const normalise = (p: string) => p.replace(/[/\\]+$/, "");
  const target = normalise(dir);
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => normalise(entry) === target);
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
      // Worded for every shape this branch now catches, not just the tunnel.
      // The check refuses any request that is not a *direct* local connection —
      // a public peer address, or a local one carrying a forwarding header —
      // because a proxy that does not mark the hop is indistinguishable from a
      // browser on this machine, and one that does mark it might be anything.
      refusal:
        "Callboard only runs installs for a browser connected directly to it from this machine or your LAN, and this request either came from further away or arrived through a proxy. Running commands on the daemon's machine is a local-only capability — remote access puts this server behind nothing but a password. Copy the command into a terminal on the machine running Callboard.",
    };
  }

  // `readAgentSettings`, not `getAgentSettings`, and the distinction is the
  // whole of this branch.
  //
  // `getAgentSettings` folds "no file" and "file exists and did not parse" into
  // the same `{ proxyMode: "local" }` — a valid object with `allowEngineInstalls`
  // absent, which `!== false` reads as **on**. It swallows the error internally,
  // so a `try/catch` here is dead code: an operator who had switched this off
  // got the kill switch back on by corrupting or `chmod 000`-ing one file.
  // Measured: both cases spawned npm.
  //
  // A setting whose absence means "allowed" cannot be read through a channel
  // that returns absence on failure. So this reads the state explicitly and
  // refuses on `unreadable`, while still treating a genuinely missing file as
  // the documented default-on.
  const { settings, state, error: settingsError } = readAgentSettings();
  if (state === "unreadable") {
    return {
      oneClick: false,
      code: "disabled",
      refusal: `Callboard's settings file exists but could not be read (${settingsError ?? "unknown error"}), so it cannot tell whether one-click installs are permitted here — and it will not assume they are. Fix or remove \`agent-settings.json\`, or copy the command into a terminal.`,
    };
  }
  if (settings.allowEngineInstalls === false) {
    return {
      oneClick: false,
      code: "disabled",
      refusal: "One-click engine installs are switched off for this Callboard (Settings → Remote access → One-click engine installs). Copy the command into a terminal instead.",
    };
  }

  if (process.platform === "win32") {
    // On Windows `npm` is `npm.cmd`, a batch script, and since the fix for
    // CVE-2024-27980 Node refuses to `spawn` one without `shell: true` — which
    // is the one thing this endpoint does not get to have.
    //
    // ## Why the obvious fix is not enough, having now been looked at
    //
    // The reviewer's suggestion is sound and was checked: spawning
    // `process.execPath` with npm's own `npm-cli.js` needs no shell, and
    // `node <npm root -g>/npm/bin/npm-cli.js root -g` was run here and works.
    // That derivation is even platform-neutral — `npm root -g` prints the
    // directory npm itself lives in on both platforms — so the *spawn* half
    // could ship exercised on Linux with only the Windows `npm-cli.js`
    // location untested.
    //
    // The spawn is not the load-bearing half. The **preflight** is: Decision 8
    // only permits this button because a failure is predicted and degraded to
    // the copy block rather than met with an EACCES wall of text. Two of its
    // parts do not port, and both were checked against Windows-shaped inputs
    // rather than assumed:
    //
    //   - `globalBinDirFor` requires a `.../lib/node_modules` suffix. Windows
    //     `npm root -g` is `<prefix>\node_modules` with no `lib`, so it returns
    //     `undefined` and the **bin-directory** writability check silently does
    //     not run — the very check #359 added because testing only the package
    //     root missed a reproduced real-world failure (a user-owned prefix
    //     whose `bin/` belonged to root).
    //   - `isOnDaemonPath` compares PATH entries with exact string equality.
    //     Windows paths are case-insensitive, so a PATH carrying
    //     `C:\Users\U\AppData\Roaming\npm` against a derived
    //     `C:\Users\u\AppData\Roaming\npm` reads as "not on PATH" and produces
    //     a warning that is false.
    //
    // Both are fixable, and neither fix is verifiable from here — nor is the
    // question underneath them, which is whether `fs.access(W_OK)` answers
    // "could npm write here" correctly against Windows ACLs at all. Shipping
    // the button would mean shipping a capability check with a hole in it,
    // which is this series' signature defect (a UI asserting something nothing
    // checked) rather than a missing feature. The copy-and-paste command works
    // perfectly meanwhile, so the cost of refusing is one click.
    //
    // @see plans/engine-availability-and-install.md — "Windows one-click"
    return {
      oneClick: false,
      code: "unsupported-platform",
      refusal:
        "Callboard does not run installs itself on Windows. It can spawn npm here without a shell, but the checks it makes first — whether npm's global directories are actually writable, and whether the result would land somewhere Callboard can see — do not hold on Windows, and Callboard will not offer a button whose safety check it knows is incomplete. That is a limitation of Callboard rather than of npm: the command below works normally when you run it yourself.",
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

  // **Both** directories, not just the package root.
  //
  // `npm install -g` writes the package into `<prefix>/lib/node_modules` and
  // then links its bin into `<prefix>/bin`, and it fails on either. Checking
  // only the first missed a realistic and reproducible shape: a user-owned
  // `~/.npm-global` whose `bin/` was created by an earlier `sudo npm i -g` and
  // is therefore root's. That produced exactly the EACCES wall this preflight
  // exists to prevent, from a card that had just promised it checked.
  const binDir = globalBinDirFor(root);
  for (const dir of binDir ? [root, binDir] : [root]) {
    const { writable, checked } = writableTarget(dir);
    if (writable) continue;
    return {
      oneClick: false,
      code: "prefix-not-writable",
      // The checked path is named separately only when it is not the directory
      // itself — npm creates these on first global install, so the thing that
      // actually refused is often an ancestor, and printing the same path twice
      // reads like a bug in the message.
      refusal: `npm's global ${dir === root ? "package directory" : "bin directory"} (\`${dir}\`) is not writable by the user running Callboard${
        checked === dir ? "" : ` — \`${checked}\`, the nearest directory that exists, refused`
      }. \`npm install -g\` would fail with EACCES, so Callboard will not run it. Point npm at a prefix you own (\`npm config set prefix ~/.npm-global\`), or run the command below with the privileges it needs.`,
    };
  }

  return { oneClick: true, ...(installVisibilityNote(root, binDir) ?? {}) };
}

/**
 * The one true-but-survivable thing to say beside the button, or nothing.
 *
 * ## What the previous version got wrong
 *
 * It keyed on `process.execPath` matching `.nvm` and concluded *"Callboard
 * itself will see it, because it is that same Node"*. The premise is about which
 * interpreter is running; the conclusion is about the daemon's inherited `PATH`.
 * Those are different facts, and on a daemon whose `PATH` lacked the global bin
 * directory the note rendered that promise and the verdict thirty seconds later
 * said `visible: false`. It was this feature's own defect — a claim nothing
 * checked — inside the sentence warning about that defect.
 *
 * ## What it says now
 *
 * Only what was observed. The bin directory is derived from `npm root -g` and
 * compared against `process.env.PATH`:
 *
 * - **not on PATH** — a warning, and a genuine one: the install will land
 *   somewhere this daemon cannot search, so it will very likely report
 *   `visible: false` afterwards. Said *before* the install rather than only
 *   after it.
 * - **on PATH, nvm** — the prefix is per-Node-version, which is worth knowing
 *   for the user's own shell. No claim about Callboard beyond the observed
 *   directory membership.
 * - **on PATH, not nvm** — nothing to warn about. Silence is the honest output;
 *   a note that says "this will probably work" is noise with a risk attached.
 * - **unrecognised layout** (no derivable bin directory) — also nothing, because
 *   nothing was checked.
 */
function installVisibilityNote(root: string, binDir: string | undefined): { note: string } | undefined {
  if (!binDir) return undefined;

  if (!isOnDaemonPath(binDir)) {
    return {
      // No markdown emphasis: the card renders these strings with a splitter
      // that understands backticks and nothing else, so `**not**` would print
      // its own asterisks. Verified rendered.
      note: `Heads up: npm would link the binary into \`${binDir}\`, and that directory is not on the PATH this Callboard daemon inherited. The install will very likely succeed and stay invisible to Callboard until you run \`callboard restart\` from a shell where it is on PATH. Callboard will say either way once it has looked.`,
    };
  }

  if (isNvmManagedNode()) {
    return {
      note: `Callboard's Node is nvm-managed (\`${process.execPath}\`), so this installs into that version's global prefix. Its bin directory \`${binDir}\` is on the PATH this daemon inherited, so Callboard should find it; a shell on a different Node version will not.`,
    };
  }

  return undefined;
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
    // `setEncoding` rather than decoding each chunk: a multi-byte character
    // straddling a chunk boundary decodes to U+FFFD twice when every chunk is
    // converted independently, and npm prints non-ASCII routinely (package
    // names, box drawing, a user's own path). The stream keeps the partial
    // sequence and hands over whole characters.
    source?.setEncoding("utf-8");
    source?.on("data", (chunk: string) => {
      pending += chunk;
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
