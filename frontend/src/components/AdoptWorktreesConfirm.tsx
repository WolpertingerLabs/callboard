/**
 * The human confirmation in front of adoption.
 *
 * Phase 2b's honest limitation, in its own words: the backend cannot
 * distinguish "the user named this path" from "an agent named it." `POST
 * /adopt` takes paths and trusts them, because there is nothing at that layer
 * that could tell the difference. **This screen is the only place that gap is
 * closed** — a person reads the actual paths, in full, and says yes.
 *
 * Which is why it enumerates every path rather than saying "adopt 12
 * worktrees". A count is not a confirmation; it is a summary of one, and a user
 * who agrees to a count has not agreed to the list. The list is also why there
 * is no select-all anywhere upstream: ticking twelve boxes is tedious, and the
 * tedium is the safety feature.
 *
 * Adoption itself deletes nothing. It writes an identity token and an
 * `owned: true` record; removal stays a separate action behind every gate. That
 * is said here too, because a user who thinks "adopt" means "clean up" will
 * click it far too readily.
 */
import { Check, FolderGit2 } from "lucide-react";
import type { UnmanagedWorktree } from "../api";
import { formatDiskUsage } from "../utils/workspaceFormat";
import ModalOverlay from "./ModalOverlay";

interface Props {
  worktrees: UnmanagedWorktree[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function AdoptWorktreesConfirm({ worktrees, busy, onCancel, onConfirm }: Props) {
  return (
    <ModalOverlay style={{ zIndex: 1100 }}>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          width: "92%",
          maxWidth: 620,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "20px 24px 12px", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: 17, display: "flex", alignItems: "center", gap: 8 }}>
            <FolderGit2 size={17} style={{ color: "var(--accent)" }} />
            Adopt {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"}?
          </h2>
        </div>

        <div style={{ padding: "16px 24px", overflow: "auto" }}>
          <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 12, lineHeight: 1.5 }}>
            Callboard will mark these as its own to manage — writing an ownership token into each one and recording it. It does not delete, move or modify
            anything in them. Removal stays a separate, per-worktree action.
          </div>

          {/* Every path, in full. A count is not a confirmation. */}
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {worktrees.map((worktree) => {
              const size = formatDiskUsage(worktree.diskUsage);
              return (
                <li
                  key={worktree.path}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    background: "var(--bg-secondary)",
                  }}
                >
                  <div style={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", color: "var(--text)", wordBreak: "break-all" }}>{worktree.path}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span>{worktree.branch ?? "detached HEAD"}</span>
                    {size && <span>· {size}</span>}
                    {/*
                      Cleanliness is reported, never a gate here: a dirty
                      worktree is adopted happily and simply stays unremovable.
                      Refusing work-in-progress would leave it in the
                      unmanageable backlog forever.
                    */}
                    {!worktree.cleanliness.clean && <span style={{ color: "var(--warning)" }}>· has uncommitted or unpushed work</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div style={{ padding: "12px 24px 20px", display: "flex", gap: 12, justifyContent: "flex-end", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: busy ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              border: "none",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Check size={14} />
            {busy ? "Adopting…" : `Adopt ${worktrees.length === 1 ? "this worktree" : `these ${worktrees.length}`}`}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
