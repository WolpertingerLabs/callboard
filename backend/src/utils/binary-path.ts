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
 * ## Why the execute bit, and not just `existsSync`
 *
 * `existsSync` was the whole of the old check, and it accepts two paths that
 * cannot run:
 *
 * - a **directory** — `spawn` fails with EACCES on Linux and EISDIR elsewhere;
 * - a **file with no execute bit**, which is the normal state of anything
 *   downloaded with `curl -O` and the single most likely way a user gets this
 *   field wrong.
 *
 * In both cases the old resolver returned the path, the SDK spawned it, and
 * every chat died at the first turn with an error naming a path the settings
 * page was simultaneously reporting as configured. `X_OK` is one `access` call
 * and turns that into a sentence.
 *
 * Note `X_OK` answers for **this process's** uid/gid, which is the right
 * question and not an approximation of it: the daemon is what will spawn the
 * binary, so its permissions are the ones that decide.
 *
 * @see plans/engine-availability-and-install.md — Phase 4
 */
import { accessSync, constants, statSync } from "node:fs";
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
  const path = (raw ?? "").trim();
  if (!path) return { path: "", state: null, detail: "" };

  let stat;
  try {
    stat = statSync(path);
  } catch {
    // ENOENT, a broken symlink, or a directory component the daemon may not
    // traverse — all of them are "Callboard cannot see anything there", and
    // distinguishing them would mean reporting an errno to someone who typed a
    // path into a text box.
    return {
      path,
      state: "missing",
      detail: `Nothing at \`${path}\` that the Callboard daemon can see. ${fallback}`,
    };
  }

  if (!stat.isFile()) {
    return {
      path,
      state: "not-a-file",
      detail: `\`${path}\` exists but is ${stat.isDirectory() ? "a directory" : "not a regular file"}, so there is nothing to spawn. Point this at the ${what} itself. ${fallback}`,
    };
  }

  try {
    accessSync(path, constants.X_OK);
  } catch {
    return {
      path,
      state: "not-executable",
      detail: `\`${path}\` is a file, but the user running the Callboard daemon has no execute permission on it — spawning it would fail with EACCES. Run \`chmod +x ${path}\`. ${fallback}`,
    };
  }

  return { path, state: "active", detail: `\`${path}\` is executable. This is the ${what} Callboard runs.` };
}
