/**
 * Workspace — the persisted "where work happens" entity: path, git isolation,
 * and (for worktrees) the *intent* that created it.
 *
 * See plans/workspace-object.md. Phase 1 is additive only: workspaces are
 * written when a chat is started with `useWorktree`, and nothing reads from
 * them yet. `Chat.folder`/`Chat.displayFolder` remain the truth for log paths.
 *
 * READ PRECEDENCE (applies from the moment anything starts reading these):
 * where a value could come from either the workspace record or a chat's path
 * fields, the workspace wins when present and the path fields are the fallback.
 * Never write both from different code paths.
 */

/** Whether work happens in the checkout as-is, or in a git worktree of it. */
export type WorkspaceIsolation = "local" | "worktree";

/**
 * Why a worktree exists — captured at creation time, because git cannot tell
 * us afterwards. "branch-off" created a new branch from a base; the other two
 * checked out something that already existed.
 */
export type WorktreeMode = "branch-off" | "checkout-branch" | "checkout-pr";

export interface WorkspaceWorktree {
  /**
   * True only when Callboard created this worktree. The safety property that
   * gates removal (Phase 2): a directory the user pointed us at is never ours
   * to delete, so anything we merely found on disk is `false`.
   */
  owned: boolean;
  mode: WorktreeMode;
  /** Branch checked out in the worktree. */
  branch: string;
  /** Base the branch was created from ("branch-off" only; absent means HEAD). */
  baseBranch?: string;
  /** PR the worktree was checked out for ("checkout-pr" only). */
  prNumber?: number;
}

export interface Workspace {
  /**
   * Opaque identifier. NEVER parse this back into a path, a branch, or
   * anything else — it carries no meaning beyond identity. Use `cwd` for the
   * directory and `worktree.branch` for the branch.
   */
  id: string;
  /** User-visible label. Renameable; defaults to the last segment of `cwd`. */
  name: string;
  /** Absolute path work happens in. */
  cwd: string;
  /** Main checkout, when `cwd` is a worktree of it. */
  repoPath?: string;
  isolation: WorkspaceIsolation;
  /** Present iff `isolation === "worktree"`. */
  worktree?: WorkspaceWorktree;
  status: "active" | "archived";
  createdAt: string;
  archivedAt?: string;
}

/** Create payload — everything a caller supplies; the store owns id/status/timestamps. */
export interface WorkspacePayload {
  /** Defaults to the last segment of `cwd` when omitted. */
  name?: string;
  cwd: string;
  repoPath?: string;
  isolation: WorkspaceIsolation;
  worktree?: WorkspaceWorktree;
}

// ── Removability (Phase 2) ──────────────────────────────────────────
//
// Whether a workspace's worktree may be removed, and — far more useful — why
// not. Every automatic removal is gated on this, and a caller that asked for
// an archive gets the blockers back so a refusal is legible rather than
// silent.
//
// "Removed" throughout this section means **quarantined**: moved to
// ~/.callboard/trash/ and unregistered with `git worktree prune`, never
// deleted. See utils/worktree-trash.ts for why, and for how to restore one.

/**
 * Why a worktree was NOT removed. Ordered from "never was a candidate" to
 * "would have destroyed work".
 */
export type WorkspaceRemovalBlocker =
  /** Not a worktree at all. A directory the user works in is never removed. */
  | "not-a-worktree"
  /** `worktree.owned` is false — Callboard did not create it. */
  | "not-owned"
  /** A worktree record with no `repoPath`; there is no repo to run removal from. */
  | "no-repo-path"
  /** The directory is already gone. Nothing to remove. */
  | "cwd-missing"
  /** The directory is no longer a worktree of the recorded repo. */
  | "not-a-worktree-on-disk"
  /**
   * No identity token. Every record written before Phase 2, and every worktree
   * the user recreated by hand. Reads as "not ours" and stays.
   */
  | "token-missing"
  /** A token naming a different workspace. */
  | "token-mismatch"
  /** Another active workspace still references this directory (ref-count > 0). */
  | "shared-cwd"
  /**
   * The worktree involves submodules. `mv` does not mind them, but the
   * `git worktree prune` that follows deletes the worktree's admin dir — and a
   * submodule initialised in a worktree keeps its **object database** there, so
   * pruning destroys submodule history that quarantine cannot give back.
   */
  | "has-submodules"
  /** Staged or unstaged modifications to tracked files. */
  | "uncommitted-changes"
  /** Untracked files in the working tree. */
  | "untracked-files"
  /** Commits reachable from HEAD and from no other ref. */
  | "unpushed-commits"
  /**
   * An agent session is still live in this directory, or one refused to stop
   * within the teardown timeout. Moving a directory out from under a running
   * subprocess is how a removal ends up half-done.
   */
  | "session-still-running"
  /** A git command failed, so cleanliness could not be established. Refuse. */
  | "git-check-failed"
  /** The trash directory is on another filesystem, so the move is not atomic. */
  | "quarantine-cross-device"
  /** Every check passed but the quarantine itself failed. Nothing was moved. */
  | "quarantine-failed";

