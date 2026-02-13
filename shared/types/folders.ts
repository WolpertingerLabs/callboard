export interface FolderItem {
  name: string;
  path: string;
  type: "directory" | "file";
  isHidden: boolean;
  size?: number;
  modified?: string;
  isGitRepo?: boolean;
}

export interface BrowseResult {
  directories: FolderItem[];
  files: FolderItem[];
  parent: string | null;
  exists: boolean;
  currentPath: string;
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
