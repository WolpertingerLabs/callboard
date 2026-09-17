/**
 * Repo scope and branch provenance for chat search.
 *
 * `search_chats({ repo })` answers "every chat that ran in this repository,
 * including its worktrees". The hard part is that **a worktree's directory is
 * routinely gone by the time anyone searches for it** — `git worktree remove`
 * leaves the transcripts, the chat records and the branch, and takes away the
 * only thing the old `find_chats` would accept as proof of membership: a live
 * `.git` that `resolveWorktreeToMainRepo` could follow back. On the corpus this
 * was measured against that gate hid 129 of 255 claude-code sessions (51%), in
 * 52 removed worktrees.
 *
 * So membership is derived from records first and the filesystem second, every
 * row says which rule admitted it, and — the part that took a review to get
 * right — a rule that can *admit* must also be able to *refuse*. The order is
 * strongest-evidence-first, not cheapest-first:
 *
 *  1. `exact`            — the folder *is* the repo.
 *  2. a workspace record on this `cwd` placing it in this repo, directly or
 *     through a `repoPath` that is itself a worktree of it → `workspace-record`.
 *     Records outlive the directories they describe, which is exactly the
 *     property the live-`.git` gate lacked.
 *  3. the directory **exists**:
 *       - inside the repo → `descendant`. Callboard spawns worktrees inside
 *         checkouts, and a chat run in any subdirectory is a chat in this repo.
 *       - git says worktree-of-this-repo → `live-git`. What `find_chats` used.
 *       - otherwise → **refused**. It is there, git was asked, the answer is no.
 *  4. the directory is **gone**, so nothing on disk can be asked:
 *       - a record naming a main checkout that verifiably is not this repo →
 *         **refused**. It has to answer here, before the inferences, or a name
 *         would claim a directory a record has already spoken for.
 *       - inside the repo → `descendant`; `<repo-name><sep>…` beside the repo →
 *         `sibling-path`, the rule that closes the 51%. Otherwise no answer.
 *
 * Two orderings in there are load-bearing and were both got wrong once.
 *
 * Step 3 does not *fall through*: a neighbour that exists and does not resolve
 * back is a different repo sharing a path prefix — `find_chats` rejected those
 * and so does this — and it must not get a second chance under step 4's lexical
 * rules. That is why `evaluate` returns {@link RepoVerdict} rather than an
 * optional `RepoSource`; see that type for how conflating "refused" with
 * "nothing to say" admitted a neighbouring repo and stamped it `descendant`.
 *
 * And admissions are read **before** refusals, across the whole bucket of
 * records on a cwd. A veto that ran first and short-circuited could not be
 * undone by anything downstream, which is how the fix for the first ordering
 * took out the rule it was protecting: measured over 174 live workspace cwds,
 * `sibling-path` went 1 → 0 and `refused` 0 → 28, and the one row lost was the
 * 51% rule's only live customer. Its record named `callboard.feat-ori-agent-…`,
 * a *worktree* of callboard — which is why `repoPath` is resolved rather than
 * string-compared, and why an unresolvable one never vetoes.
 *
 * Nothing here parses a `workspaceId`, and nothing keys on one: a repo is a
 * directory question, so it keys on `cwd` (see the `cwd` vs `workspaceId`
 * section of CLAUDE.md). Workspace records are read for the `cwd`/`repoPath`
 * pair they carry, not for identity.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Workspace } from "shared/types/workspace.js";
import { getGitInfo, resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { listWorkspaces, samePath } from "./workspace-store.js";

/** Which rule admitted a folder to a repo. Reported on every row. */
export type RepoSource = "exact" | "descendant" | "workspace-record" | "live-git" | "sibling-path";

/**
 * The three answers, and why "refused" is not just `null`.
 *
 * A caller has more than one spelling of a chat's working directory — the
 * record's, which is real, and the browse projection, which for a removed
 * directory is a best-effort decode of a path that may never have existed. If
 * the only two answers were "member" and "not member", a *refusal* on the real
 * spelling would look identical to having nothing to say, and the caller would
 * hand the fabricated spelling a second chance at the same question. It gets
 * one: `callboard-contrast-shots` decodes to `callboard/contrast/shots`, which
 * is lexically inside `callboard`, so a neighbouring repo is admitted and
 * stamped `descendant` — as fact, by the lexical rule, with the evidence that
 * says otherwise already discarded.
 *
 * So: `refused` means something that can actually answer *did* — git was asked
 * about a directory that is there, or a workspace record names a different main
 * checkout. `null` means nothing could be asked. Only `null` earns a second
 * spelling.
 */
export type RepoVerdict = RepoSource | "refused" | null;

/** Where a row's branch came from. `unknown` means nothing recorded one. */
export type BranchSource = "record" | "live-git" | "unknown";

/** `<repo-name><sep>…` beside the repo — both Callboard worktree conventions. */
const SIBLING_SEPARATORS = new Set([".", "-", "_"]);

/** Worktrees nest a level or two in practice; the bound is what stops a cycle. */
const NORMALISE_MAX_HOPS = 8;