export interface WorkspaceRemovalReason {
  code: WorkspaceRemovalBlocker;
  /** Human-readable detail — safe to surface directly. */
  detail: string;
}

/**
 * Gitignored entries that would travel into the trash with the directory.
 * Informational only — never a blocker (see utils/worktree-trash.ts).
 */
export interface WorkspaceIgnoredPreview {
  /** Collapsed paths relative to the worktree, capped. */
  entries: string[];
  truncated: boolean;
  /** Set when git could not be asked. Still not a blocker. */
  error?: string;
}

export interface WorkspaceRemovability {
  /** True only when every gate passed. Never inferred from an empty list. */
  removable: boolean;
  /** All blockers, not just the first — a caller should see every reason. */
  blockers: WorkspaceRemovalReason[];
  /**
   * What would move to the trash alongside the tracked files. Only computed
   * when `removable` is true: for a workspace that is staying put there is
   * nothing to preview, and the listing pays a git subprocess per entry.
   */
  ignored?: WorkspaceIgnoredPreview;
}

// ── Directory state ─────────────────────────────────────────────────
//
// Nothing reaps workspace records. `recordWorktreeWorkspace` archives a stale
// one only when a new record is written for the same path, so a worktree
// removed outside Callboard (`wt merge`, `git worktree remove`) leaves its
// record `active` forever: 7 of 10 on the author's machine point at
// directories that are gone.
//
// The fix is NOT to archive them automatically, and the reason is the same one
// that governs adoption: **absence of a directory is evidence, not proof.** An
// unmounted volume is indistinguishable from a deleted worktree, and the
// record is the only thing that remembers a worktree existed at all — archiving
// it on a `stat` that failed for an unrelated reason throws away the provenance
// that would let it be cleaned up later. So the state is *observed and
// reported*; acting on it is a user's decision, exactly as with adoption.

/**
 * What a record's directory looks like right now.
 *
 * **Computed on every read, never stored.** A stored flag is a claim about the
 * filesystem frozen at write time — it would go stale the moment a volume is
 * remounted, a worktree is restored from the trash, or a directory is recreated
 * by hand, and a stale "missing" is exactly the thing that would justify a
 * destructive cleanup that should never have run.
 */
export type WorkspaceDirectoryState =
  /** The directory exists, and still is what the record says it is. */
  | "present"
  /**
   * Nothing at `cwd`. Evidence, not proof — see above. Surface it so a user can
   * archive the record; never archive it on this basis alone.
   */
  | "missing"
  /**
   * The directory exists but is no longer a git worktree of the recorded
   * `repoPath` — pruned, converted to a plain directory, or recreated by hand.
   * Distinct from "missing": there is a directory here, and it may hold work.
   * Nothing here is Callboard's to remove either (Phase 2 blocks on
   * `not-a-worktree-on-disk`), so this is also report-only.
   *
   * Only reachable for a record that actually claims its `cwd` is a worktree —
   * i.e. `isolation: "worktree"` with a `repoPath` naming a *different*
   * directory. A `local` record describes a plain folder and is `present`
   * whenever it exists.
   */
  | "not-a-worktree";

/** A directory state with the sentence that explains it. */
export interface WorkspaceDirectory {
  state: WorkspaceDirectoryState;
  /** Human-readable, always set — safe to surface directly. */
  detail: string;
}

/** A workspace plus the freshly observed state of its directory. */
export interface WorkspaceWithRemovability extends Workspace {
  removability: WorkspaceRemovability;
  /**
   * Observed at read time, never persisted. A `missing` or `not-a-worktree`
   * entry is something to *offer* a user ("this record points at a directory
   * that no longer exists — archive it?"), never something to act on.
   */
  directory: WorkspaceDirectory;
  /**
   * Approximate size on disk. **Opt-in** (`includeDiskUsage`), because `du -sk`
   * over a worktree with a cold `node_modules` is seconds and this listing is
   * otherwise cheap enough to poll. Absent when it was not requested.
   *
   * It is here for the same reason it is on {@link UnmanagedWorktree}: "10
   * workspaces" is not a number anyone acts on, and "9.4 GB" is.
   */
  diskUsage?: WorktreeDiskUsage;
}

