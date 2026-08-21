/**
 * "Is this path something Callboard could actually spawn?" — one answer, one
 * implementation.
 *
 * ## Why this is a module and not four calls to `existsSync`
 *
 * Two settings fields point Callboard at a binary of the user's choosing
 * (`pathToClaudeCodeExecutable`, `codexPathOverride`), and three places need to
 * agree about whether a given path is usable: the resolver that decides what a
 * chat spawns, the status card that tells the user what a chat spawns, and the
 * settings field that validates as they type. Three implementations of "is it
 * there" is exactly how a card ends up asserting an override is active while
 * chats run something else — so there is one, and all three import it.
 *
 * ## The three things `existsSync` got wrong
 *
 * Each of these accepted a path that cannot run, and each did it silently — the
 * resolver returned the path, the engine spawned it, and the chat died at the
 * first turn against a path Settings was simultaneously calling configured:
 *
 * - a **relative path**. This is the subtlest and the worst, because it is not
 *   a stricter-or-looser question but a *different* one: Callboard resolves it
 *   against the daemon's own cwd, while the engine spawns it with the **chat
 *   folder** as cwd. `"relwrap"` validated green and failed to launch in every
 *   chat. Rejected first, before anything is looked at, since there is no
 *   filesystem answer that would make it right.
 * - a **directory** — `spawn` fails with EACCES on Linux and EISDIR elsewhere;
 * - a **file with no execute bit**, which is the normal state of anything
 *   downloaded with `curl -O` and the single most likely way a user gets this
 *   field wrong.
 *
 * Note `X_OK` answers for **this process's** uid/gid, which is the right
 * question and not an approximation of it: the daemon is what will spawn the
 * binary, so its permissions are the ones that decide.
 *
 * ## Sync and async, deliberately both
 *
 * {@link checkBinaryPath} is synchronous because its callers are: the engine
 * resolvers run on the synchronous path that builds a chat's options.
 * {@link checkBinaryPathAsync} exists for `GET /api/engines/binary-check`,
 * which fires on a debounce while someone is typing — a `statSync` per
 * keystroke is the same event-loop stall this codebase already avoids for
 * `which` and `--version`, just with a smaller constant. They share one verdict
 * builder so the two cannot answer differently.
 *
 * @see plans/engine-availability-and-install.md — Phase 4
 */
