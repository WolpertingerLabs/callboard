/**
 * "Which `claude` does this machine have?" — one question, one answer.
 *
 * ## Why this module exists at all
 *
 * There were two resolvers, and they disagreed by construction:
 *
 * - `agent-settings.ts`'s `getClaudeCodeExecutablePath()` honoured the
 *   `pathToClaudeCodeExecutable` setting and `which claude`, and is what every
 *   chat spawns.
 * - `utils/paths.ts`'s `getClaudeBinaryPath()` ignored that setting, read
 *   `$CLAUDE_BINARY` and four well-known directories, and fell back to the bare
 *   string `"claude"`. It is what `/api/auth/claude-status` and the About page's
 *   CLI version used.
 *
 * Both failure modes were reproduced against a real daemon:
 *
 * - A user running fine on the Agent SDK's bundled binary, with no native
 *   `claude` anywhere, got `{"loggedIn": false, "error": "CLI error: Command
 *   failed: claude auth status … claude: not found"}` — because the second
 *   resolver's bare-name fallback was handed to a shell, which then could not
 *   find it. "Claude Code Login Required", every session, on a machine where
 *   logging in was neither possible nor necessary.
 * - A user with a Phase-4 override had the login prompt checking a *different*
 *   binary than their chats ran, and Phase 4 could only name the disagreement
 *   (`EngineRuntime.otherLookupPath`) rather than fix it, because
 *   `utils/paths.ts` cannot import `agent-settings.ts` without a cycle.
 *
 * The cycle was real. It is broken here by **direction**, not by a shim: the
 * whole resolution moved *down* the graph into a service that may import
 * settings, and `utils/paths.ts` — which settings imports for `DATA_DIR` — no
 * longer knows anything about `claude`. Nothing imports this module from
 * `utils/`, so there is nothing to cycle with.
 *
 * ## The order, and what changed by merging
 *
 * 1. `pathToClaudeCodeExecutable`, the settings field. Most explicit: someone
 *    typed it into the UI for this exact purpose.
 * 2. `$CLAUDE_BINARY`, the operator's environment override.
 * 3. `which claude` — the user's PATH.
 * 4. Four well-known install directories, for the daemon that started before
 *    `~/.local/bin` was on its PATH. That is not hypothetical: it is where
 *    Anthropic's own `install.sh` — the script this feature's install card
 *    offers — puts the binary.
 *
 * Merging necessarily moves someone: `$CLAUDE_BINARY` used to beat the settings
 * field for About and the login prompt while losing to it for chats. It now
 * loses to it everywhere, which is the direction that matches what the settings
 * page tells the user it does.
 *
 * Steps 3 and 4 additionally now feed **chats**, where only step 3 did before.
 * That is the point rather than a side effect: a native `claude` is preferred
 * over the bundled binary because it is the copy the user updates, and a card
 * that says so while chats quietly run something else is the defect this whole
 * series keeps finding.
 *
 * ## What is checked, and what is no longer accepted
 *
 * Every candidate — including `$CLAUDE_BINARY` and the well-known directories,
 * which were previously taken on trust or on `existsSync` — goes through
 * {@link checkBinaryPath}: absolute, a regular file, executable by *this*
 * process. A rejected candidate falls through to the next one rather than being
 * handed to a spawn that would fail. See `utils/binary-path.ts` for why
 * `existsSync` is not the check.
 *
 * The bare-name fallback (`"claude"`) is gone. It never resolved anything the
 * `which` above it had not already tried, and its only observable effect was to
 * turn "this machine has no native CLI" into a shell error with a misleading
 * message. **Absent means absent**, and callers say so.
 *
 * @see plans/engine-availability-and-install.md — Phase 4, departure 3
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BINARY_OVERRIDE_PHRASING, checkBinaryPathAsync, type BinaryPathCheck } from "../utils/binary-path.js";
import { binaryVersion } from "../utils/binary-version.js";
import { createLogger } from "../utils/logger.js";
import { getAgentSettings } from "./agent-settings.js";

const log = createLogger("claude-binary");
const execFileAsync = promisify(execFile);

/** How a native `claude` was found. Reported so a status card can say which lookup won. */
export type ClaudeBinarySource = "setting" | "env" | "path" | "well-known";

