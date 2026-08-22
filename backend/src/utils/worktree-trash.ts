/**
 * Quarantine — removal that can be undone.
 *
 * Callboard never deletes a worktree. It **moves** it:
 *
 *   mv <worktree> ~/.callboard/trash/<workspaceId>-<timestamp>/
 *   git worktree prune
 *
 * and restoration is `git worktree add <path> <branch>` plus copying back
 * whatever git does not track (see {@link TrashManifest.restore}, which is
 * written into every trash entry so the recipe survives without Callboard).
 *
 * WHY A MOVE AND NOT A DELETE. `git status --porcelain` cannot see **ignored**
 * files, and `git worktree remove` deletes them: a `.env`, a local sqlite, a
 * `node_modules` full of patched packages all go with the directory. The
 * obvious fix — refuse to remove a worktree carrying ignored files outside an
 * allowlist of regenerables — was implemented and measured against all 44
 * worktrees on the author's machine: **it refused 44 of 44**. `.env` exists in
 * every one of them with 34 distinct contents, so it is per-worktree state and
 * therefore precisely the file that can never be allowlisted. A refuse-by-
 * default policy over ignored files is unsatisfiable on real repositories, and
 * an unsatisfiable safety gate only creates pressure to widen the allowlist or
 * add `--force` later.
 *
 * Making removal reversible dissolves the question instead of answering it. It
 * also covers what an allowlist could never enumerate — per-worktree reflogs,
 * `refs/worktree/*`, detached-HEAD commits — and it sidesteps git's partial
 * destruction behaviour, where a failed `git worktree remove` has already
 * deleted tracked files and the admin dir before exiting non-zero.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO GUARANTEE:
 *
 * 1. **The move is a `rename(2)`, never a copy.** `fs.renameSync` does not fall
 *    back to copy-and-delete, and this module refuses up front when the trash
 *    directory is on a different filesystem ({@link QuarantineFailure}
 *    `cross-device`) rather than reaching for one.
 * 2. **Nothing is deleted at quarantine time.** Deletion happens only in
 *    {@link sweepTrash}, only after {@link TRASH_RETENTION_MS}, and only for an
 *    entry that says in its own manifest when it arrived. Anything unreadable,
 *    unparseable or unexpected is kept forever.
 *
 * @see plans/workspace-object.md — "Removal is quarantine, not deletion"
 */
import type { Dirent } from "fs";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { clearProjectDirFolderCache, DATA_DIR } from "./paths.js";
import { createLogger } from "./logger.js";

const log = createLogger("worktree-trash");

/**
 * How long a quarantined worktree is kept before {@link sweepTrash} deletes it.
 *
 * Deliberately long. This is the window in which a user who archived the wrong
 * workspace can still get their ignored files back, and the cost of being
 * generous is disk space in a directory nothing else reads.
 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Written into every trash entry; also what makes the entry sweepable. */
export const TRASH_MANIFEST_FILE = ".callboard-trash.json";

/** Where quarantined worktrees go. Under DATA_DIR so it shares its filesystem. */
export function trashRoot(): string {
  return join(DATA_DIR, "trash");
}

export interface TrashManifest {
  /** The workspace whose archive quarantined this directory. */
  workspaceId: string;
  /** Where it came from — the path `restore` puts it back at. */
  originalPath: string;
  /** The main checkout it was a worktree of. */
  repoPath?: string;
  /** The branch it had checked out. The restore *recipe*, and what a human reads. */
  branch?: string;
  /**
   * The commit HEAD was on when it was quarantined. The restore *correctness*.
   *
   * A branch name is not enough to put a checkout back. Branches move, and a
   * branch deleted while its directory sat in the trash makes
   * `git worktree add <path> <branch>` DWIM against a remote — a different
   * commit, checked out under the right name, reported as a successful restore
   * with the untracked files copied on top. The cleanliness gate proves the
   * commit exists somewhere; it proves nothing about where the *name* points
   * thirty days later. Absent on entries quarantined before this was recorded,
   * which restore handles by falling back to the branch and saying so.
   */
  headSha?: string;
  /** ISO timestamp. {@link sweepTrash} reads only this; never the entry name. */
  quarantinedAt: string;
  /** The restore recipe, spelled out so it does not depend on Callboard. */
  restore: string[];
}

