/**
 * Trash visibility — seeing what the retention sweep is queued to delete, and
 * getting it back.
 *
 * `sweepTrash` in utils/worktree-trash.ts is the **only** code in Callboard that
 * deletes a directory outright, it runs unprompted, and until this module there
 * was no way to find out what it was holding. A thirty-day window a user cannot
 * inspect is not really a safety net; it is a delayed deletion.
 *
 * Two operations, and the asymmetry between them is deliberate:
 *
 *  - **Listing reads.** It stats, parses manifests and (opt-in) runs `du`. It
 *    never writes, never sweeps, and reports an unsweepable entry as such rather
 *    than tidying it up.
 *  - **Restore copies.** It recreates the checkout with the manifest's own
 *    recipe and then copies the untracked and ignored files back **out** of the
 *    trash entry, leaving the entry exactly where it was. A restore therefore
 *    cannot lose anything: if it goes wrong halfway, the quarantined directory
 *    is still sitting there, whole, and can be tried again or copied by hand.
 *
 * The one thing restore will not do is write over something. If anything at all
 * exists at the original path it refuses — a directory that has been recreated
 * since the quarantine is somebody's work, and merging into it is not a decision
 * this module gets to make.
 *
 * @see plans/workspace-object.md — "Removal is quarantine, not deletion"
 */
import type { Dirent, Stats } from "fs";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import type {
  TrashEntryView,
  TrashListing,
  TrashRestoreBranchOutcome,
  TrashRestoreFailure,
  TrashRestoreResult,
  WorktreeDiskUsage,
} from "shared/types/index.js";
import { TRASH_MANIFEST_FILE, TRASH_RETENTION_MS, trashRoot, type TrashManifest } from "../utils/worktree-trash.js";
import { newDiskUsageBudget } from "../utils/disk-usage.js";
import { resolveCommit } from "../utils/git.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-trash");

/**
 * How many skipped or failed paths a result carries in full.
 *
 * A restore walks the whole quarantined tree, and the tracked files git has
 * just checked out are all skips — thousands of them on a real repository.
 * The *counts* are always exact; the lists are a sample, and both are reported
 * so a reader can tell a sample from a total.
 */
const REPORTED_PATH_CAP = 25;

/**
 * Entries in a quarantined worktree that a restore must not copy back.
 *
 * `.git` is the important one: in a worktree it is a *file* pointing at an
 * admin directory that `git worktree prune` has since deleted. Copying it over
 * the fresh one `git worktree add` just wrote would point the restored checkout
 * at nothing.
 */
const NEVER_RESTORED = new Set([".git", TRASH_MANIFEST_FILE]);

function readManifest(entryPath: string): TrashManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(entryPath, TRASH_MANIFEST_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as TrashManifest) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why this entry could not be restored, or undefined if it can.
 *
 * Mirrors {@link restoreTrashEntry}'s own refusals so a listing can grey a
 * button out for the same reasons the call would fail, rather than guessing.
 */
function restoreBlockerFor(manifest: TrashManifest | undefined): string | undefined {
  if (!manifest) return `no readable ${TRASH_MANIFEST_FILE}, so there is no restore recipe — copy the contents out by hand`;
  if (!manifest.originalPath) return "the manifest does not record where this came from";
  if (!manifest.repoPath || !manifest.branch) {
    return "the manifest has no repository and branch, so the checkout cannot be recreated — copy the contents out by hand";
  }
  if (existsSync(manifest.originalPath)) return `${manifest.originalPath} exists again; restoring would write over it`;
  if (!existsSync(manifest.repoPath)) return `the repository ${manifest.repoPath} is no longer there`;
  return undefined;
}

/**
 * Everything under the trash root, with the age the sweep will read.
 *
 * Age comes from the manifest, exactly as the sweep computes it, and never from
 * the directory's mtime — `rename(2)` does not update mtime, so a worktree
 * nobody had touched for a year would look a year old the moment it was
 * quarantined and be deleted on the next sweep.
 */
