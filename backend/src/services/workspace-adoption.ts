/**
 * Adoption — bringing a worktree Callboard did not record under management.
 *
 * ## Why this exists
 *
 * Phase 1 never infers ownership: `owned: true` is written only when Callboard
 * observably ran `git worktree add`. That is the right default and it stays.
 * Its cost is that every worktree predating the entity is `owned: false` and
 * therefore permanently untouchable by Phase 2 — on the author's machine, 43
 * worktrees and roughly 40 GB that the lifecycle can do nothing with.
 *
 * Adoption is the way out, and it closes the gap without loosening a single
 * gate: a caller **names specific paths**, and only those are marked owned.
 *
 * ## The one rule
 *
 * **Pattern-matching may only ever be used to offer. It never acts.**
 *
 * There is no naming heuristic in this file, and it does not import
 * utils/worktree-naming.ts. That heuristic belongs to discovery, where it helps
 * a human choose; here it would be a regex concluding ownership, and Callboard
 * has used more than one naming convention, so the regex would be wrong in both
 * directions. Nothing below reads a path pattern. The only reason any directory
 * is adopted is that the caller wrote its path down.
 *
 * For the same reason there is no "adopt all". Discovery lists; the caller
 * decides; adoption acts on names. An agent looping over the list is fine —
 * the point is that the decision is explicit at every step, not that it is slow.
 *
 * ## `owned: true` has exactly two writers
 *
 * Before this file there was one: {@link recordWorktreeWorkspace} in
 * workspace-store.ts, which sets it from `created` — did *this call* run
 * `git worktree add`. {@link adoptWorktrees} is the second and last. If a third
 * ever appears, the `owned` gate has stopped meaning what Phase 2 assumes.
 *
 * ## What adoption does NOT do
 *
 * It deletes nothing and quarantines nothing. It writes an identity token and
 * creates a record — that is all. Removal stays a separate, explicitly
 * requested action behind every Phase 2 gate, and adopting a worktree does not
 * make it removable: a dirty one is adopted happily and Phase 2 still refuses
 * to touch it. Cleanliness gates removal, not management.
 *
 * ## Token before record
 *
 * The identity token is what makes an adopted worktree removable later
 * (utils/worktree-token.ts). A record with no token is the worst outcome
 * available here — it looks managed and can never be cleaned up. So the record
 * never outlives a failed token write: see {@link adoptOne} for why the
 * ordering has to be create-then-verify-then-roll-back rather than literally
 * token-first, and how the rollback is enforced.
 *
 * @see plans/workspace-object.md — Phase 2b
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";
import type { AdoptWorktreesResult, Workspace, WorkspaceAdoptionOutcome, WorkspaceRefusalReason, WorkspaceRemovability } from "shared/types/index.js";
import type { WorktreeInfo } from "../utils/git.js";
import { getGitWorktrees, resolveWorktreeToMainRepo } from "../utils/git.js";
import { verifyWorktreeToken, worktreeTokenPath, writeWorktreeToken } from "../utils/worktree-token.js";
import { createWorkspace, deleteWorkspace, listWorkspaces } from "./workspace-store.js";
import { evaluateWorktreeRemoval } from "./workspace-service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-adoption");

/**
 * The mode recorded for an adopted worktree.
 *
 * We were not there when it was made, so the intent is reconstructed from what
 * git can still be asked — the branch and the repo — and nothing else.
 * "checkout-branch" is the only honest one of the three: the branch existed
 * before the record did. "branch-off" would additionally claim we created that
 * branch from a base, which we cannot know and must not invent, so `baseBranch`
 * is left unset rather than guessed at "main".
 */
const ADOPTED_MODE = "checkout-branch" as const;

/** Compare two paths, tolerating `..`/`.` segments and symlinked parents. */
function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function refuse(code: WorkspaceRefusalReason["code"], detail: string): WorkspaceRefusalReason[] {
  return [{ code, detail }];
}

/**
 * Everything an evaluation needs that does not vary per path. Optional: a
 * single adoption builds its own. Discovery passes one shared across a whole
 * repository so N candidates do not mean N `git worktree list` runs and N
 * registry scans.
 */
export interface AdoptionContext {
  /** Resolved main checkout. */
  repoPath: string;
  /** `git worktree list` for that checkout, read once. */
  worktrees: WorktreeInfo[];
  /** Every active workspace, read once. */
  activeWorkspaces: Workspace[];
}