export type QuarantineFailure =
  /** The directory to quarantine is not there. */
  | "source-missing"
  /** The trash directory could not be created or inspected. */
  | "trash-unavailable"
  /** Trash is on a different filesystem, so the move would be a copy. Refuse. */
  | "cross-device"
  /** `rename(2)` itself failed. Nothing was moved. */
  | "move-failed";

export type QuarantineResult =
  | { ok: true; trashPath: string; manifestWritten: boolean }
  | { ok: false; code: QuarantineFailure; error: string };

export interface QuarantineOptions {
  /** Defaults to {@link trashRoot}. A parameter so tests can force EXDEV. */
  root?: string;
  /** Entry name prefix — the workspace id. A timestamp is appended. */
  entryPrefix: string;
  /** Everything but `quarantinedAt`, which is stamped here. */
  manifest: Omit<TrashManifest, "quarantinedAt" | "restore">;
}

/** `2026-07-27T11-22-33-456Z` — sortable, and legal in a path on every OS. */
function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function restoreRecipe(manifest: Omit<TrashManifest, "quarantinedAt" | "restore">): string[] {
  const branch = manifest.branch ?? "<branch>";
  const repo = manifest.repoPath ?? "<main-repo>";
  return [
    `git -C ${repo} worktree add ${manifest.originalPath} ${branch}`,
    // The commit, spelled out next to the recipe: a reader running this by hand
    // thirty days later needs to know that the branch may have moved, and what
    // to check out if it has.
    ...(manifest.headSha
      ? [
          `# HEAD was ${manifest.headSha} when this was quarantined. If ${branch} no longer exists or has moved,`,
          `# use: git -C ${repo} worktree add -b ${branch} ${manifest.originalPath} ${manifest.headSha}`,
        ]
      : []),
    `# then copy anything git does not track (.env, local databases, node_modules)`,
    `# from this directory back into ${manifest.originalPath}`,
  ];
}

/**
 * Move a directory into the trash. The only mutation is one `rename(2)`.
 *
 * The manifest is written **after** the move, into the trash entry. Writing it
 * into the source first would add an untracked file to a live worktree — which
 * this phase's own cleanliness gate would then refuse on — and would leave that
 * file behind if the move failed.
 */