/**
 * The three independent things that make a worktree unsafe to remove, plus the
 * "a git command failed" case. Reported by `checkWorktreeClean` in
 * backend/src/utils/git.ts, whose `WorktreeCleanliness` is an alias of this —
 * one definition, so the shape a route returns and the shape the gate reads can
 * never drift apart.
 */
export interface WorkspaceCleanliness {
  /** True only when all three checks passed and no git command failed. */
  clean: boolean;
  uncommittedChanges: boolean;
  untrackedFiles: boolean;
  /** Commits reachable from HEAD and from no other ref in the repository. */
  unpushedCommits: boolean;
  /** Set when a git command failed; `clean` is then always false. */
  error?: string;
}

/**
 * What happened to the directory.
 *
 * `partial` is the honest answer to a failed removal, and it exists because the
 * previous design lied about one: `git worktree remove` can delete tracked
 * files, delete the admin dir and unregister the worktree and *still* exit
 * non-zero, which was reported as "kept". A record in that state can never be
 * cleaned up — the directory exists, it is no longer a worktree, and the
 * identity token that proved ownership is gone.
 */
export type WorktreeDisposition =
  /** Moved to the trash and unregistered. Restorable. */
  | "quarantined"
  /** Untouched: a gate refused, or there was no worktree to act on. */
  | "kept"
  /** Acted on and now in an inconsistent state. `state` says what was found. */
  | "partial";

/** What the directory looked like on re-inspection after a failed removal. */
export interface WorktreeInspection {
  cwdExists: boolean;
  /** Still listed by `git worktree list` in the recorded main repo. */
  registeredWorktree: boolean;
  /** The git admin dir (`<repo>/.git/worktrees/<slug>`) still resolves. */
  adminDirExists: boolean;
  /** The Callboard identity token is still readable there. */
  tokenPresent: boolean;
}

/** Result of the lifecycle archive (cascade + ref-counted worktree quarantine). */
export interface ArchiveWorkspaceResult {
  workspace: Workspace;
  /** Chats that belonged to the workspace, and whether a live session was stopped. */
  chats: Array<{ chatId: string; interrupted: boolean }>;
  worktree: {
    /**
     * True when the directory was moved into the trash. That includes a
     * `partial` outcome where the move landed but git's bookkeeping did not —
     * `disposition` is the field to branch on, this one only says whether the
     * directory is still where it was.
     */
    removed: boolean;
    /** Which of the three outcomes this was. */
    disposition: WorktreeDisposition;
    /** The directory that was (or was not) quarantined. */
    path: string;
    /** Where it went. Only set when `disposition === "quarantined"`. */
    trashPath?: string;
    /** Empty only when `removed` is true. */
    blockers: WorkspaceRemovalReason[];
    /** What was found on re-inspection. Only set when `disposition === "partial"`. */
    state?: WorktreeInspection;
    /** Ignored entries that moved with it. Only set when quarantined. */
    ignored?: WorkspaceIgnoredPreview;
  };
}

// ── Adoption (Phase 2b) ─────────────────────────────────────────────
//
// Phase 1 never infers ownership, which is right and which leaves every
// worktree that predates the entity `owned: false` and permanently untouchable
// by Phase 2. Adoption is the way out, and it is deliberately narrow: a human
// (or an agent acting on one's behalf) names specific paths, and only those are
// marked `owned`.
//
// ONE RULE GOVERNS THIS WHOLE SECTION:
//
//   **Pattern-matching may only ever be used to OFFER. It never ACTS.**
//
// Callboard has used at least two worktree naming conventions, so a path
// pattern is a guess about the past, not evidence. {@link WorktreeNamingGuess}
// therefore appears on the *discovery* type only — never on an adoption input,
// never on a workspace record, and nothing in the adoption path reads it.

/**
 * Which Callboard worktree naming convention a path looks like.
 *
 * A GUESS, always. `current` is the layout `ensureWorktree` produces today
 * (`<repo-parent>/<repo-name>.<branch-with-slashes-hyphenated>`); `legacy` is
 * the older `<repo-name>-wt-<suffix>` form. Neither proves Callboard created
 * anything — a user can make either by hand, and Callboard may have made a
 * worktree that matches neither (the path is derived from the branch name,
 * which changes).
 */