/** Build a context for one repository. */
export function newAdoptionContext(repoPath: string): AdoptionContext {
  const resolved = resolve(repoPath);
  return { repoPath: resolved, worktrees: getGitWorktrees(resolved), activeWorkspaces: listWorkspaces({ status: "active" }) };
}

/**
 * Resolve which repository a path belongs to, so a caller can name paths alone.
 *
 * Returns null when the path is not the root of a git worktree — deliberately
 * *not* an error here, because the caller of {@link evaluateAdoption} turns
 * that into a refusal with a message that can distinguish "the main checkout"
 * from "not a git worktree at all".
 */
function mainRepoFor(worktreePath: string): string | null {
  const resolution = resolveWorktreeToMainRepo(worktreePath);
  return resolution.isWorktree ? resolution.mainRepoPath : null;
}

/**
 * May this path be adopted, and if not, why not?
 *
 * Pure inspection: reads git, the filesystem and the registry, writes nothing.
 * Discovery calls it to show a refusal before anyone tries, and
 * {@link adoptOne} calls it again immediately before acting — the second call
 * is not redundant, it is the check that runs against the state at the moment
 * of the write.
 *
 * Cleanliness is deliberately absent from these gates. A worktree with
 * uncommitted work is a perfectly good thing to want managed; Phase 2 will
 * still refuse to remove it, which is where that question belongs.
 */
export function evaluateAdoption(
  worktreePath: string,
  ctx?: AdoptionContext,
): { cwd: string; repoPath?: string; branch?: string; blockers: WorkspaceRefusalReason[] } {
  const cwd = resolve(worktreePath);

  if (!existsSync(cwd)) {
    return { cwd, blockers: refuse("not-a-registered-worktree", `${cwd} does not exist`) };
  }

  // A `.git` *directory* is a main checkout (or a plain clone); a `.git` *file*
  // pointing into `<repo>/.git/worktrees/<slug>` is a linked worktree. Only the
  // second is adoptable, and telling the two apart is worth a distinct refusal:
  // "that is your repository, not a worktree of it" is a different mistake from
  // "that is not a git directory".
  const dotGit = join(cwd, ".git");
  if (!existsSync(dotGit)) {
    return { cwd, blockers: refuse("not-a-registered-worktree", `${cwd} is not the root of a git worktree (no .git there)`) };
  }
  try {
    if (lstatSync(dotGit).isDirectory()) {
      return {
        cwd,
        blockers: refuse("main-checkout", `${cwd} is a main git checkout, not a worktree of one. Callboard never manages the removal of a main checkout.`),
      };
    }
  } catch (err: any) {
    return { cwd, blockers: refuse("not-a-registered-worktree", `Could not inspect ${dotGit}: ${err.message}`) };
  }

  const repoPath = mainRepoFor(cwd);
  if (!repoPath) {
    return { cwd, blockers: refuse("not-a-registered-worktree", `${cwd} has a .git file but it does not resolve to a worktree of any repository`) };
  }

  const context = ctx && samePath(ctx.repoPath, repoPath) ? ctx : newAdoptionContext(repoPath);
  if (context.worktrees.length === 0) {
    return { cwd, repoPath, blockers: refuse("not-a-git-repo", `Could not list worktrees of ${repoPath} — git failed, or it is not a repository`) };
  }

  // Registration is asked of git, not inferred from the .git file: the question
  // is whether git still considers this a worktree it owns. A directory left
  // behind by a prune still has its .git file and is not registered.
  const entry = context.worktrees.find((wt) => samePath(wt.path, cwd));
  if (!entry) {
    return {
      cwd,
      repoPath,
      blockers: refuse("not-a-registered-worktree", `${cwd} is not listed by "git worktree list" in ${repoPath} — it may have been pruned already`),
    };
  }
  if (entry.isMainWorktree || entry.isBare) {
    return { cwd, repoPath, blockers: refuse("main-checkout", `${cwd} is the main worktree of ${repoPath}, which Callboard never manages for removal`) };
  }

  // From here on, git's spelling of the path wins over the caller's.
  //
  // This is the only place a path chosen by an arbitrary caller becomes a
  // workspace `cwd`, and `samePath` matched through symlinks to get here — so
  // the caller may have named a symlink pointing at the worktree. Recording
  // that spelling would leave `cwd` naming a link rather than a directory, and
  // Phase 2's quarantine is a `rename(2)` of `cwd`: it would move the *link*
  // and leave the worktree behind (reported as `partial`, destroying nothing,
  // but a mess to unpick). git reports the real directory it registered, and
  // that is what the record, the token and every later gate should name.
  const canonical = resolve(entry.path);

  const blockers: WorkspaceRefusalReason[] = [];

  // A record requires a branch, and so does the restore recipe a quarantine
  // writes (`git worktree add <path> <branch>`). Inventing one from the HEAD
  // sha would produce a record that cannot be restored from.
  const branch = entry.branch ?? undefined;
  if (!branch) {
    blockers.push({
      code: "detached-head",
      detail: `${canonical} has a detached HEAD, so git reports no branch for it. A workspace record needs one — check out a branch there first.`,
    });
  }

  // Already managed. Two independent ways, both meaning "someone else's".
  const existing = context.activeWorkspaces.filter((w) => samePath(w.cwd, canonical));
  if (existing.length > 0) {
    blockers.push({
      code: "already-managed",
      detail: `${canonical} already has ${existing.length} active workspace record(s): ${existing.map((w) => w.id).join(", ")}. Adoption is for unmanaged worktrees.`,
    });
  } else {
    // An identity token naming an *active* workspace whose cwd is elsewhere.
    // Rare, but overwriting that token would silently strip the other
    // workspace's proof of ownership and leave it unremovable forever.
    const token = safeReadToken(canonical);
    const owner = token ? context.activeWorkspaces.find((w) => w.id === token) : undefined;
    if (owner) {
      blockers.push({
        code: "already-managed",
        detail: `${canonical} already carries the identity token of active workspace ${owner.id} (recorded at ${owner.cwd}). Refusing to overwrite it.`,
      });
    }
  }

  // No admin dir, no token; no token, no removal. A record here would look
  // managed forever without ever being actionable — say so rather than create
  // one.
  const tokenPath = worktreeTokenPath(canonical);
  if (!tokenPath) {
    blockers.push({ code: "admin-dir-unresolvable", detail: `No git admin directory resolves for ${canonical}, so no identity token can be written` });
  } else if (!existsSync(dirname(tokenPath))) {
    blockers.push({
      code: "admin-dir-unresolvable",
      detail: `The git admin directory for ${canonical} (${dirname(tokenPath)}) does not exist, so no identity token can be written — and without one Phase 2 could never remove this worktree.`,
    });
  }

  return { cwd: canonical, repoPath, ...(branch && { branch }), blockers };
}