export function listTrash(opts?: { includeDiskUsage?: boolean; root?: string; now?: number; diskUsageBudgetMs?: number }): TrashListing {
  const root = opts?.root ?? trashRoot();
  const now = opts?.now ?? Date.now();
  const listing: TrashListing = { root, retentionDays: Math.round(TRASH_RETENTION_MS / 86_400_000), entries: [] };
  // `du` blocks the event loop, so a listing of N entries needs a bound on the
  // whole listing, not just on each `du`. @see newDiskUsageBudget
  const budget = newDiskUsageBudget({ budgetMs: opts?.diskUsageBudgetMs });

  if (!existsSync(root)) return listing;

  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err: any) {
    log.warn(`Could not read the trash directory ${root}: ${err.message}`);
    return listing;
  }

  for (const name of names.sort()) {
    const full = join(root, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }

    const manifest = readManifest(full);
    const quarantinedAt = Date.parse(manifest?.quarantinedAt ?? "");
    // The sweep keeps anything it cannot date, forever. Say so, rather than
    // showing a countdown that will never reach zero.
    const sweepable = Number.isFinite(quarantinedAt) && now - quarantinedAt >= 0;
    const restoreBlocker = restoreBlockerFor(manifest);

    let diskUsage: WorktreeDiskUsage | undefined;
    if (opts?.includeDiskUsage) diskUsage = budget.measure(full);

    const entry: TrashEntryView = {
      entry: name,
      ...(manifest?.workspaceId && { workspaceId: manifest.workspaceId }),
      ...(manifest?.originalPath && { originalPath: manifest.originalPath }),
      ...(manifest?.repoPath && { repoPath: manifest.repoPath }),
      ...(manifest?.branch && { branch: manifest.branch }),
      ...(manifest?.quarantinedAt && { quarantinedAt: manifest.quarantinedAt }),
      ...(sweepable
        ? { expiresAt: new Date(quarantinedAt + TRASH_RETENTION_MS).toISOString() }
        : {
            sweepBlocked: manifest
              ? "its manifest has no usable quarantinedAt, so the sweep will never take it"
              : `it has no readable ${TRASH_MANIFEST_FILE}, so the sweep will never take it`,
          }),
      ...(diskUsage && { diskUsage }),
      restore: manifest?.restore ?? [],
      restorable: restoreBlocker === undefined,
      ...(restoreBlocker && { restoreBlocker }),
    };
    listing.entries.push(entry);
  }

  // Soonest to expire first: the entries a user has least time to rescue.
  listing.entries.sort((a, b) => (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999"));
  const diskUsageNote = budget.note(listing.entries.length);
  if (diskUsageNote) {
    log.warn(`Disk usage not measured for ${budget.skipped} trash entr(ies) — budget exhausted`);
    listing.diskUsageNote = diskUsageNote;
  }
  return listing;
}

function failure(entry: string, code: TrashRestoreFailure, detail: string): TrashRestoreResult {
  return { ok: false, entry, trashRetained: true, failure: { code, detail } };
}

// ── Copying the untracked files back ────────────────────────────────
//
// Written by hand rather than with `fs.cpSync`, for two independent reasons,
// and both of them are the difference between a bad restore and no daemon:
//
//  1. **`cpSync` cannot be caught.** It is implemented natively in Node 22, and
//     an unreadable directory anywhere in the tree throws a C++
//     `std::filesystem_error` that never becomes a JS exception: the process
//     calls `terminate()` and aborts (reproduced on v22.22.0, exit 134). One
//     root-owned directory from a container bind-mount inside a quarantined
//     `node_modules` would therefore take down the HTTP server, every SSE
//     stream and every running agent session — on the click labelled "Restore",
//     which is what a user reaches for when something has *already* gone wrong.
//  2. **A top-level loop loses subtrees.** `git worktree add` has just written
//     every tracked file, so every tracked top-level directory already exists;
//     skipping a name that exists means `backend/` is skipped whole and the
//     `backend/.env` underneath it — the exact file class quarantine exists to
//     protect — is silently left in the trash for the sweep to delete thirty
//     days later. plans/workspace-object.md names this trap by name.
//
// So: descend into a collision, and only ever skip a *leaf*. Every per-entry
// failure is caught, recorded against its path, and the walk continues — a
// restore that cannot read one directory still restores everything else, and
// says exactly what it could not bring back.

interface CopyTally {
  copied: number;
  skipped: string[];
  skippedCount: number;
  failed: Array<{ path: string; error: string }>;
  failedCount: number;
}

function newTally(): CopyTally {
  return { copied: 0, skipped: [], skippedCount: 0, failed: [], failedCount: 0 };
}

function noteSkip(tally: CopyTally, path: string): void {
  tally.skippedCount++;
  if (tally.skipped.length < REPORTED_PATH_CAP) tally.skipped.push(path);
}

function noteFailure(tally: CopyTally, path: string, error: string): void {
  tally.failedCount++;
  if (tally.failed.length < REPORTED_PATH_CAP) tally.failed.push({ path, error });
}

/** `lstat`, or undefined when there is nothing there. Never follows a symlink. */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Read a directory, or say why not. The read is what may not be catchable elsewhere. */
function readDirOrError(path: string): { entries: Dirent[] } | { error: string } {
  try {
    return { entries: readdirSync(path, { withFileTypes: true }) };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

/**
 * Merge `source` into `destination`, leaf by leaf.
 *
 * `destination` is assumed to exist. Anything already there wins and is
 * recorded as a skip; anything that cannot be read, written or reproduced is
 * recorded as a failure and the walk carries on.
 */
function mergeCopy(source: string, destination: string, entries: Dirent[], prefix: string, tally: CopyTally, atRoot: boolean): void {
  for (const entry of entries) {
    if (atRoot && NEVER_RESTORED.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);

    let info: Stats | undefined;
    try {
      info = lstatSync(from);
    } catch (err: any) {
      noteFailure(tally, relative, `could not be inspected: ${err.message}`);
      continue;
    }

    // Existence is checked with `lstat`: a dangling symlink at the destination
    // is something, and writing "through" it would put the file somewhere else
    // entirely.
    const existing = lstatOrUndefined(to);

    if (info.isDirectory()) {
      if (existing && !existing.isDirectory()) {
        noteSkip(tally, relative);
        continue;
      }
      // Read before creating: an unreadable directory must not leave an empty
      // shell of itself in the restored checkout.
      const read = readDirOrError(from);
      if ("error" in read) {
        noteFailure(tally, relative, `could not be read (${read.error}); nothing under it was restored`);
        continue;
      }
      if (!existing) {
        try {
          mkdirSync(to);
        } catch (err: any) {
          noteFailure(tally, relative, `could not be created (${err.message}); nothing under it was restored`);
          continue;
        }
      }
      mergeCopy(from, to, read.entries, relative, tally, false);
      // Mode and timestamps last, so the directory stays writable while its
      // children are being written into it.
      if (!existing) {
        try {
          chmodSync(to, info.mode & 0o7777);
          utimesSync(to, info.atime, info.mtime);
        } catch {
          // Cosmetic. The contents are what matter, and they are there.
        }
      }
      continue;
    }

    if (existing) {
      noteSkip(tally, relative);
      continue;
    }

    try {
      if (info.isSymbolicLink()) {
        symlinkSync(readlinkSync(from), to);
      } else if (info.isFile()) {
        copyFileSync(from, to);
        utimesSync(to, info.atime, info.mtime);
      } else {
        noteFailure(tally, relative, "is a socket, fifo or device node and cannot be copied — it is still in the trash entry");
        continue;
      }
      tally.copied++;
    } catch (err: any) {
      noteFailure(tally, relative, err.message || String(err));
    }
  }
}

/**
 * Which `git worktree add` recreates the recorded commit, and how.
 *
 * The manifest records a branch *name*, and a name is not a commit. If the
 * branch was deleted while the directory sat in the trash, `git worktree add
 * <path> <branch>` DWIMs the name against the remote: a different tree, checked
 * out under the right name, with the untracked files copied on top and a
 * cheerful `ok: true`. Reproduced — quarantined at `d72a6f21`, restored at
 * `52f81bef`, reported clean.
 *
 * So the commit decides and the name only labels:
 *
 *  - branch still at the recorded commit → check it out (the ordinary case);
 *  - branch gone → recreate it, *at the recorded commit*;
 *  - branch moved → check the recorded commit out detached, and say so, rather
 *    than follow a name to a tree the user never quarantined.
 */
function worktreeAddArgs(
  repoPath: string,
  originalPath: string,
  branch: string,
  headSha?: string,
): { args: string[]; outcome: TrashRestoreBranchOutcome } | { error: string } {
  if (!headSha) return { args: ["worktree", "add", originalPath, branch], outcome: "branch-unverified" };
  if (!resolveCommit(repoPath, headSha)) {
    return {
      error:
        `the commit ${headSha} this worktree was quarantined at is not in ${repoPath} any more, so the checkout cannot be recreated at it. ` +
        `Its contents are intact in the trash entry — copy them out by hand`,
    };
  }
  // `refs/heads/` on purpose: an unqualified name would resolve against the
  // remote, which is the very fallback being guarded against.
  const branchAt = resolveCommit(repoPath, `refs/heads/${branch}`);
  if (branchAt === headSha) return { args: ["worktree", "add", originalPath, branch], outcome: "branch" };
  if (branchAt === undefined) return { args: ["worktree", "add", "-b", branch, originalPath, headSha], outcome: "branch-recreated" };
  return { args: ["worktree", "add", "--detach", originalPath, headSha], outcome: "detached" };
}

/**
 * Put a quarantined worktree back where it came from.
 *
 * `git worktree add` recreates the tracked checkout **at the commit the
 * manifest recorded** (see {@link worktreeAddArgs} — the branch name labels it,
 * the SHA decides it), and then everything git does not track is copied out of
 * the trash entry by {@link mergeCopy}. The copy never overwrites: git has just
 * written the tracked files and they are authoritative, so a *leaf* that
 * already exists is skipped and reported — but a directory that already exists
 * is descended into, never skipped whole.
 *
 * The trash entry is left alone. A restore is therefore free to be wrong.
 */
export function restoreTrashEntry(entryName: string, opts?: { root?: string }): TrashRestoreResult {
  const root = opts?.root ?? trashRoot();
  // The entry is a directory *name*, never a path: a caller must not be able to
  // reach outside the trash root with `../`.
  if (!entryName || entryName.includes("/") || entryName.includes("\\") || entryName === "." || entryName === "..") {
    return failure(entryName, "entry-not-found", "A trash entry is named by its directory name, not by a path");
  }
  const full = join(root, entryName);
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    return failure(entryName, "entry-not-found", `No trash entry named ${entryName} under ${root}`);
  }

  const manifest = readManifest(full);
  if (!manifest) {
    return failure(entryName, "no-manifest", `${entryName} has no readable ${TRASH_MANIFEST_FILE}. Its contents are intact — copy them out by hand.`);
  }
  const { originalPath, repoPath, branch } = manifest;
  if (!originalPath || !repoPath || !branch) {
    return failure(
      entryName,
      "incomplete-manifest",
      `${entryName}'s manifest does not record all of the original path, repository and branch, so the checkout cannot be recreated. Its contents are intact — copy them out by hand.`,
    );
  }
  if (existsSync(originalPath)) {
    return failure(
      entryName,
      "destination-occupied",
      `${originalPath} exists again. Nothing was written: restoring over a directory that has come back is not a decision Callboard makes. Move it aside and retry, or copy out of ${full} by hand.`,
    );
  }
  if (!existsSync(repoPath)) {
    return failure(entryName, "worktree-add-failed", `The repository ${repoPath} is no longer there, so "git worktree add" has nothing to run against`);
  }

  const add = worktreeAddArgs(repoPath, originalPath, branch, manifest.headSha);
  if ("error" in add) {
    return failure(entryName, "worktree-add-failed", `${entryName} cannot be restored: ${add.error}. Nothing was written and ${full} is untouched.`);
  }
  try {
    execFileSync("git", ["-C", repoPath, ...add.args], { encoding: "utf8", stdio: "pipe" });
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim();
    return failure(
      entryName,
      "worktree-add-failed",
      `git ${add.args.join(" ")} failed: ${detail}. Nothing was copied and ${full} is untouched.`,
    );
  }

  // Copy back what git does not track. Every failure below is per-path: the
  // walk continues, and what it could not bring back is returned rather than
  // thrown away — see the block comment above mergeCopy.
  const tally = newTally();
  const read = readDirOrError(full);
  if ("error" in read) {
    return {
      ok: false,
      entry: entryName,
      originalPath,
      copiedEntries: 0,
      restoredCommit: manifest.headSha,
      branchOutcome: add.outcome,
      trashRetained: true,
      failure: {
        code: "copy-failed",
        detail:
          `The checkout at ${originalPath} was recreated, but the trash entry ${full} could not be read (${read.error}), so none of the ` +
          `untracked or ignored files were copied back. Everything is still in ${full}.`,
      },
    };
  }
  mergeCopy(full, originalPath, read.entries, "", tally, true);

  const counts = {
    copiedEntries: tally.copied,
    ...(tally.skippedCount > 0 && { skippedEntries: tally.skipped, skippedCount: tally.skippedCount }),
    ...(tally.failedCount > 0 && { failedEntries: tally.failed, failedCount: tally.failedCount }),
    ...(manifest.headSha && { restoredCommit: manifest.headSha }),
    branchOutcome: add.outcome,
  };

  log.info(
    `Restored ${entryName} → ${originalPath} (${tally.copied} files copied, ${tally.skippedCount} already present, ` +
      `${tally.failedCount} could not be copied, branch ${add.outcome}); trash entry retained`,
  );

  // A restore that could not bring some paths back is **not** ok. Reporting
  // success with a failure list beside it is how a user learns to read past the
  // list; the whole point of the trash is that the originals are still there to
  // fetch by hand, and they have to be told to go and do that.
  if (tally.failedCount > 0) {
    log.warn(`Restore of ${entryName} could not copy ${tally.failedCount} path(s): ${tally.failed.map((f) => f.path).join(", ")}`);
    return {
      ok: false,
      entry: entryName,
      originalPath,
      ...counts,
      trashRetained: true,
      failure: {
        code: "copy-failed",
        detail:
          `The checkout at ${originalPath} was recreated and ${tally.copied} file(s) were copied back, but ${tally.failedCount} path(s) could not be ` +
          `copied and are still only in ${full}. Copy them out by hand before the retention sweep takes the entry.`,
      },
    };
  }

  return { ok: true, entry: entryName, originalPath, ...counts, trashRetained: true };
}

/** Absolute path of one trash entry. Exported for the route's error messages. */
export function trashEntryPath(entryName: string): string {
  return resolve(join(trashRoot(), entryName));
}
