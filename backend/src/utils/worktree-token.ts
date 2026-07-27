/**
 * Worktree identity token — proof that a worktree on disk is the same one a
 * workspace record was written for.
 *
 * Phase 1's revalidation (workspace-store.ts) checks that the recorded cwd is
 * still a worktree of the recorded repo. That cannot catch the one case that
 * matters most: a user who removes a worktree and recreates it themselves with
 * `git worktree add` at the same path, on the same branch, of the same repo.
 * Byte-for-byte it satisfies every filesystem predicate, so the old record
 * revalidates and hands `owned: true` to a directory Callboard never made.
 *
 * The token closes it. At creation we write the workspace id into the
 * worktree's **git admin directory** — `<mainRepo>/.git/worktrees/<slug>/` —
 * and nothing may be removed unless the file there still names it.
 *
 * The admin dir specifically, and not the working tree:
 *
 *  - git does not track it, so the token never shows up in a diff or a commit;
 *  - git destroys it when the worktree is removed, so the token cannot outlive
 *    the thing it identifies;
 *  - a user-recreated worktree gets a *fresh* admin dir with no token in it,
 *    which reads — correctly — as not ours.
 *
 * A marker inside the working tree would do none of this. It would be an
 * untracked file, which would trip this phase's own untracked-files refusal:
 * self-defeating.
 *
 * `<slug>` is never constructed. Git names it after the worktree directory
 * (and disambiguates collisions with a numeric suffix), so it is read from the
 * worktree's `.git` file via resolveWorktreeToMainRepo.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveWorktreeToMainRepo } from "./git.js";
import { createLogger } from "./logger.js";

const log = createLogger("worktree-token");

/** Filename inside the admin dir. Namespaced so git never mistakes it for its own. */
export const WORKTREE_TOKEN_FILE = "callboard-workspace-id";

/**
 * Where the token for this worktree lives, or null when `cwd` is not a
 * worktree at all (a plain checkout, a submodule, a directory that is gone).
 *
 * Uncached on purpose: this decides removals, and a stale cache entry after a
 * remove-and-recreate would name the wrong admin dir.
 */
export function worktreeTokenPath(cwd: string): string | null {
  const resolution = resolveWorktreeToMainRepo(cwd);
  if (!resolution.isWorktree || !resolution.adminDir) return null;
  return join(resolution.adminDir, WORKTREE_TOKEN_FILE);
}

/**
 * Stamp a worktree with the id of the workspace that owns it.
 *
 * Returns false rather than throwing — a token we could not write only ever
 * costs us the ability to remove the worktree later (an unverifiable token is
 * treated as not ours), and that must not fail the chat being started.
 */
export function writeWorktreeToken(cwd: string, workspaceId: string): boolean {
  const path = worktreeTokenPath(cwd);
  if (!path) {
    log.warn(`No worktree admin dir for ${cwd} — workspace ${workspaceId} will not be removable`);
    return false;
  }
  try {
    writeFileSync(path, `${workspaceId}\n`);
    return true;
  } catch (err: any) {
    log.warn(`Failed to write worktree token at ${path}: ${err.message}`);
    return false;
  }
}

/** The workspace id stamped on this worktree, or null when there is none. */
export function readWorktreeToken(cwd: string): string | null {
  const path = worktreeTokenPath(cwd);
  if (!path || !existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8").trim();
    return content || null;
  } catch (err: any) {
    log.warn(`Failed to read worktree token at ${path}: ${err.message}`);
    return null;
  }
}

/**
 * Three outcomes, and only the first permits removal:
 *
 *  - `verified`     — the token names this workspace.
 *  - `missing`      — no token. Every record written before this phase, plus
 *                     anything the user recreated. Not ours.
 *  - `mismatch`     — a token naming a *different* workspace.
 *  - `unresolvable` — `cwd` is not a worktree (or is gone), so there is no
 *                     admin dir to look in.
 */
export type WorktreeTokenVerdict = "verified" | "missing" | "mismatch" | "unresolvable";

export function verifyWorktreeToken(cwd: string, workspaceId: string): WorktreeTokenVerdict {
  const path = worktreeTokenPath(cwd);
  if (!path) return "unresolvable";
  const token = readWorktreeToken(cwd);
  if (token === null) return "missing";
  return token === workspaceId ? "verified" : "mismatch";
}