/** Read the token without letting a filesystem error become a throw. */
function safeReadToken(cwd: string): string | null {
  try {
    const path = worktreeTokenPath(cwd);
    if (!path || !existsSync(path)) return null;
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Adopt one named path.
 *
 * ### The ordering, and why it is not literally "token first"
 *
 * The token's *content* is the workspace id, and the id is minted by
 * {@link createWorkspace}. There is nothing to write before the record exists.
 * What matters is the invariant, not the instruction order:
 *
 *   **no record survives this function without a verified token.**
 *
 * So: create, write the token, read it back through the same verification the
 * removal gate uses, and on any failure delete the record again
 * ({@link deleteWorkspace} exists for exactly this — a record created as part
 * of a larger operation that then failed). The failure is reported as a
 * refusal, not swallowed.
 *
 * The one residual case — the token write fails *and* the rollback delete also
 * fails — cannot be made to disappear, so it is reported loudly. Note what it
 * leaves behind: an `owned: true` record with no token, which is precisely the
 * state of every pre-Phase-2 record, and which the removal gate refuses on
 * (`token-missing`). Useless, not dangerous.
 */
function adoptOne(worktreePath: string, ctx?: AdoptionContext): WorkspaceAdoptionOutcome {
  const evaluation = evaluateAdoption(worktreePath, ctx);
  const { cwd, repoPath, branch } = evaluation;
  if (evaluation.blockers.length > 0) {
    // Report the first blocker as *the* refusal; the rest are usually
    // consequences of it. Every one of them has been logged in the detail.
    return { path: cwd, adopted: false, refusal: evaluation.blockers[0] };
  }
  // Guaranteed by the gates above; the checks keep the compiler, and any future
  // reordering, honest.
  if (!repoPath || !branch) {
    return { path: cwd, adopted: false, refusal: { code: "not-a-registered-worktree", detail: `Could not resolve a repository and branch for ${cwd}` } };
  }

  let workspace: Workspace;
  try {
    workspace = createWorkspace({
      cwd,
      repoPath,
      isolation: "worktree",
      worktree: {
        // ── The second and last place `owned: true` is written. ──
        // The first is recordWorktreeWorkspace() in workspace-store.ts, where
        // it means "this call ran git worktree add". Here it means "a caller
        // named this exact path". Nothing else — no inference, no pattern, no
        // bulk sweep — may ever produce this value.
        owned: true,
        mode: ADOPTED_MODE,
        branch,
      },
    });
  } catch (err: any) {
    return { path: cwd, adopted: false, refusal: { code: "record-write-failed", detail: `Could not create a workspace record for ${cwd}: ${err.message}` } };
  }

  const written = writeWorktreeToken(cwd, workspace.id);
  const verdict = written ? verifyWorktreeToken(cwd, workspace.id) : "missing";
  if (verdict !== "verified") {
    const rolledBack = deleteWorkspace(workspace.id);
    const detail = rolledBack
      ? `Could not write a verifiable identity token into the git admin directory for ${cwd} (${verdict}). No record was kept: a workspace ` +
        `without a token looks managed but can never be removed, which is worse than not adopting it.`
      : `Could not write a verifiable identity token for ${cwd} (${verdict}), AND could not roll back workspace record ${workspace.id}. ` +
        `That record is owned with no token, so Phase 2 will refuse to remove its worktree (token-missing) — delete ` +
        `~/.callboard/workspaces/${workspace.id}.json by hand to clear it.`;
    log[rolledBack ? "warn" : "error"](detail);
    return { path: cwd, adopted: false, refusal: { code: "token-write-failed", detail } };
  }

  log.info(`Adopted worktree ${cwd} (branch ${branch}, repo ${repoPath}) as workspace ${workspace.id}`);

  // Reported, never gated on. This is where a caller sees that the worktree it
  // just adopted is dirty and therefore still unremovable — which is the
  // intended outcome, not a failure of the adoption.
  let removability: WorkspaceRemovability | undefined;
  try {
    removability = evaluateWorktreeRemoval(workspace);
  } catch (err: any) {
    log.warn(`Adopted ${cwd} but could not evaluate its removability: ${err.message}`);
  }

  return { path: cwd, adopted: true, workspace, ...(removability && { removability }) };
}

/**
 * Adopt the worktrees at the given paths. Nothing else.
 *
 * Every path is named by the caller. There is no discovery in here, on
 * purpose: an agent that wants to adopt several worktrees lists them with
 * {@link listUnmanagedWorktrees} and passes the ones it chose, which keeps the
 * choice visible at every step instead of collapsing it into one flag.
 *
 * Paths are independent — a refusal on one never stops the others, and each
 * outcome says what happened to its own path. Duplicates in the input are
 * collapsed rather than adopted twice; adopting an already-adopted path refuses
 * with `already-managed`, so the operation is safe to repeat.
 */
export function adoptWorktrees(paths: string[]): AdoptWorktreesResult {
  const seen = new Set<string>();
  const outcomes: WorkspaceAdoptionOutcome[] = [];
  // One context per repository, built lazily: adopting eight worktrees of one
  // repo should read `git worktree list` once. It is rebuilt after every
  // successful adoption because the registry it caches has just changed — a
  // stale copy is how the same path gets adopted twice in one call.
  let ctx: AdoptionContext | undefined;

  for (const raw of paths) {
    const cwd = resolve(String(raw ?? "").trim() || ".");
    if (seen.has(cwd)) continue;
    seen.add(cwd);

    const repoPath = mainRepoFor(cwd);
    if (repoPath && (!ctx || !samePath(ctx.repoPath, repoPath))) ctx = newAdoptionContext(repoPath);

    const outcome = adoptOne(cwd, ctx);
    outcomes.push(outcome);
    if (outcome.adopted) ctx = undefined;
  }

  return { outcomes, adopted: outcomes.filter((o) => o.adopted).length, refused: outcomes.filter((o) => !o.adopted).length };
}