/** Is `target` lexically inside `repo`? Says nothing about either existing. */
function isInside(repo: string, target: string): boolean {
  const rel = relative(repo, target);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Classify folders against one repo root.
 *
 * Memoised per folder: a query over a few thousand rows sees a few hundred
 * distinct directories, and the workspace registry is read once rather than per
 * row. Archived workspace records count — a record is evidence about the past,
 * and a removed worktree is entirely in the past.
 *
 * `repoPath` is **normalised to the main checkout** before anything is compared
 * against it. Callboard's normal mode is an agent running inside a worktree, so
 * `repo: process.cwd()` is both the natural value to pass and, taken verbatim,
 * the wrong one: `live-git` compares candidates' `mainRepoPath` against it, so
 * sibling worktrees would not match, the main checkout would not match (it is
 * not a worktree of anything), and `sibling-path` could not fire. The result
 * would be one worktree's chats reported with a confident total. The
 * normalisation is reported back as `repoRoot` rather than applied silently.
 */
export function createRepoScope(repoPath: string, records?: Workspace[]) {
  const given = resolve(repoPath);

  const workspaces = records ?? listWorkspaces();
  const byCwd = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    const key = resolve(workspace.cwd);
    const bucket = byCwd.get(key);
    if (bucket) bucket.push(workspace);
    else byCwd.set(key, [workspace]);
  }

  /**
   * The main checkout a `repoPath` names, or null when that cannot be checked.
   *
   * `repoPath` is written once at creation and **never re-normalised**, so a
   * worktree spawned from a worktree records its parent *worktree* as its repo
   * — a normal Callboard shape. Comparing the field verbatim therefore reads
   * "belongs to a worktree of callboard" as "does not belong to callboard".
   *
   * The null case is the load-bearing one. A `repoPath` naming a directory that
   * is gone (a repo that was moved or renamed) cannot be resolved, and
   * `samePath` degrades to a string compare when `realpathSync` throws — so
   * taking "unresolvable" as "some other repo" would make **every** record
   * refuse. On this machine 146 of 175 records name `/home/cybil/callboard`;
   * moving that directory once would empty every repo-scoped query.
   */
  const mainRepoCache = new Map<string, string | null>();
  const mainRepoOf = (candidate: string): string | null => {
    const key = resolve(candidate);
    if (!mainRepoCache.has(key)) {
      // Not there, so nothing can be verified — and an unverifiable claim must
      // never become a veto.
      const resolved = existsSync(key) ? resolve(resolveWorktreeToMainRepoCached(key).mainRepoPath) : null;
      mainRepoCache.set(key, resolved);
    }
    return mainRepoCache.get(key)!;
  };

  /**
   * Distinct `repoPath` values recorded against a cwd, strongest first.
   *
   * Several workspaces may share one `cwd` (supported, per CLAUDE.md) and they
   * need not agree. Ordering by whether the target is still on disk makes the
   * choice deterministic and prefers the claim that can actually be checked;
   * `listWorkspaces` orders by creation time, which is not a reason to believe
   * one record over another.
   */
  const recordedRepoPaths = (cwd: string): string[] => {
    const seen = new Set<string>();
    const found: string[] = [];
    for (const workspace of byCwd.get(cwd) ?? []) {
      if (!workspace.repoPath) continue;
      const candidate = resolve(workspace.repoPath);
      if (samePath(candidate, cwd) || seen.has(candidate)) continue;
      seen.add(candidate);
      found.push(candidate);
    }
    return found.sort((a, b) => Number(existsSync(b)) - Number(existsSync(a)) || a.localeCompare(b));
  };

  /**
   * Walk a caller-supplied path up to the main checkout it belongs to.
   *
   * Iterated rather than a single hop, because a worktree of a worktree needs
   * two: `createRepoScope("<nested worktree>")` used to produce a *worktree* as
   * its `repoRoot`, and that scope then refused the real repo — for the exact
   * usage the normalisation exists to serve, an agent passing its own cwd.
   * Git answers when the directory is there; a workspace record answers when it
   * is not. Bounded so a pair of records pointing at each other terminates.
   */
  const normalise = (start: string): string => {
    let current = resolve(start);
    for (let hop = 0; hop < NORMALISE_MAX_HOPS; hop++) {
      const live = resolveWorktreeToMainRepoCached(current);
      if (live.isWorktree && !samePath(live.mainRepoPath, current)) {
        current = resolve(live.mainRepoPath);
        continue;
      }
      if (existsSync(current)) return current;
      const [recorded] = recordedRepoPaths(current);
      if (!recorded) return current;
      current = recorded;
    }
    return current;
  };

  const repo = normalise(given);
  const repoParent = dirname(repo);
  const repoName = basename(repo);
  const cache = new Map<string, RepoVerdict>();

  /** Does any record on this cwd place it in this repo, directly or transitively? */
  const recordAdmits = (target: string) => recordedRepoPaths(target).some((p) => samePath(p, repo) || mainRepoOf(p) === repo);

  /**
   * Does a record on this cwd name a main checkout that verifiably is not this
   * repo? Scanned across the **whole** bucket rather than stopping at the first
   * non-matching record, which let a newer record naming another repo veto an
   * older one naming this one.
   */
  const recordRefuses = (target: string) =>
    recordedRepoPaths(target).some((p) => {
      const main = mainRepoOf(p);
      return main !== null && !samePath(main, repo);
    });

  function evaluate(folder: string): RepoVerdict {
    const target = resolve(folder);
    if (samePath(target, repo)) return "exact";

    // Records outlive the directories they describe, which is the property the
    // live-`.git` gate lacked. Admissions are read first and from every record
    // on the cwd — a veto that runs first and short-circuits cannot be undone
    // by anything downstream, and that is how the strongest rule for reaching
    // removed worktrees ended up unreachable.
    if (recordAdmits(target)) return "workspace-record";

    if (existsSync(target)) {
      // It is on disk, so the lexical relation is a fact about a real tree
      // rather than a guess about a decoded name — and a fact outranks a
      // `repoPath` field written once and never revisited. Callboard spawns
      // worktrees inside checkouts, and a chat run in any subdirectory is a
      // chat in this repo.
      if (isInside(repo, target)) return "descendant";
      const { isWorktree, mainRepoPath } = resolveWorktreeToMainRepoCached(target);
      if (isWorktree && samePath(mainRepoPath, repo)) return "live-git";
      // Asked and answered: a neighbour that shares the prefix is its own repo.
      return "refused";
    }

    // Gone. Nothing on disk can be asked, so a record naming another checkout
    // is the only thing that can answer — and it must answer before the path
    // inferences below, which would otherwise claim the directory on its name.
    if (recordRefuses(target)) return "refused";
    if (isInside(repo, target)) return "descendant";
    const name = basename(target);
    if (dirname(target) === repoParent && name.length > repoName.length && name.startsWith(repoName) && SIBLING_SEPARATORS.has(name[repoName.length])) {
      return "sibling-path";
    }
    return null;
  }

  return {
    /** The main checkout every classification is made against. */
    repoRoot: repo,
    /** Set when the caller named a worktree and this scope widened to its repo. */
    normalisedFrom: samePath(given, repo) ? null : given,
    /** How `folder` relates to this repo: admitted, refused, or unanswerable. */
    classify(folder: string): RepoVerdict {
      if (!folder) return null;
      if (!cache.has(folder)) cache.set(folder, evaluate(folder));
      return cache.get(folder)!;
    },
  };
}