export type WorktreeNamingConvention = "current" | "legacy" | "unrecognized";

/**
 * The naming heuristic's opinion about one path. **Presentation only.** It
 * exists so a human deciding what to adopt can see "this looks like ours",
 * and it must never reach a decision — see the section header above.
 */
export interface WorktreeNamingGuess {
  convention: WorktreeNamingConvention;
  /** `convention !== "unrecognized"`. Convenience for a UI, not a permission. */
  matches: boolean;
  /** Human-readable, and honest about being a guess. Safe to surface directly. */
  detail: string;
}

/** Approximate on-disk size of a worktree. The number that motivates adoption. */
export interface WorktreeDiskUsage {
  /** Bytes, from `du -sk`. Absent when it could not be measured. */
  bytes?: number;
  /** Why there is no number: a `du` failure, a timeout, or a skipped budget. */
  error?: string;
}

/**
 * Why {@link UnmanagedWorktree} could not be adopted even if asked. Same codes
 * the adoption call returns, so discovery can show the refusal *before* anyone
 * tries. Cleanliness is deliberately not among them: a dirty worktree is
 * adoptable (cleanliness gates removal, not management).
 */
export type WorkspaceAdoptionRefusal =
  /** No git repository at the given repo path, or git could not be asked. */
  | "not-a-git-repo"
  /** The path is not in `git worktree list` for that repo. */
  | "not-a-registered-worktree"
  /** The main checkout (or a bare repo). Never adoptable, never removable. */
  | "main-checkout"
  /** An active workspace record already covers this directory. */
  | "already-managed"
  /**
   * No git admin dir resolves for the path, so the identity token cannot be
   * written. A record without a token could never be removed by Phase 2, so
   * creating one would be a lie about being managed.
   */
  | "admin-dir-unresolvable"
  /** Detached HEAD: git reports no branch, and a record requires one. */
  | "detached-head"
  /** The token write (or its read-back verification) failed. No record kept. */
  | "token-write-failed"
  /** The record itself could not be written. */
  | "record-write-failed";

/**
 * A git worktree with no active workspace record — an adoption *candidate*.
 *
 * Everything here is read-only observation. Producing this list creates no
 * record, writes no token and modifies nothing.
 */
export interface UnmanagedWorktree {
  /** Absolute, resolved. This is what the caller passes back to adopt it. */
  path: string;
  /** Null on a detached HEAD, which is also why it would refuse adoption. */
  branch: string | null;
  /** The main checkout it is registered against. */
  repoPath: string;
  /** HEURISTIC. Display only — see the section header. */
  naming: WorktreeNamingGuess;
  /** From the same `checkWorktreeClean` that gates removal in Phase 2. */
  cleanliness: WorkspaceCleanliness;
  /** What would travel into the trash if this were ever archived. */
  ignored: WorkspaceIgnoredPreview;
  diskUsage: WorktreeDiskUsage;
  /** True when {@link adoptionBlockers} is empty. */
  adoptable: boolean;
  adoptionBlockers: WorkspaceRefusalReason[];
}

/** A refusal code with the detail that explains it. */
export interface WorkspaceRefusalReason {
  code: WorkspaceAdoptionRefusal;
  detail: string;
}

/** Result of a read-only discovery pass over one repository. */
export interface UnmanagedWorktreeListing {
  /** The main checkout every path below is a worktree of. */
  repoPath: string;
  /** Registered worktrees, including the main checkout. */
  totalWorktrees: number;
  /** How many of those already have an active workspace record. */
  managedWorktrees: number;
  /** The candidates: registered, not the main checkout, and unmanaged. */
  worktrees: UnmanagedWorktree[];
  /** Set when the disk-usage budget ran out before every entry was measured. */
  diskUsageNote?: string;
}

/** What happened to one path in an adoption call. */
export interface WorkspaceAdoptionOutcome {
  /** The path as the caller gave it, resolved. */
  path: string;
  adopted: boolean;
  /** The record that was created. Only when `adopted`. */
  workspace?: Workspace;
  /** Why not. Only when `!adopted`. */
  refusal?: WorkspaceRefusalReason;
  /**
   * The Phase 2 verdict for the freshly adopted record — whether archiving it
   * would now quarantine the worktree, and every reason it would not. Adoption
   * never gates on this; it is reported so a caller can see, for instance, that
   * the worktree it just adopted is dirty and therefore still unremovable.
   */
  removability?: WorkspaceRemovability;
}

export interface AdoptWorktreesResult {
  outcomes: WorkspaceAdoptionOutcome[];
  adopted: number;
  refused: number;
}

