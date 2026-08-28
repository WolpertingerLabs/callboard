/**
 * The machinery behind every `npm install -g` Callboard runs on its own machine.
 *
 * Extracted from `engine-install.ts` when a second feature needed the same
 * thing — `self-update.ts`, which installs Callboard itself. The two are
 * genuinely different features (an engine install is verified by re-probing a
 * binary; a self-update is verified by restarting the daemon), but the parts
 * below are not different at all, and the reason they live in one file is that
 * a *divergence* between them would be silent:
 *
 * - **The preflight** ({@link getInstallCapability}). This is the check that
 *   decides whether a button appears anywhere in the product. A second copy
 *   that forgot the bin-directory writability test, or the `readAgentSettings`
 *   distinction between "no file" and "unreadable file", would fail open on a
 *   daemon the operator believed was locked down. Both features gate on
 *   `allowEngineInstalls` for exactly this reason — one switch, one meaning.
 * - **The child process discipline** ({@link spawnNpmInstall}). No shell, a
 *   frozen argv, a wall-clock kill, `setEncoding` line buffering, ANSI
 *   stripping. Every one of those has a specific reason recorded below, and
 *   every one of them is easy to leave out of a copy.
 * - **The replay buffer** ({@link RunLog}). Bounded, and bounded in a way that
 *   never drops the first frame — a transcript that does not say what was run
 *   is not a transcript.
 *
 * What is deliberately *not* here: the sentences. Each caller composes its own
 * refusal text, because "Callboard has not changed anything about this engine"
 * and "the new version takes effect on the next restart" are different claims
 * about different things, and a shared string would end up hedging both.
 *
 * @see plans/engine-availability-and-install.md — Phase 3, Decisions 4, 5, 7, 8
 * @see plans/self-update.md
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { EventEmitter } from "node:events";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { EngineInstallCapability } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";
import { readAgentSettings } from "./agent-settings.js";

const log = createLogger("npm-global-install");
const execFileAsync = promisify(execFile);

// ── Bounds ──────────────────────────────────────────────────────────

/** Wall-clock ceiling on one install. A global npm install that has not finished in this long is not going to. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** How long `npm root -g` is remembered. Short, because a user who fixes their prefix should not have to wait long to be believed. */
const NPM_ROOT_TTL_MS = 60_000;

/** Longest single output line kept. npm's own lines are short; a runaway one is a memory leak with a progress bar. */
export const MAX_LINE_CHARS = 2_000;

/** How many output lines one run retains for replay. Beyond this the oldest go, with a marker. */
export const MAX_BUFFERED_LINES = 800;

/** How long a finished run stays fetchable, so a stream that reconnects still gets the transcript and the verdict. */
export const RUN_RETENTION_MS = 15 * 60_000;

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

