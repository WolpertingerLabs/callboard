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
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import type { TrashEntryView, TrashListing, TrashRestoreFailure, TrashRestoreResult, WorktreeDiskUsage } from "shared/types/index.js";
import { TRASH_MANIFEST_FILE, TRASH_RETENTION_MS, trashRoot, type TrashManifest } from "../utils/worktree-trash.js";
import { directoryDiskUsageCached } from "../utils/disk-usage.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-trash");

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
export function listTrash(opts?: { includeDiskUsage?: boolean; root?: string; now?: number }): TrashListing {
  const root = opts?.root ?? trashRoot();
  const now = opts?.now ?? Date.now();
  const listing: TrashListing = { root, retentionDays: Math.round(TRASH_RETENTION_MS / 86_400_000), entries: [] };

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
    if (opts?.includeDiskUsage) diskUsage = directoryDiskUsageCached(full);

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
  return listing;
}

function failure(entry: string, code: TrashRestoreFailure, detail: string): TrashRestoreResult {
  return { ok: false, entry, trashRetained: true, failure: { code, detail } };
}

/**
 * Put a quarantined worktree back where it came from.
 *
 * `git worktree add <path> <branch>` recreates the tracked checkout — the
 * manifest's own recipe, run rather than printed — and then everything git does
 * not track is copied out of the trash entry. The copy never overwrites: git
 * has just written the tracked files and they are authoritative, so a name that
 * already exists is skipped and reported.
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

  try {
    execFileSync("git", ["-C", repoPath, "worktree", "add", originalPath, branch], { encoding: "utf8", stdio: "pipe" });
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim();
    return failure(
      entryName,
      "worktree-add-failed",
      `git worktree add ${originalPath} ${branch} failed: ${detail}. Nothing was copied and ${full} is untouched.`,
    );
  }

  // Copy back what git does not track. `force: false` makes an existing name a
  // no-op rather than an overwrite, so the tracked files git just checked out
  // always win.
  let copied = 0;
  const skipped: string[] = [];
  try {
    for (const name of readdirSync(full)) {
      if (NEVER_RESTORED.has(name)) continue;
      const destination = join(originalPath, name);
      if (existsSync(destination)) {
        skipped.push(name);
        continue;
      }
      cpSync(join(full, name), destination, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
      copied++;
    }
  } catch (err: any) {
    return {
      ok: false,
      entry: entryName,
      originalPath,
      copiedEntries: copied,
      ...(skipped.length > 0 && { skippedEntries: skipped }),
      trashRetained: true,
      failure: {
        code: "copy-failed",
        detail: `The checkout at ${originalPath} was recreated, but copying the untracked files back failed after ${copied} entries: ${err.message}. Everything is still in ${full}.`,
      },
    };
  }

  log.info(`Restored ${entryName} → ${originalPath} (${copied} untracked entries copied, ${skipped.length} skipped); trash entry retained`);
  return {
    ok: true,
    entry: entryName,
    originalPath,
    copiedEntries: copied,
    ...(skipped.length > 0 && { skippedEntries: skipped }),
    trashRetained: true,
  };
}

/** Absolute path of one trash entry. Exported for the route's error messages. */
export function trashEntryPath(entryName: string): string {
  return resolve(join(trashRoot(), entryName));
}
