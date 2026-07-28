/**
 * Creation — the narrow half of "make me a workspace".
 *
 * Three ways a record can come into existence, and they are deliberately not
 * interchangeable:
 *
 *   recordWorktreeWorkspace()  Callboard just ran `git worktree add`. Writes
 *                              `owned: true` and the identity token.
 *   adoptWorktrees()           a caller named an existing worktree. Writes
 *                              `owned: true` behind registration, branch and
 *                              token-verification gates.
 *   createLocalWorkspace()     this file: a plain directory becomes a named
 *                              workspace. Writes no worktree block at all.
 *
 * ## What this may not become
 *
 * `owned: true` has exactly two writers, and Phase 2's entire removal gate is
 * built on that (see the Phase 2b ruling in plans/workspace-object.md). A
 * creation endpoint is precisely where a third one appears — the store's
 * {@link createWorkspace} accepts a `worktree` block with an `owned` field, and
 * exposing that would let any caller mint the flag that authorises moving a
 * directory. So this function does not take `isolation`, does not take a
 * worktree block, and cannot pass one on: every record it writes is
 * `isolation: "local"`, and `owned` is not a field on it.
 *
 * ## And why a worktree directory is refused rather than recorded
 *
 * Creating a record for a directory that is *already* a linked worktree would
 * be adoption performed without adoption's gates: no identity token, no
 * `git worktree list` check, no branch. Worse, it is not merely useless — it is
 * destructive of the option to do it properly, because {@link evaluateAdoption}
 * refuses `already-managed` for any directory with an active record. One call
 * would move a worktree out of the adoption backlog and into a state where
 * nothing can ever bring it under management or clean it up. The refusal points
 * at `adopt_worktrees`, which is the path that has the gates.
 *
 * Everything else — a main checkout, a plain clone, a bare directory, an agent
 * workspace — is a perfectly good local workspace, and a second record on a
 * directory that already has one is a supported state, not a refusal.
 *
 * @see plans/workspace-object.md — Phase 4
 */
import { existsSync, realpathSync, statSync } from "fs";
import { resolve } from "path";
import type { CreateWorkspaceResult, WorkspaceCreationRefusal } from "shared/types/index.js";
import { resolveWorktreeToMainRepo } from "../utils/git.js";
import { createWorkspace, listWorkspacesByCwd, workspaceNameError } from "./workspace-store.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-create");

function refuse(code: WorkspaceCreationRefusal, detail: string): CreateWorkspaceResult {
  return { created: false, refusal: { code, detail } };
}

/**
 * Create a `local` workspace record for an existing directory.
 *
 * The name defaults to the directory's last segment, which is exactly what the
 * sidebar would have shown anyway — so an unnamed create changes nothing a user
 * can see, and a named one is the whole point of {@link renameWorkspace} having
 * a sibling here.
 */
export function createLocalWorkspace(input: { cwd: string; name?: string }): CreateWorkspaceResult {
  const raw = (input.cwd ?? "").trim();
  if (!raw) return refuse("cwd-required", "A directory is required — create_workspace records where work happens, so there must be a where");

  if (input.name !== undefined) {
    const nameError = workspaceNameError(input.name);
    if (nameError) return refuse("invalid-name", nameError);
  }

  const resolved = resolve(raw);
  if (!existsSync(resolved)) {
    return refuse(
      "cwd-missing",
      `${resolved} does not exist. A record for a directory that is not there is born in the "missing" state and can do nothing but ` +
        `ask to be archived — create the directory first.`,
    );
  }

  // Canonical spelling wins, for the same reason adoption takes git's: a caller
  // may have named a symlink, and a record whose `cwd` is a link would have
  // every later path operation act on the link rather than the directory.
  let cwd = resolved;
  try {
    cwd = realpathSync(resolved);
  } catch {
    // Unreadable link target or a permissions failure. The resolved spelling is
    // still a usable key; nothing below dereferences it.
  }

  try {
    if (!statSync(cwd).isDirectory()) {
      return refuse("not-a-directory", `${cwd} is not a directory. A workspace is a directory work happens in.`);
    }
  } catch (err: any) {
    return refuse("cwd-missing", `Could not inspect ${cwd}: ${err.message}`);
  }

  // The gate that keeps adoption's job adoption's. Uncached: this decides
  // whether a record is written, and a five-minute-old answer about whether a
  // directory is a worktree is not an observation.
  const resolution = resolveWorktreeToMainRepo(cwd);
  if (resolution.isWorktree) {
    return refuse(
      "is-a-worktree",
      `${cwd} is a git worktree of ${resolution.mainRepoPath}. Worktrees are brought under management by adopt_worktrees, which writes the ` +
        `identity token that makes removal possible and checks that git still registers the path. A plain record here would carry neither, ` +
        `and it would make this worktree permanently unadoptable — adoption refuses any directory that already has an active record.`,
    );
  }

  // Reported, never a gate: multiple workspaces on one cwd is supported.
  const sharedWith = listWorkspacesByCwd(cwd).map((w) => ({ id: w.id, name: w.name }));

  try {
    const workspace = createWorkspace({ cwd, isolation: "local", ...(input.name !== undefined && { name: input.name }) });
    log.info(`Created local workspace ${workspace.id} for ${cwd}${sharedWith.length > 0 ? ` (${sharedWith.length} other active record(s) on it)` : ""}`);
    return { created: true, workspace, ...(sharedWith.length > 0 && { sharedWith }) };
  } catch (err: any) {
    return refuse("record-write-failed", `Could not write a workspace record for ${cwd}: ${err.message}`);
  }
}