/** Deep enough for a monorepo package path; short enough to stay a bounded walk. */
const GIT_DIR_SEARCH_DEPTH = 40;

/**
 * The nearest ancestor of `folder` (itself included) holding a `.git`, or null.
 *
 * Pure `existsSync`, deliberately. `getGitInfo` answers "am I in a repository?"
 * for a directory without its own `.git` by spawning `git rev-parse --git-dir`
 * with a five-second timeout — measured at **2.73 ms** per call against 0.03 ms
 * for a directory that has one. That is the shape a monorepo-style install is
 * made of (chats started in subdirectories), and at a few hundred distinct
 * folders per `branch=` query it is ~550 ms of blocked event loop, with a
 * worst case of one 5 s timeout per folder if git stalls on an index lock.
 * Unlike `grep` and `matchAdvanced` this path has no worker, no deadline and no
 * cap, so the fix is to not spawn: walking up for a `.git` answers the same
 * question with stat calls, and hands `getGitInfo` a directory it can serve
 * from its fast path.
 *
 * A worktree's `.git` is a file rather than a directory, which `existsSync`
 * covers either way.
 */
function nearestGitDir(folder: string): string | null {
  // A path that is not there has no branch, and walking up from it would find
  // an *ancestor's* — `/repo/feat/gone/worktree` reporting `main`. That is not
  // a cosmetic wrong stamp: it makes `recorded === null && live === null` false,
  // so a chat in a removed worktree with no recorded branch is dropped from a
  // `branch=` query as a proven mismatch instead of being counted as
  // unevaluable, and the total stays confidently wrong. The measured saving was
  // for *live* subdirectories, which this keeps.
  if (!existsSync(folder)) return null;
  let current = resolve(folder);
  for (let depth = 0; depth < GIT_DIR_SEARCH_DEPTH; depth++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Read the branch a directory currently has checked out, once per directory.
 *
 * Only consulted when the record has no branch or records a different one, so
 * the common case costs nothing.
 */
export function createLiveBranchResolver() {
  const cache = new Map<string, string | null>();
  return (folder: string): string | null => {
    if (!folder) return null;
    if (!cache.has(folder)) {
      let branch: string | null = null;
      try {
        const root = nearestGitDir(folder);
        // No `.git` anywhere above it: there is no branch to read, and asking
        // git would only spend a subprocess arriving at the same answer.
        if (root) {
          const info = getGitInfo(root);
          if (info.isGitRepo) branch = info.branch ?? null;
        }
      } catch {
        branch = null;
      }
      cache.set(folder, branch);
    }
    return cache.get(folder)!;
  };
}
