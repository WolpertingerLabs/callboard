import { useState, useEffect, useCallback, useMemo } from "react";
import { GitBranch, GitFork, Sparkles } from "lucide-react";
import { getGitBranches, type BranchConfig } from "../api";
import { getUseWorktree, saveUseWorktree, getAutoCreateBranch, saveAutoCreateBranch } from "../utils/localStorage";
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
  const [autoCreateBranch, setAutoCreateBranch] = useState(() => getAutoCreateBranch());

  // Worktree only makes sense when there's a branch change:
  // - different base branch selected, OR
  // - new branch name entered manually, OR
  // - auto-create branch is checked (will create a new branch)
  const worktreeEnabled = baseBranch !== currentBranch || !!newBranch.trim() || autoCreateBranch;

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
    (base: string, newBr: string, worktree: boolean, wtEnabled: boolean, autoCreate: boolean) => {
      const config: BranchConfig = {};

      if (autoCreate && !newBr.trim()) {
        // Auto-create mode: backend will generate the branch name
        config.autoCreateBranch = true;
        config.baseBranch = base;
      } else if (newBr.trim()) {
        config.baseBranch = base;
        config.newBranch = newBr.trim();
      } else if (base !== currentBranch) {
        config.baseBranch = base;
      }

      // Only honor worktree when enabled (i.e. there's a branch change)
      if (wtEnabled && worktree) {
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
    propagateChange(baseBranch, newBranch, useWorktree, worktreeEnabled, autoCreateBranch);
  }, [baseBranch, newBranch, useWorktree, worktreeEnabled, autoCreateBranch, propagateChange, branchError]);

  // Persist worktree preference
  const handleWorktreeChange = useCallback((checked: boolean) => {
    setUseWorktree(checked);
    saveUseWorktree(checked);
  }, []);

  // Persist auto-create branch preference
  const handleAutoCreateBranchChange = useCallback((checked: boolean) => {
    setAutoCreateBranch(checked);
    saveAutoCreateBranch(checked);
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

  const hasChanges = baseBranch !== currentBranch || newBranch.trim() || autoCreateBranch || (worktreeEnabled && useWorktree);

  // The new branch text field is disabled when auto-create is checked
  const newBranchDisabled = autoCreateBranch;

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
      {newBranchDisabled ? (
        <div
          style={{
            flex: 1,
            padding: "4px 8px",
            fontSize: 12,
            fontFamily: "monospace",
            color: "var(--accent)",
            fontStyle: "italic",
            opacity: 0.85,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          Will auto-create new branch name
        </div>
      ) : (
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
      )}
    </div>
  );

  const autoCreateBranchToggle = (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        cursor: "pointer",
        fontSize: 12,
        color: autoCreateBranch ? "var(--accent)" : "var(--text-muted)",
        flexShrink: 0,
        userSelect: "none",
        fontWeight: autoCreateBranch ? 500 : 400,
        transition: "color 0.15s ease",
      }}
      title="Auto-generate a branch name from the first message"
    >
      <input
        type="checkbox"
        checked={autoCreateBranch}
        onChange={(e) => handleAutoCreateBranchChange(e.target.checked)}
        style={{ cursor: "pointer", margin: 0 }}
      />
      <Sparkles size={12} style={{ flexShrink: 0 }} />
      Auto-create
    </label>
  );

  const worktreeToggle = (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        cursor: worktreeEnabled ? "pointer" : "not-allowed",
        fontSize: 12,
        color: !worktreeEnabled ? "var(--text-muted)" : useWorktree ? "var(--accent)" : "var(--text-muted)",
        flexShrink: 0,
        userSelect: "none",
        fontWeight: worktreeEnabled && useWorktree ? 500 : 400,
        opacity: worktreeEnabled ? 1 : 0.5,
        transition: "color 0.15s ease, opacity 0.15s ease",
      }}
      title={worktreeEnabled ? undefined : "Select a different branch, enter a new branch name, or enable auto-create to use worktrees"}
    >
      <input
        type="checkbox"
        checked={worktreeEnabled && useWorktree}
        disabled={!worktreeEnabled}
        onChange={(e) => handleWorktreeChange(e.target.checked)}
        style={{ cursor: worktreeEnabled ? "pointer" : "not-allowed", margin: 0 }}
      />
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
        /* Mobile: multi-row layout */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Row 1: Base branch selector (full width) */}
          {baseBranchSelect}
          {/* Row 2: New branch input */}
          {newBranchInput}
          {/* Row 3: Toggles */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {autoCreateBranchToggle}
            {worktreeToggle}
          </div>
        </div>
      ) : (
        /* Desktop: two-row layout */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Row 1: Base branch + new branch input */}
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
          </div>
          {/* Row 2: Toggles */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, paddingLeft: 19 }}>
            {autoCreateBranchToggle}
            {worktreeToggle}
          </div>
        </div>
      )}

      {/* Validation error */}
      {branchError && !newBranchDisabled && (
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

      {/* Worktree path preview - only show when not auto-creating (we don't know the branch name yet) */}
      {worktreeEnabled && useWorktree && !autoCreateBranch && (
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
