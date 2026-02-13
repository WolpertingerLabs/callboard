export interface FolderItem {
  name: string;
  path: string;
  type: "directory" | "file";
  isHidden: boolean;
  size?: number;
  modified?: string;
  isGitRepo?: boolean;
  /** True if this directory is a git worktree checkout (`.git` is a file, not a directory) */
  isWorktree?: boolean;
  /** Branch checked out in this worktree */
  worktreeBranch?: string;
  /** Absolute path to the main repository (set when `isWorktree` is true) */
  mainRepoPath?: string;
}

/** A main git repository grouped with its sibling worktree directories */
export interface WorktreeGroup {
  mainRepo: FolderItem;
  worktrees: FolderItem[];
}

export interface BrowseResult {
  directories: FolderItem[];
  files: FolderItem[];
  parent: string | null;
  exists: boolean;
  currentPath: string;
  /** Directories grouped by worktree relationship (main repo + its worktrees) */
  worktreeGroups?: WorktreeGroup[];
}

export interface ValidateResult {
  valid: boolean;
  exists: boolean;
  readable: boolean;
  isGit?: boolean;
  isDirectory?: boolean;
}

export interface FolderSuggestion {
  path: string;
  name: string;
  description: string;
  type: "system" | "user" | "recent";
}
