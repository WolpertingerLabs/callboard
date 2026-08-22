/**
 * The confirmation in front of an archive — the step that turns "remove this
 * worktree" into an informed decision.
 *
 * This screen exists because of one specific failure the plan already
 * documents: **`.env` files are invisible to `git status` and travel with the
 * directory.** Every worktree on the author's machine has one, with 34 distinct
 * contents. The cleanliness gate cannot see them, quarantine deliberately does
 * not refuse on them, and so the *only* place a user finds out that their local
 * secrets and databases are about to move is here. If this component ever stops
 * rendering `ignored.entries`, that safety property is gone and nothing else in
 * the stack replaces it.
 *
 * It also states, in the same breath, that the move is reversible and how — a
 * confirmation that only lists consequences teaches people to click through it.
 */
import { AlertTriangle, ArrowRight, FileWarning, Trash2 } from "lucide-react";
import type { WorkspaceWithRemovability } from "../api";
import { formatDiskUsage } from "../utils/workspaceFormat";
import ModalOverlay from "./ModalOverlay";

interface Props {
  /**
   * **Removability-bearing on purpose.** Listings return `WorkspaceEntry`, which
   * has no verdict, so this prop cannot be satisfied by a row — only by a record
   * that has been evaluated. That is what keeps `ignored` (the reason this
   * screen exists) from quietly becoming undefined the day the listing stops
   * carrying verdicts, which is exactly the day this comment was written.
   */
  workspace: WorkspaceWithRemovability;
  /**
   * Chats that will be interrupted and archived along with it.
   *
   * **Required, and deliberately so.** This was optional, no caller passed it,
   * and the sentence it gates was therefore dead in production while its own
   * unit test — which passed a number in by hand — stayed green. An archive
   * interrupts every linked chat, so a confirmation that can be constructed
   * without knowing how many is a confirmation that can lie by omission; the
   * type is now what stops that, not a reviewer.
   */
  chatCount: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const labelStyle = { fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.4, color: "var(--text-muted)", marginBottom: 3 };
const valueStyle = { fontSize: 13, color: "var(--text)", wordBreak: "break-all" as const, fontFamily: "var(--font-mono, monospace)" };

export default function ArchiveWorkspaceConfirm({ workspace, chatCount, busy, onCancel, onConfirm }: Props) {
  const size = formatDiskUsage(workspace.diskUsage);
  const ignored = workspace.removability.ignored;

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
            <Trash2 size={17} style={{ color: "var(--danger)" }} />
            Archive “{workspace.name}” and move its worktree to the trash?
          </h2>
        </div>

        <div style={{ padding: "16px 24px", overflow: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* What moves, and where to. Spelled out rather than summarised. */}
          <div>
            <div style={labelStyle}>This directory moves</div>
            <div style={valueStyle}>{workspace.cwd}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
              <ArrowRight size={12} />
              <span>~/.callboard/trash{size ? ` · ${size}` : ""}</span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            {workspace.worktree?.branch && (
              <div>
                <div style={labelStyle}>Branch</div>
                <div style={valueStyle}>{workspace.worktree.branch}</div>
              </div>
            )}
            {workspace.repoPath && (
              <div>
                <div style={labelStyle}>Repository</div>
                <div style={valueStyle}>{workspace.repoPath}</div>
              </div>
            )}
          </div>

          {chatCount > 0 && (
            <div style={{ fontSize: 13, color: "var(--text)" }}>
              {chatCount} chat{chatCount === 1 ? "" : "s"} in this workspace will be interrupted and archived. Their logs are not moved or deleted.
            </div>
          )}

          {/*
            The ignored-entry preview. The reason this screen exists.
          */}
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 12,
              background: "var(--warning-bg)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--warning)", marginBottom: 6 }}>
              <FileWarning size={14} />
              Gitignored files move too
            </div>
            {ignored?.error ? (
              <div style={{ fontSize: 12, color: "var(--text)" }}>
                Callboard could not list them ({ignored.error}). They still move with the directory — assume local configuration and databases are among them.
              </div>
            ) : ignored && ignored.entries.length > 0 ? (
              <>
                <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 6 }}>
                  These are invisible to <code>git status</code>, so the cleanliness check did not look at them. They travel into the trash with the directory:
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text)", maxHeight: 150, overflow: "auto" }}>
                  {ignored.entries.map((entry) => (
                    <li key={entry} style={{ fontFamily: "var(--font-mono, monospace)", wordBreak: "break-all" }}>
                      {entry}
                    </li>
                  ))}
                </ul>
                {ignored.truncated && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>…and more; the list is capped.</div>}
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text)" }}>Git reports no ignored entries in this worktree.</div>
            )}
          </div>

          {/*
            Reversibility, stated. A confirmation that only lists consequences
            trains people to click past it; this one says what the escape hatch
            is, which is also the thing that makes the trash tab worth having.
          */}
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Nothing in this directory is deleted. It is moved in one atomic rename and the worktree is unregistered; you can restore it from the Trash tab, and
            the retention sweep only deletes it after 30 days.
          </div>

          {/*
            The sweep. `archiveWorkspace` ends by running it, so this click also
            permanently deletes every trash entry already past its 30 days —
            including entries belonging to workspaces that have nothing to do
            with this one. The previous copy said "Nothing is deleted", full
            stop, which was false about precisely the irreversible half.
          */}
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            One thing this click <em>does</em> delete: archiving runs the retention sweep, so any quarantined worktree already older than 30 days — from any
            workspace, not just this one — is permanently removed. Check the Trash tab first if something in there still matters.
          </div>
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
              background: "var(--danger-solid)",
              color: "var(--text-on-danger)",
              border: "none",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <AlertTriangle size={14} />
            {busy ? "Archiving…" : "Archive and move to trash"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
