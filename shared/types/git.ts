export interface BranchConfig {
  baseBranch?: string;
  newBranch?: string;
  useWorktree?: boolean;
  autoCreateBranch?: boolean;
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