export function quarantineDirectory(source: string, opts: QuarantineOptions): QuarantineResult {
  if (!existsSync(source)) {
    return { ok: false, code: "source-missing", error: `Nothing to quarantine at ${source}` };
  }

  const root = opts.root ?? trashRoot();
  try {
    mkdirSync(root, { recursive: true });
  } catch (err: any) {
    return { ok: false, code: "trash-unavailable", error: `Could not create ${root}: ${err.message}` };
  }

  // Same-filesystem pre-flight. `rename(2)` needs source and destination on one
  // filesystem; the *parent* of the source is what matters (renaming a
  // directory renames an entry in its parent), and a source whose own device
  // differs from its parent's is a mount point, which rename refuses too.
  let sourceDev: number;
  let parentDev: number;
  let trashDev: number;
  try {
    sourceDev = lstatSync(source).dev;
    parentDev = statSync(dirname(source)).dev;
    trashDev = statSync(root).dev;
  } catch (err: any) {
    return { ok: false, code: "trash-unavailable", error: `Could not compare filesystems for ${source} and ${root}: ${err.message}` };
  }
  if (sourceDev !== trashDev || parentDev !== trashDev) {
    return {
      ok: false,
      code: "cross-device",
      error:
        `${source} and the trash directory ${root} are on different filesystems, so moving it would be a copy-and-delete rather than ` +
        `an atomic rename. Refusing: a partial copy that then deletes the original is exactly the failure this phase exists to avoid. ` +
        `Point CALLBOARD_DATA_DIR at the same filesystem as the worktree, or remove the worktree yourself.`,
    };
  }

  const now = new Date();
  // A collision means two quarantines of the same workspace inside one
  // millisecond. Suffix rather than overwrite — an existing entry is somebody's
  // recoverable work.
  let trashPath = join(root, `${opts.entryPrefix}-${timestampForPath(now)}`);
  for (let n = 2; existsSync(trashPath); n++) {
    trashPath = join(root, `${opts.entryPrefix}-${timestampForPath(now)}-${n}`);
  }

  try {
    renameSync(source, trashPath);
  } catch (err: any) {
    // Includes EXDEV if the device check above was somehow wrong. There is no
    // fallback on purpose: nothing has moved, and the caller reports a refusal.
    return { ok: false, code: "move-failed", error: `Could not move ${source} to ${trashPath}: ${err.message}` };
  }

  // A directory just stopped existing at `source`, and `projectDirToFolder`
  // decides where a project-dir name points by asking the filesystem. Its memo
  // would keep answering for up to five minutes — harmless on its own (the old
  // path is still where the chats were), but it is the half of an
  // archive-then-restore cycle that makes the *restore* wrong: a decode taken
  // while the directory is absent falls through to a best-effort guess, and
  // that guess would then outlive the directory coming back.
  clearProjectDirFolderCache();

  const manifest: TrashManifest = {
    ...opts.manifest,
    quarantinedAt: now.toISOString(),
    restore: restoreRecipe(opts.manifest),
  };
  let manifestWritten = true;
  try {
    writeFileSync(join(trashPath, TRASH_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  } catch (err: any) {
    // Not a failure of the quarantine — the directory is safe. It just becomes
    // un-sweepable, which is the conservative direction.
    manifestWritten = false;
    log.warn(`Quarantined ${source} to ${trashPath} but could not write its manifest: ${err.message} — it will never be swept`);
  }

  log.info(`Quarantined ${source} → ${trashPath}`);
  return { ok: true, trashPath, manifestWritten };
}

export interface TrashSweepResult {
  /** Entries deleted because they aged out. */
  removed: string[];
  /** Entries left alone, and why. */
  kept: Array<{ entry: string; reason: string }>;
  errors: string[];
}

/**
 * Delete trash entries older than the retention window.
 *
 * The only code in Callboard that deletes a directory outright, so every
 * unknown is a keep:
 *
 *  - not a directory (a stray file, a symlink) → kept;
 *  - no manifest, unreadable manifest, unparseable manifest → kept;
 *  - `quarantinedAt` missing, unparseable, or in the future → kept;
 *  - younger than `retentionMs` → kept.
 *
 * Age comes from the manifest, never from the entry's mtime: `rename(2)` does
 * not touch mtime, so a worktree nobody had edited for a year would look a year
 * old the instant it was quarantined.
 */
export function sweepTrash(opts?: { root?: string; retentionMs?: number; now?: number }): TrashSweepResult {
  const root = opts?.root ?? trashRoot();
  const retentionMs = opts?.retentionMs ?? TRASH_RETENTION_MS;
  const now = opts?.now ?? Date.now();
  const result: TrashSweepResult = { removed: [], kept: [], errors: [] };

  if (!existsSync(root)) return result;

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err: any) {
    result.errors.push(`Could not read ${root}: ${err.message}`);
    return result;
  }

  for (const entry of entries) {
    const full = join(root, entry.name);
    if (!entry.isDirectory()) {
      result.kept.push({ entry: entry.name, reason: "not a directory" });
      continue;
    }

    let manifest: TrashManifest;
    try {
      manifest = JSON.parse(readFileSync(join(full, TRASH_MANIFEST_FILE), "utf8"));
    } catch {
      result.kept.push({ entry: entry.name, reason: "no readable manifest" });
      continue;
    }

    const quarantinedAt = Date.parse(manifest?.quarantinedAt ?? "");
    if (!Number.isFinite(quarantinedAt)) {
      result.kept.push({ entry: entry.name, reason: "manifest has no usable quarantinedAt" });
      continue;
    }
    const age = now - quarantinedAt;
    if (age < 0) {
      result.kept.push({ entry: entry.name, reason: "quarantinedAt is in the future" });
      continue;
    }
    if (age < retentionMs) {
      result.kept.push({ entry: entry.name, reason: `younger than the retention window` });
      continue;
    }

    try {
      rmSync(full, { recursive: true, force: true });
      result.removed.push(entry.name);
      log.info(`Swept ${full} — quarantined ${manifest.quarantinedAt}, past the ${retentionMs}ms retention window`);
    } catch (err: any) {
      result.errors.push(`Could not delete ${full}: ${err.message}`);
    }
  }

  return result;
}
