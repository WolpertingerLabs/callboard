/**
 * The directory name Callboard derives for a branch's worktree:
 * `<repo-name>.<branch, every "/" replaced by "-">`.
 *
 * The full path is that name beside the repository —
 * `<repo-parent>/<repo-name>.<sanitized-branch>` — which is what
 * `worktreePathForBranch` in `backend/src/utils/git.ts` builds by joining this
 * onto `dirname(repoDir)`. Only the name lives here: the parent-directory split
 * is `node:path`'s job on the backend, and this module has to run in a browser
 * bundle too.
 *
 * It lives in `shared/` because three callers need the same answer and only one
 * of them can create it. `ensureWorktreeDetailed` *makes* the directory,
 * `uniqueBranchName` asks whether it already exists, and the branch picker shows
 * the user where their chat is about to run. A picker that predicts
 * `repo.feat-a-b` for a directory git will actually make at `repo.feat-a/b` has
 * told the user something false, and nothing catches it — the two agree only by
 * being one function.
 *
 * The substitution is deliberately lossy and must stay that way: `feat/a-b` and
 * `feat/a/b` are different branches that collapse onto one directory. That
 * collision is not a bug to be escaped away here, it is the thing
 * `uniqueBranchName`'s path check exists to detect.
 *
 * Not to be confused with `backend/src/utils/worktree-naming.ts`, which guesses
 * — from a *directory* — whether Callboard might once have made it, across more
 * than one historical convention, and may only ever be used to offer.
 */
export function worktreeDirName(repoName: string, branch: string): string {
  return `${repoName}.${branch.replace(/\//g, "-")}`;
}

export interface BranchConfig {
  baseBranch?: string;
  newBranch?: string;
  useWorktree?: boolean;
  autoCreateBranch?: boolean;
  /** When true, skip the uncommitted-changes check before switching branches */
  forceBranchChange?: boolean;
}

/** Classification of a file in the diff */
export type DiffFileType = "text" | "binary" | "image" | "video";

/** Per-file metadata returned by the enhanced diff endpoint */
export interface DiffFileEntry {
  /** Relative path from repo root */
  filename: string;
  /** File status in the working tree */
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  /** Detected file type */
  fileType: DiffFileType;
  /** File size in bytes */
  size: number;
  /** Size of the diff/change content in bytes */
  changeSize: number;
  /** Whether the diff content is included in this response */
  contentIncluded: boolean;
  /** The unified diff content for this file (null if contentIncluded is false) */
  diff: string | null;
  /** Number of additions */
  additions: number;
  /** Number of deletions */
  deletions: number;
}

/** Response shape for GET /git/diff */
export interface GitDiffResponse {
  files: DiffFileEntry[];
}