// ── The list view (Phase 4a) ────────────────────────────────────────
//
// One row per **directory**, never per record. Phase 3 keys the sidebar on
// `cwd` because keying on the record splits one folder into two rows, and the
// registry-hygiene fix made that concrete: a `useWorktree` chat on the main
// checkout now writes a `local` record alongside a legacy `worktree` one, so
// `/home/cybil/callboard` legitimately has two active records. The row reports
// them as a list with a count; per-record detail is a drill-down.

/**
 * A workspace record as a directory *row* needs it.
 *
 * Deliberately NOT {@link WorkspaceWithRemovability}. The removal verdict runs
 * `git status`, `git rev-list`, a submodule scan and a token read per record —
 * fine for a user-initiated management view, far too much for a sidebar that
 * re-polls every fifteen seconds. Everything here is a registry read plus an
 * `lstat` of one `.git` entry.
 *
 * The row therefore says what it cheaply knows — this directory is gone, this
 * one is no longer a worktree, Callboard does not own this one — and sends the
 * user to the management view for the full gate. That split is why the sidebar
 * can afford to carry cleanup information at all.
 */
export interface FolderWorkspaceRecord {
  /** Opaque record id. Never parsed. */
  id: string;
  name: string;
  isolation: WorkspaceIsolation;
  /**
   * `worktree.owned` — false for a local record and for every worktree that
   * predates the entity. The single most common reason a directory cannot be
   * cleaned up, and the thing adoption exists to change.
   */
  owned: boolean;
  /** From `worktree.branch`; absent on a local record. */
  branch?: string;
  createdAt: string;
  /** Freshly observed, never stored. @see WorkspaceDirectoryState */
  directory: WorkspaceDirectory;
}

// ── Trash visibility ────────────────────────────────────────────────
//
// The retention sweep in utils/worktree-trash.ts is the one place Callboard
// deletes user data without being asked, and until this there was no way to see
// what was queued for it. Listing is read-only; restore copies out and leaves
// the trash entry exactly where it was.

/** One directory under ~/.callboard/trash, as a reader needs it. */
export interface TrashEntryView {
  /** Directory name under the trash root. This is what a restore names. */
  entry: string;
  /** Every field below is absent when the entry has no readable manifest. */
  workspaceId?: string;
  originalPath?: string;
  repoPath?: string;
  branch?: string;
  quarantinedAt?: string;
  /**
   * When the sweep would delete this entry. Absent when it never would —
   * an entry the sweep refuses to touch is kept forever, by design.
   */
  expiresAt?: string;
  /** Why the sweep will never take it. Set exactly when `expiresAt` is not. */
  sweepBlocked?: string;
  /** Opt-in, like everywhere else `du` appears. */
  diskUsage?: WorktreeDiskUsage;
  /** The recipe from the manifest, so it survives without Callboard. */
  restore: string[];
  /** True when a restore would have somewhere to land and something to run. */
  restorable: boolean;
  /** Why not. Set exactly when `restorable` is false. */
  restoreBlocker?: string;
}

export interface TrashListing {
  root: string;
  /** {@link TRASH_RETENTION_MS} in days, so a UI need not restate it. */
  retentionDays: number;
  entries: TrashEntryView[];
}

export type TrashRestoreFailure =
  /** No such directory under the trash root. */
  | "entry-not-found"
  /** No readable `.callboard-trash.json`, so there is no recipe to run. */
  | "no-manifest"
  /** The manifest is missing the repo, branch or original path. */
  | "incomplete-manifest"
  /** Something already exists at the original path. Never overwritten. */
  | "destination-occupied"
  /** `git worktree add` refused — branch checked out elsewhere, say. */
  | "worktree-add-failed"
  /** The checkout was recreated but copying the untracked files back failed. */
  | "copy-failed";

/**
 * Result of restoring one trash entry.
 *
 * `trashRetained` is always true and is stated rather than implied: a restore
 * **copies** the untracked and ignored files back and leaves the quarantined
 * directory alone, so a restore that goes wrong loses nothing. The entry ages
 * out through the normal sweep.
 */
export interface TrashRestoreResult {
  ok: boolean;
  entry: string;
  originalPath?: string;
  /** Top-level entries copied back out of the trash. */
  copiedEntries?: number;
  /** Paths that already existed in the recreated checkout and were left alone. */
  skippedEntries?: string[];
  trashRetained: true;
  failure?: { code: TrashRestoreFailure; detail: string };
}