export async function resolveNpmGlobalRoot(): Promise<{ root: string | null; error?: string }> {
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
export function resetNpmRootCache(): void {
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
 * the story — the callers render the reason directly under the copy-and-paste
 * command, which is Decision 8's structural fallback.
 *
 * Shared by engine installs and by Callboard's own self-update. The self-update
 * adds gates of its own on top (is this daemon the globally installed copy; is
 * there anything to restart) but subtracts none: a client that may not install
 * `opencode` here may not upgrade Callboard here either.
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

// ── The replay buffer ───────────────────────────────────────────────

/**
 * One run's events, bounded, replayable, and subscribable.
 *
 * Every consumer of these features is an SSE endpoint that may connect *after*
 * the run started — a second tab, a reload mid-install, a browser that took a
 * beat to follow its own POST. So the transcript is kept rather than streamed
 * and forgotten, and a late subscriber replays it from the beginning.
 *
 * The bound has one exception, and it is the reason this is a class rather than
 * an array: the **first** event is never dropped. It is the frame that names
 * what is being run, and a transcript whose head has aged out is a wall of npm
 * output attached to nothing.
 */
export class RunLog<E extends { type: string }> {
  private readonly events: E[] = [];
  private readonly emitter = new EventEmitter();
  /** How many output frames the bound discarded. Reported nowhere yet; kept because "the transcript is incomplete" is a fact about it. */
  droppedLines = 0;

  /**
   * @param droppableType the `type` of the frames that may be discarded when the
   * buffer is full — the per-line output ones. Anything else (started, exit,
   * the verdict) is structural and is kept whatever the length.
   */
  constructor(private readonly droppableType: E["type"]) {
    // One listener per open stream; several tabs on the settings page is ordinary.
    this.emitter.setMaxListeners(64);
  }

  emit(event: E): void {
    this.events.push(event);
    if (this.events.length > MAX_BUFFERED_LINES) {
      const dropAt = this.events.findIndex((e, i) => i > 0 && e.type === this.droppableType);
      if (dropAt > 0) {
        this.events.splice(dropAt, 1);
        this.droppedLines++;
      }
    }
    this.emitter.emit("event", event);
  }

  /** Every event so far, for replay on connect. A copy: the caller iterates it while the child keeps writing. */
  snapshot(): E[] {
    return this.events.slice();
  }

  subscribe(listener: (event: E) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
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

export function cleanLine(raw: string): string {
  const stripped = raw.replace(/\r/g, "").replace(ANSI_ESCAPE, "");
  return stripped.length > MAX_LINE_CHARS ? `${stripped.slice(0, MAX_LINE_CHARS)}… (line truncated)` : stripped;
}

/**
 * What `npm install -g` is doing on this machine right now, if anything.
 *
 * Two concurrent global installs against one prefix are a genuine hazard rather
 * than merely wasteful — npm's global tree has no cross-process lock — and each
 * feature only knows about its own runs. So the fact is recorded here, where
 * both spawns pass through, rather than inferred by asking the other feature
 * whether it is busy. Holds a noun phrase ("an engine install") because its only
 * consumer is a refusal sentence.
 *
 * Set on a successful spawn and cleared on the outcome, both inside
 * {@link spawnNpmInstall}, so there is no release for a caller to forget.
 */
let inFlight: string | null = null;

export function npmInstallInFlight(): string | null {
  return inFlight;
}

/**
 * Test seam: forget the marker for a run that was abandoned rather than
 * finished.
 *
 * Production never needs this — every spawn's outcome clears it — but a suite
 * that starts a run and then throws the child away leaves the flag set, and the
 * *next* test in that file is then refused as busy by a run that no longer
 * exists. Called from both features' `reset…State` helpers.
 */
export function clearNpmInstallInFlight(): void {
  inFlight = null;
}

/** How a run of npm ended. The *sentence* is the caller's to write — see this module's header. */
export type NpmRunOutcome =
  /** The process never started: no npm on PATH, or the spawn itself failed. */
  | { kind: "spawn-error"; error: unknown }
  /** The process ran and is over. `code === 0` is the only success, and even then it means only "npm wrote files". */
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null };

/**
 * Run one frozen `npm install -g` argv and report every line of it.
 *
 * The argv is the caller's, and in both callers it is a literal that no part of
 * a request can reach. Nothing here parses it, interpolates it, or passes it to
 * a shell.
 *
 * `onDone` fires exactly once for a run that this function started — either a
 * spawn error or a close, never both — and it is not called at all once
 * `isDone()` answers true, so a caller that has already finished the run for
 * its own reasons (a timeout it handled, a run it abandoned) cannot be reentered.
 */
export function spawnNpmInstall(opts: {
  argv: readonly string[];
  /** Identifies the run in this daemon's log. Never reaches a command line. */
  label: string;
  /** A noun phrase for the *other* feature's refusal sentence — "an engine install". See {@link npmInstallInFlight}. */
  what: string;
  timeoutMs?: number;
  /** True once the caller considers the run finished; suppresses every callback after that. */
  isDone: () => boolean;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
  onDone: (outcome: NpmRunOutcome) => void;
}): ChildProcess | null {
  const [command, ...args] = opts.argv;
  const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const finish = (outcome: NpmRunOutcome) => {
    inFlight = null;
    opts.onDone(outcome);
  };

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // No shell, ever. The argv above is a frozen literal from the caller and
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
    finish({ kind: "spawn-error", error: err });
    return null;
  }

  inFlight = opts.what;

  const timer = setTimeout(() => {
    if (opts.isDone()) return;
    log.warn(`${opts.label} exceeded ${timeoutMs}ms; killing`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, timeoutMs);

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
      for (const line of lines) opts.onLine(stream, cleanLine(line));
      // A process that writes a lot without a newline (a progress bar with no
      // TTY still happens) must not grow this buffer without bound.
      if (pending.length > MAX_LINE_CHARS) {
        opts.onLine(stream, cleanLine(pending));
        pending = "";
      }
    });
    flushers.push(() => {
      if (pending.trim()) opts.onLine(stream, cleanLine(pending));
      pending = "";
    });
  }

  child.on("error", (err) => {
    if (opts.isDone()) return;
    clearTimeout(timer);
    for (const flush of flushers) flush();
    finish({ kind: "spawn-error", error: err });
  });

  child.on("close", (code, signal) => {
    if (opts.isDone()) return;
    clearTimeout(timer);
    for (const flush of flushers) flush();
    finish({ kind: "exit", code, signal });
  });

  return child;
}

/**
 * "Callboard could not start npm" — the one sentence both features say the same
 * way, because the failure is about this machine rather than about what was
 * being installed.
 */
export function npmSpawnRefusal(command: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ENOENT") {
    return `Callboard could not start \`npm\` — there is none on the PATH the daemon inherited. Run \`${command}\` in a terminal instead.`;
  }
  return `Callboard could not start \`npm\` (${message}). Run \`${command}\` in a terminal instead.`;
}