import { accessSync, constants, statSync, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { EngineOverrideState } from "shared/types/index.js";

/** What {@link checkBinaryPath} concluded, plus the sentence to show for it. */
export interface BinaryPathCheck {
  /** The input, trimmed. */
  path: string;
  /** `null` ⇒ the field was blank. Not a failure — the default. */
  state: EngineOverrideState | null;
  /** One sentence naming what was observed. Empty for a blank path. */
  detail: string;
}

const BLANK: BinaryPathCheck = { path: "", state: null, detail: "" };

/**
 * How each engine's override is named, and what runs when it is rejected.
 *
 * Here rather than at the call sites because there are two call sites per
 * engine — the resolver in `agent-settings.ts` and the validation route — and a
 * settings field whose "what happens instead" sentence disagrees with the
 * status card's is a smaller version of the same bug this module exists to
 * close.
 */
export const BINARY_OVERRIDE_PHRASING = {
  "claude-code": {
    what: "Claude Code binary",
    fallback: "Callboard is falling back to a `claude` on its PATH, or to the binary bundled with the Agent SDK.",
  },
  codex: {
    what: "Codex binary",
    fallback: "Callboard is falling back to the binary bundled with `@openai/codex-sdk`.",
  },
} as const;

/**
 * The part of the check that needs no filesystem: blank, and not-absolute.
 *
 * Returns a finished verdict, or `null` meaning "keep going, we have to look".
 */
function preFilesystemVerdict(raw: string | undefined, fallback: string): { path: string; verdict: BinaryPathCheck | null } {
  const path = (raw ?? "").trim();
  if (!path) return { path, verdict: BLANK };
  if (!isAbsolute(path)) {
    return {
      path,
      verdict: {
        path,
        state: "not-absolute",
        detail:
          `\`${path}\` is a relative path. Callboard would resolve it against the daemon's own working directory, ` +
          `but the engine spawns its binary with the chat's folder as the working directory — so a relative path names a different file in every chat, ` +
          `and usually no file at all. Give the full path, starting with \`/\`. ${fallback}`,
      },
    };
  }
  return { path, verdict: null };
}

/**
 * Build the verdict once the filesystem has answered.
 *
 * `stats === null` means the `stat` threw: ENOENT, a broken symlink, or a
 * directory component the daemon may not traverse. All of them are "Callboard
 * cannot see anything there", and distinguishing them would mean reporting an
 * errno to someone who typed a path into a text box.
 */
function verdictFor(path: string, what: string, fallback: string, stats: Stats | null, executable: boolean): BinaryPathCheck {
  if (!stats) {
    return { path, state: "missing", detail: `Nothing at \`${path}\` that the Callboard daemon can see. ${fallback}` };
  }

  if (!stats.isFile()) {
    return {
      path,
      state: "not-a-file",
      detail: `\`${path}\` exists but is ${stats.isDirectory() ? "a directory" : "not a regular file"}, so there is nothing to spawn. Point this at the ${what} itself. ${fallback}`,
    };
  }

  if (!executable) {
    // `chmod +x` is suggested only for a file this user owns. Printing it
    // unconditionally would have the settings page cheerfully advise
    // `chmod +x /etc/passwd` — a command that will not work and should not be
    // recommended. Ownership is something Callboard can actually check, so it
    // checks rather than guesses which advice applies.
    const owned = typeof stats.uid === "number" && typeof process.getuid === "function" && stats.uid === process.getuid();
    const fix = owned
      ? `Run \`chmod +x ${path}\`.`
      : `It belongs to another user, so adding the execute bit is not yours to do — point this at a copy you own, or ask whoever administers that file.`;
    return {
      path,
      state: "not-executable",
      detail: `\`${path}\` is a file, but the user running the Callboard daemon has no execute permission on it — spawning it would fail with EACCES. ${fix} ${fallback}`,
    };
  }

  return { path, state: "active", detail: `\`${path}\` is executable. This is the ${what} Callboard runs.` };
}

/**
 * Check a user-supplied binary path, without running it.
 *
 * `statSync` rather than `lstatSync` on purpose: a symlink to a real executable
 * is a perfectly good answer (it is what every npm global bin directory
 * contains), and following the link is also what `spawn` will do.
 *
 * @param raw the configured value, or undefined/blank when nothing is set
 * @param what how to name the thing in the returned sentence — "Claude Code
 *   binary", "Codex binary". Used in prose, never parsed.
 * @param fallback what runs instead when the path is rejected, as a phrase.
 *   Stated in every failure detail because "this path is bad" without "and so
 *   this is what happens" is half an answer.
 */
export function checkBinaryPath(raw: string | undefined, what: string, fallback: string): BinaryPathCheck {
  const { path, verdict } = preFilesystemVerdict(raw, fallback);
  if (verdict) return verdict;

  let stats: Stats | null = null;
  try {
    stats = statSync(path);
  } catch {
    return verdictFor(path, what, fallback, null, false);
  }

  let executable = false;
  try {
    accessSync(path, constants.X_OK);
    executable = true;
  } catch {
    executable = false;
  }
  return verdictFor(path, what, fallback, stats, executable);
}

/** {@link checkBinaryPath}, off the event loop. Same verdicts, by construction. */
export async function checkBinaryPathAsync(raw: string | undefined, what: string, fallback: string): Promise<BinaryPathCheck> {
  const { path, verdict } = preFilesystemVerdict(raw, fallback);
  if (verdict) return verdict;

  let stats: Stats | null = null;
  try {
    stats = await stat(path);
  } catch {
    return verdictFor(path, what, fallback, null, false);
  }

  let executable = false;
  try {
    await access(path, constants.X_OK);
    executable = true;
  } catch {
    executable = false;
  }
  return verdictFor(path, what, fallback, stats, executable);
}