export interface ClaudeBinaryResolution {
  /** Absolute path to a native `claude`. Absent ⇒ this machine has none, and the Agent SDK's bundled binary is what runs. */
  path?: string;
  /** Which step of the order produced {@link path}. Absent whenever `path` is. */
  source?: ClaudeBinarySource;
  /**
   * The `pathToClaudeCodeExecutable` setting, checked — present whether or not
   * it won, and absent only when the field is blank.
   *
   * A *rejected* override is invisible from `path` alone: resolution falls
   * through and lands exactly where it would have with the field empty. The
   * status card needs to be able to tell those apart, so the verdict travels
   * separately.
   */
  override?: BinaryPathCheck;
}

/**
 * Where `claude` might be when `which` cannot find it — a daemon started before
 * the install, or one whose PATH was never a login shell's.
 *
 * Built per call rather than once at module load, so that the two
 * home-relative entries follow `$HOME`. Only a test moves `$HOME` under a
 * running process, but a list captured at import is a list that cannot be
 * pointed at a scratch directory, and the alternative is a suite that passes or
 * fails depending on whether the developer running it happens to have a
 * `claude` in their own `~/.local/bin`.
 */
export function wellKnownClaudePaths(): string[] {
  return [
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "bin", "claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
}

/**
 * The `pathToClaudeCodeExecutable` setting, checked — or `undefined` when the
 * field is blank.
 *
 * **Uncached, and read fresh on every resolution.** That is not an optimisation
 * left on the table; it is what makes the card and the chat one answer. When the
 * whole decision was memoized, the two could disagree in both directions and
 * both were reproduced in review: an override whose binary was deleted after
 * resolution left the card reading "Native `claude` at X · Ready" beside
 * "⚠ Nothing at X" while every chat died, and an override saved before its
 * target existed stayed ignored by chats while the card announced it was in
 * effect. One `stat` per resolution is the price, and this runs at chat start,
 * not in a loop. Only the `which` lookup is worth memoizing, because only it
 * spawns a process.
 */
export async function getClaudeCodeExecutableOverride(): Promise<BinaryPathCheck | undefined> {
  const configured = getAgentSettings().pathToClaudeCodeExecutable?.trim();
  if (!configured) return undefined;
  return checkBinaryPathAsync(configured, BINARY_OVERRIDE_PHRASING["claude-code"].what, BINARY_OVERRIDE_PHRASING["claude-code"].fallback);
}

/**
 * The last rejection logged, so a per-call check does not become a per-call log
 * line. Keyed by candidate + state, so a *different* failure still speaks.
 */
let lastLoggedRejection: string | null = null;

function logRejectionOnce(what: string, check: BinaryPathCheck): void {
  const signature = `${what}:${check.state}:${check.path}`;
  if (lastLoggedRejection === signature) return;
  lastLoggedRejection = signature;
  log.warn(`Ignoring ${what} (${check.state}): ${check.path}`);
}

/**
 * Is this candidate plausibly a Claude Code CLI, and not merely *an executable
 * named `claude`*?
 *
 * ## Why this exists, and why only for two of the four candidates
 *
 * `checkBinaryPathAsync` answers "could this be spawned". That is necessary and
 * not sufficient, and the gap is not academic: hand the Agent SDK a path to a
 * shell script that prints a line and exits, and the SDK writes to a child that
 * is already gone. The resulting **EPIPE is uncaught**, and `installProcessGuards`
 * treats an uncaught exception as unrecoverable and exits the process. So the
 * cost of adopting the wrong binary is not a broken chat — it is a daemon that
 * will not boot, since `sdk-info.ts` resolves at startup.
 *
 * Measured, with a stub `claude` that echoes one line and exits, against an
 * isolated daemon:
 *
 * | scenario | before this probe | with it |
 * |---|---|---|
 * | stub in `~/.local/bin`, not on PATH | 3 uncaught, `EXIT=1` | boots, ignores it |
 * | `CLAUDE_BINARY=<stub>`              | 3 uncaught, `EXIT=1` | boots, ignores it |
 *
 * **The probe is applied to `env` and `well-known` only, and that asymmetry is
 * the point rather than an oversight.** Those two are the candidates this merge
 * *added* to the spawn path; `setting` and `path` were already there before it.
 * For the two new ones, failing the probe falls through to the next candidate
 * and ultimately to the SDK's bundled binary — which is exactly what the daemon
 * did before, so a false negative costs nothing. For the two old ones, falling
 * through would *remove* a binary the daemon previously used, which is a
 * behaviour change in the opposite direction and not this change's to make. A
 * stray `claude` on `PATH`, or a settings override pointed at one, still takes
 * the daemon down; that is pre-existing, unchanged, and reported rather than
 * quietly half-fixed.
 *
 * It is a **sanity** probe and not an identity proof. A different tool that
 * prints a dotted version passes it. What it removes is the realistic case — a
 * wrapper, a stale shim, a placeholder script — and it removes it at the price
 * of one cached `--version` spawn per daemon lifetime.
 */
async function looksLikeClaudeCode(path: string): Promise<boolean> {
  // Deliberately the same check the status card trusts for the Version row, so
  // "Callboard will run this" and "Callboard can name its version" cannot come
  // apart: a candidate this rejects is one the card would have shown as
  // Unknown.
  return (await binaryVersion(path)) !== undefined;
}

/**
 * `which claude` plus the well-known directories, memoized for the process
 * lifetime.
 *
 * Only this half is cached: PATH cannot change under a running daemon, and the
 * one thing that *can* make this answer stale — a user installing the CLI and
 * pressing Recheck — goes through {@link resetClaudeBinaryCache}.
 *
 * ## Why it is off the event loop
 *
 * This was `execFileSync`, and a `which` is only fast while every entry on
 * `PATH` is. One autofs mount or one dead NFS export makes it arbitrarily slow,
 * and a synchronous spawn on a single-threaded server does not stall the caller
 * — it stalls **everything**: every open SSE stream, every in-flight chat, every
 * unrelated request. Measured with a deliberately slow `which` (2.5s, under the
 * timeout, so this is the stall the daemon *accepts* rather than the kill path):
 * an unrelated `/api/auth/check` took **2.42s and 2.70s** on two of three
 * samples against a 2ms baseline, while one `POST /api/engines/refresh` ran.
 *
 * The `timeout` is not a fix for that and never was — it bounds a hung child,
 * not a slow one, and a bare `timeout` does not even bound a hung one (Node
 * sends SIGTERM at the deadline and then waits indefinitely, which is why
 * `killSignal: "SIGKILL"` is here). Both stay; they are the ceiling. Being
 * async is what makes the cost land on the caller alone.
 *
 * Concurrent callers share one probe rather than racing several, and the
 * generation counter means a probe started before a {@link resetClaudeBinaryCache}
 * cannot write its pre-reset answer afterwards — clearing a variable cannot
 * cancel a promise already in flight, and the ordering that loses is the likely
 * one: a slow probe is the usual reason someone pressed Recheck.
 */
let discovered: { path: string; source: ClaudeBinarySource } | null | undefined;
let discoveryInFlight: Promise<{ path: string; source: ClaudeBinarySource } | null> | null = null;
let discoveryGeneration = 0;

async function discoverClaude(): Promise<{ path: string; source: ClaudeBinarySource } | null> {
  if (discovered !== undefined) return discovered;
  if (discoveryInFlight) return discoveryInFlight;

  const generation = discoveryGeneration;
  const probe = (async () => {
    let onPath = "";
    try {
      const { stdout } = await execFileAsync("which", ["claude"], {
        timeout: 3_000,
        killSignal: "SIGKILL",
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      onPath = stdout.trim();
    } catch {
      // Non-zero exit is the normal "not on PATH" answer, not an error.
    }

    const candidates: Array<{ path: string; source: ClaudeBinarySource }> = [
      ...(onPath ? [{ path: onPath, source: "path" as const }] : []),
      ...wellKnownClaudePaths().map((path) => ({ path, source: "well-known" as const })),
    ];

    let found: { path: string; source: ClaudeBinarySource } | null = null;
    for (const candidate of candidates) {
      const check = await checkBinaryPathAsync(candidate.path, "Claude Code binary", "");
      if (check.state !== "active") continue;
      // See {@link looksLikeClaudeCode}: only the candidate kind this merge
      // added is sanity-probed, because only there does falling through restore
      // what the daemon did before rather than take something away.
      if (candidate.source === "well-known" && !(await looksLikeClaudeCode(candidate.path))) {
        log.warn(`Ignoring ${candidate.path}: it is executable but did not answer \`--version\` with anything recognisable, so it is probably not the Claude Code CLI`);
        continue;
      }
      found = candidate;
      log.info(`Found Claude Code CLI at ${candidate.path} (${candidate.source})`);
      break;
    }

    if (generation === discoveryGeneration) {
      discovered = found;
      discoveryInFlight = null;
    }
    return found;
  })();

  discoveryInFlight = probe;
  return probe;
}

/**
 * The native `claude` this machine has, if any, and where it came from.
 *
 * The single resolution every caller shares — chats, the status card, the About
 * page's CLI version, and the login prompt. That is the whole point: two of
 * those used to answer from a different lookup, so a user could be told to log
 * in to a binary their chats were not running.
 */
export async function resolveClaudeBinary(): Promise<ClaudeBinaryResolution> {
  const override = await getClaudeCodeExecutableOverride();
  if (override) {
    if (override.state === "active") return { path: override.path, source: "setting", override };
    logRejectionOnce("pathToClaudeCodeExecutable", override);
  }

  const fromEnv = process.env.CLAUDE_BINARY?.trim();
  if (fromEnv) {
    const check = await checkBinaryPathAsync(fromEnv, "Claude Code binary", "");
    if (check.state === "active") {
      if (await looksLikeClaudeCode(check.path)) return { path: check.path, source: "env", ...(override ? { override } : {}) };
      logRejectionOnce("$CLAUDE_BINARY (did not answer `--version` recognisably)", check);
    } else {
      logRejectionOnce("$CLAUDE_BINARY", check);
    }
  }

  const found = await discoverClaude();
  if (found) return { ...found, ...(override ? { override } : {}) };
  return { ...(override ? { override } : {}) };
}

/**
 * The path to hand the Agent SDK as `pathToClaudeCodeExecutable`, or `undefined`
 * to let it use its own bundled binary.
 *
 * Called by `claude.ts` when it builds a chat's options, by `sdk-info.ts` and
 * `quick-completion.ts`, and by `engine-status.ts` when it describes the engine
 * — so the card and the chat cannot disagree about which binary runs.
 */
export async function getClaudeCodeExecutablePath(): Promise<string | undefined> {
  return (await resolveClaudeBinary()).path;
}

/**
 * Forget the memoized PATH / well-known lookup so the next call looks again.
 *
 * One caller that matters: `POST /api/engines/refresh`, after a user installs
 * the CLI — without this the daemon keeps reporting the answer it cached before
 * the install.
 *
 * It is *not* what makes an edited `pathToClaudeCodeExecutable` or a changed
 * `$CLAUDE_BINARY` take effect: those are read fresh on every resolution, so
 * they are live by construction rather than by remembering to invalidate. That
 * is the only version of the guarantee a status card can be built on.
 */
export function resetClaudeBinaryCache(): void {
  discoveryGeneration++;
  discovered = undefined;
  discoveryInFlight = null;
  lastLoggedRejection = null;
}
