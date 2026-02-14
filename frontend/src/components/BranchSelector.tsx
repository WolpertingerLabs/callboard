import { useState, useEffect, useCallback, useMemo } from "react";
import { GitBranch, GitFork } from "lucide-react";
import { getGitBranches, type BranchConfig } from "../api";
import { getUseWorktree, saveUseWorktree } from "../utils/localStorage";
import { useIsMobile } from "../hooks/useIsMobile";

/**
 * Validate a git branch name according to git-check-ref-format rules.
 * Returns an error message string, or null if the name is valid.
 */
function validateBranchName(name: string): string | null {
  if (!name) return null; // empty is fine (field is optional)
  if (/\s/.test(name)) return "Branch name cannot contain spaces";
  if (/\.\./.test(name)) return 'Branch name cannot contain ".."';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f~^:?*\\]/.test(name)) return "Branch name contains invalid characters";
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return 'Branch name cannot start/end with "/" or end with "."';
  if (name.includes("@{")) return 'Branch name cannot contain "@{"';
  if (name.includes("//")) return "Branch name cannot contain consecutive slashes";
  if (name.endsWith(".lock")) return 'Branch name cannot end with ".lock"';
  if (name === "@") return '"@" is not a valid branch name';
  return null;
}

interface BranchSelectorProps {
  folder: string;
  currentBranch: string;
  onChange: (config: BranchConfig) => void;
}

export default function BranchSelector({ folder, currentBranch, onChange }: BranchSelectorProps) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [baseBranch, setBaseBranch] = useState(currentBranch);
  const [newBranch, setNewBranch] = useState("");
  const [useWorktree, setUseWorktree] = useState(() => getUseWorktree());

  // Fetch branches on mount
  useEffect(() => {
    setLoading(true);
    setError(null);
    getGitBranches(folder)
      .then((data) => {
        setBranches(data.branches);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [folder]);

  // Reset base branch when currentBranch changes
  useEffect(() => {
    setBaseBranch(currentBranch);
  }, [currentBranch]);

  // Propagate changes to parent
  const propagateChange = useCallback(
    (base: string, newBr: string, worktree: boolean) => {
      const config: BranchConfig = {};

      if (newBr.trim()) {
        config.baseBranch = base;
        config.newBranch = newBr.trim();
      } else if (base !== currentBranch) {
        config.baseBranch = base;
      }

      if (worktree) {
        config.useWorktree = true;
        // Always include baseBranch when using worktree so the backend knows context
        if (!config.baseBranch) {
          config.baseBranch = base;
        }
      }

      onChange(config);
    },
    [currentBranch, onChange],
  );

  // Validate new branch name
  const branchError = useMemo(() => validateBranchName(newBranch.trim()), [newBranch]);

  // Propagate on state changes (skip if branch name is invalid)
  useEffect(() => {
    if (branchError) return;
    propagateChange(baseBranch, newBranch, useWorktree);
  }, [baseBranch, newBranch, useWorktree, propagateChange, branchError]);

  // Persist worktree preference
  const handleWorktreeChange = useCallback((checked: boolean) => {
    setUseWorktree(checked);
    saveUseWorktree(checked);
  }, []);

  // Compute worktree path preview (mirrors backend ensureWorktree in git.ts)
  const effectiveBranch = newBranch.trim() || baseBranch;
  const sanitized = effectiveBranch.replace(/\//g, "-");
  const trimmedFolder = folder.replace(/\/+$/, ""); // strip trailing slashes like path.dirname
  const lastSlash = trimmedFolder.lastIndexOf("/");
  const repoName = lastSlash >= 0 ? trimmedFolder.slice(lastSlash + 1) : trimmedFolder || "repo";
  const parentDir = lastSlash >= 0 ? trimmedFolder.slice(0, lastSlash) : "";
  const worktreePath = `${parentDir}/${repoName}.${sanitized}`;

  const isMobile = useIsMobile();

  const hasChanges = baseBranch !== currentBranch || newBranch.trim() || useWorktree;

  // Shared sub-components
  const baseBranchSelect = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: isMobile ? 1 : undefined }}>
      <GitBranch size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
      {loading ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</span>
      ) : error ? (
        <span style={{ fontSize: 12, color: "var(--danger, #ef4444)" }}>{error}</span>
      ) : (
        <select
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          style={{
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            padding: "4px 8px",
            fontSize: 12,
            fontFamily: "monospace",
            cursor: "pointer",
            outline: "none",
            ...(isMobile ? { flex: 1, minWidth: 0 } : { maxWidth: 180 }),
          }}
        >
          {branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
              {branch === currentBranch ? " (current)" : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  const newBranchInput = (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: isMobile ? 0 : 120 }}>
      <input
        type="text"
        value={newBranch}
        onChange={(e) => setNewBranch(e.target.value)}
        placeholder="new-branch (optional)"
        style={{
          flex: 1,
          background: "var(--bg)",
          color: "var(--text)",
          border: branchError ? "1px solid var(--danger, #ef4444)" : "1px solid var(--border)",
          borderRadius: 5,
          padding: "4px 8px",
          fontSize: 12,
          fontFamily: "monospace",
          outline: "none",
          minWidth: 0,
          boxSizing: "border-box",
        }}
      />
    </div>
  );

  const worktreeToggle = (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        cursor: "pointer",
        fontSize: 12,
        color: useWorktree ? "var(--accent)" : "var(--text-muted)",
        flexShrink: 0,
        userSelect: "none",
        fontWeight: useWorktree ? 500 : 400,
        transition: "color 0.15s ease",
      }}
    >
      <input type="checkbox" checked={useWorktree} onChange={(e) => handleWorktreeChange(e.target.checked)} style={{ cursor: "pointer", margin: 0 }} />
      <GitFork size={12} style={{ flexShrink: 0 }} />
      Worktree
    </label>
  );

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        borderRadius: 10,
        padding: "10px 14px",
        marginBottom: 8,
        border: hasChanges ? "1px solid var(--accent)" : "1px solid transparent",
        transition: "border-color 0.2s ease",
      }}
    >
      {isMobile ? (
        /* Mobile: two-row layout */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Row 1: Base branch selector (full width) */}
          {baseBranchSelect}
          {/* Row 2: New branch input + worktree toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {newBranchInput}
            {worktreeToggle}
          </div>
        </div>
      ) : (
        /* Desktop: single-row inline layout */
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {baseBranchSelect}
          <span style={{ color: "var(--border)", fontSize: 14, userSelect: "none" }}>/</span>
          {newBranchInput}
          {worktreeToggle}
        </div>
      )}

      {/* Validation error */}
      {branchError && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--danger, #ef4444)",
            fontWeight: 500,
            paddingLeft: 19,
          }}
        >
          {branchError}
        </div>
      )}

      {/* Worktree path preview */}
      {useWorktree && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "monospace",
            wordBreak: "break-all",
            paddingLeft: 19,
            opacity: 0.8,
          }}
        >
          {worktreePath}
        </div>
      )}
    </div>
  );
}
