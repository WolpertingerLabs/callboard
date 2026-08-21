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
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BINARY_OVERRIDE_PHRASING, checkBinaryPath, type BinaryPathCheck } from "../utils/binary-path.js";
import { createLogger } from "../utils/logger.js";
import { getAgentSettings } from "./agent-settings.js";

const log = createLogger("claude-binary");

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
export function getClaudeCodeExecutableOverride(): BinaryPathCheck | undefined {
  const configured = getAgentSettings().pathToClaudeCodeExecutable?.trim();
  if (!configured) return undefined;
  return checkBinaryPath(configured, BINARY_OVERRIDE_PHRASING["claude-code"].what, BINARY_OVERRIDE_PHRASING["claude-code"].fallback);
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
 * `which claude` plus the well-known directories, memoized for the process
 * lifetime.
 *
 * Only this half is cached: PATH cannot change under a running daemon, and the
 * one thing that *can* make this answer stale — a user installing the CLI and
 * pressing Recheck — goes through {@link resetClaudeBinaryCache}.
 *
 * `execFileSync` with `killSignal: "SIGKILL"` rather than `execSync("which
 * claude")`: no shell, and a deadline that is actually a bound. Node sends
 * SIGTERM at a bare `timeout` and then waits indefinitely, so a child that
 * ignores it holds this synchronous call — and therefore the whole
 * single-threaded server — for as long as it likes.
 */
let discovered: { path: string; source: ClaudeBinarySource } | null | undefined;

function discoverClaude(): { path: string; source: ClaudeBinarySource } | null {
  if (discovered !== undefined) return discovered;

  let onPath = "";
  try {
    onPath = execFileSync("which", ["claude"], {
      timeout: 3_000,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // Non-zero exit is the normal "not on PATH" answer, not an error.
  }

  const candidates: Array<{ path: string; source: ClaudeBinarySource }> = [
    ...(onPath ? [{ path: onPath, source: "path" as const }] : []),
    ...wellKnownClaudePaths().map((path) => ({ path, source: "well-known" as const })),
  ];

  for (const candidate of candidates) {
    const check = checkBinaryPath(candidate.path, "Claude Code binary", "");
    if (check.state === "active") {
      discovered = candidate;
      log.info(`Found Claude Code CLI at ${candidate.path} (${candidate.source})`);
      return discovered;
    }
  }

  discovered = null;
  return discovered;
}

/**
 * The native `claude` this machine has, if any, and where it came from.
 *
 * The single resolution every caller shares — chats, the status card, the About
 * page's CLI version, and the login prompt. That is the whole point: two of
 * those used to answer from a different lookup, so a user could be told to log
 * in to a binary their chats were not running.
 */
export function resolveClaudeBinary(): ClaudeBinaryResolution {
  const override = getClaudeCodeExecutableOverride();
  if (override) {
    if (override.state === "active") return { path: override.path, source: "setting", override };
    logRejectionOnce("pathToClaudeCodeExecutable", override);
  }

  const fromEnv = process.env.CLAUDE_BINARY?.trim();
  if (fromEnv) {
    const check = checkBinaryPath(fromEnv, "Claude Code binary", "");
    if (check.state === "active") return { path: check.path, source: "env", ...(override ? { override } : {}) };
    logRejectionOnce("$CLAUDE_BINARY", check);
  }

  const found = discoverClaude();
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
export function getClaudeCodeExecutablePath(): string | undefined {
  return resolveClaudeBinary().path;
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
  discovered = undefined;
  lastLoggedRejection = null;
}
