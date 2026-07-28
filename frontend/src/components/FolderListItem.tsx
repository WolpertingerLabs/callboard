import { useMemo } from "react";
import { GitBranch, Plus, Zap, Clock, Bell, Workflow, GitFork, HardDrive, AlertTriangle, Lock, Layers } from "lucide-react";
import type { FolderSummary } from "../api";
import { formatDiskUsage } from "../utils/workspaceFormat";
import ProviderBadge from "./ProviderBadge";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

interface Props {
  folder: FolderSummary;
  isActive?: boolean;
  onClick: () => void;
  onNewChat: () => void;
  /** Current time in ms, passed from parent to avoid impure render calls */
  now: number;
}

/**
 * The cheap half of "why can this not be cleaned up?".
 *
 * The full answer is a removal verdict that costs several git subprocesses per
 * record, so the row does not have it — the management view does. What the row
 * *does* have is the registry's own facts, and those cover the overwhelmingly
 * common case: Callboard did not create this worktree, so it will never remove
 * it, and adoption is the way out. On the author's machine that is 43 of 44
 * directories. Saying it on the row is the difference between a sidebar that
 * lists worktrees and one that explains them.
 */
function cleanupNote(folder: FolderSummary): { text: string; title: string; tone: "warn" | "muted" } | null {
  if (folder.directoryState === "missing") {
    return {
      text: "directory is gone",
      title: folder.directoryDetail ?? "The directory this workspace record points at no longer exists.",
      tone: "warn",
    };
  }
  if (folder.directoryState === "not-a-worktree") {
    return {
      text: "no longer a worktree",
      title: folder.directoryDetail ?? "This directory exists but is no longer a git worktree of the recorded repository.",
      tone: "warn",
    };
  }
  // Only worth saying about a worktree: a plain checkout is never Callboard's
  // to remove and nobody expects it to be.
  if (!folder.isWorktree) return null;
  const records = folder.workspaces ?? [];
  if (records.length === 0) {
    return {
      text: "unmanaged",
      title: "Callboard has no workspace record for this worktree, so it cannot clean it up. Adopt it from Manage worktrees to change that.",
      tone: "muted",
    };
  }
  if (!records.some((r) => r.owned)) {
    return {
      text: "not owned",
      title: "Callboard did not create this worktree, so it will never remove it. Adopt it from Manage worktrees to bring it under management.",
      tone: "muted",
    };
  }
  return null;
}

function formatRelativeTime(isoDate: string, now: number): string {
  const diff = now - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function FolderListItem({ folder, isActive, onClick, onNewChat, now }: Props) {
  const isStale = useMemo(() => now - new Date(folder.lastUpdatedAt).getTime() > TWELVE_HOURS_MS, [now, folder.lastUpdatedAt]);
  const isMissing = folder.directoryState === "missing";
  // There is nowhere to start a chat when the directory is gone. Better to say
  // so than to let the button open a chat that cannot spawn a process.
  const newChatDisabled = folder.status === "ongoing" || isMissing;
  const note = useMemo(() => cleanupNote(folder), [folder]);
  const size = formatDiskUsage(folder.diskUsage);
  const recordCount = folder.workspaces?.length ?? 0;

  return (
    <div
      onClick={onClick}
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid var(--chatlist-item-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        background: isActive ? "var(--chatlist-item-active-bg)" : "var(--chatlist-item-bg)",
        borderLeft: isActive ? "3px solid var(--chatlist-item-active-border)" : "3px solid transparent",
        opacity: isStale ? 0.5 : 1,
        transition: "opacity 0.2s",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* Row 1: Status dot + folder name + triggered/cron icon */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {folder.status === "ongoing" && (
            <span
              title="Running"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--status-green, #22c55e)",
                flexShrink: 0,
                boxShadow: "0 0 4px var(--status-green, #22c55e)",
              }}
            />
          )}
          {folder.status === "waiting" && (
            <span
              title="Waiting for input"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--warning, #f59e0b)",
                flexShrink: 0,
              }}
            />
          )}
          {folder.isTriggered && (
            <span
              title={folder.triggeredBy === "cron" ? "Cron job" : folder.triggeredBy === "job" ? "Job step" : "Triggered"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-badge-triggered-bg)",
                color: "var(--chatlist-badge-triggered-text)",
                flexShrink: 0,
              }}
            >
              {folder.triggeredBy === "cron" ? <Clock size={10} /> : folder.triggeredBy === "job" ? <Workflow size={10} /> : <Zap size={10} />}
            </span>
          )}
          {folder.hasSummon && (
            <span
              title="Attention needed"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-summon-bg)",
                color: "var(--chatlist-summon-text)",
                flexShrink: 0,
                animation: "pulse 2s ease-in-out infinite",
              }}
            >
              <Bell size={10} />
            </span>
          )}
          <ProviderBadge provider={folder.mostRecentChatProvider} compact />
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--chatlist-item-title-text)",
            }}
          >
            {folder.displayName}
          </div>
        </div>
        {folder.chatTitle && (
          <div
            title={folder.chatTitle}
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {folder.chatTitle}
          </div>
        )}

        {/* Row 2: Full path */}
        <div
          title={folder.folder}
          style={{
            fontSize: 12,
            color: "var(--chatlist-item-path-text)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
            textAlign: "left",
            // A path that is not there should not read like one that is.
            textDecoration: isMissing ? "line-through" : "none",
          }}
        >
          {folder.folder}
        </div>

        {/*
          The directory-state sentence, in full.

          A row whose directory is gone or is no longer a worktree must not look
          normal — that is the whole reason it is listed at all. The backend
          writes these sentences and they are surfaced verbatim: they explain
          what Callboard did *not* do (nothing) and what the user can do about
          it, which a two-word badge cannot.
        */}
        {note && note.tone === "warn" && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 4,
              fontSize: 11,
              lineHeight: 1.35,
              marginTop: 4,
              padding: "3px 6px",
              borderRadius: 4,
              background: "var(--warning-bg)",
              color: "var(--warning)",
            }}
          >
            <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{note.title}</span>
          </div>
        )}
        {folder.chatStatus && (
          <div
            title={folder.chatStatus}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              fontSize: 10,
              fontWeight: 500,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--chatlist-badge-status-bg)",
              color: "var(--chatlist-badge-status-text)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              width: "fit-content",
              maxWidth: "100%",
            }}
          >
            {folder.chatStatusEmoji && <span>{folder.chatStatusEmoji}</span>}
            {folder.chatStatus}
          </div>
        )}

        {/* Row 3: Timestamps + branch + chat count */}
        <div style={{ fontSize: 11, color: "var(--chatlist-item-time-text)", marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span title={`Created: ${new Date(folder.mostRecentChatCreatedAt).toLocaleString()}`}>
            Created {formatRelativeTime(folder.mostRecentChatCreatedAt, now)}
          </span>
          <span style={{ opacity: 0.5 }}>&middot;</span>
          <span title={`Updated: ${new Date(folder.lastUpdatedAt).toLocaleString()}`}>Updated {formatRelativeTime(folder.lastUpdatedAt, now)}</span>
          {folder.isGitRepo && folder.gitBranch && (
            <span
              title={`Branch: ${folder.gitBranch}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                padding: "0 5px",
                borderRadius: 3,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-item-time-text)",
                maxWidth: 140,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <GitBranch size={10} style={{ flexShrink: 0 }} />
              {folder.gitBranch}
            </span>
          )}
          {/*
            Worktree marker. `isWorktree` has been on FolderSummary all along
            and nothing rendered it, so a worktree row and a main-checkout row
            were indistinguishable in a sidebar that is mostly worktrees. It
            now comes from the workspace record where one exists, which is the
            observable part of this phase.
          */}
          {folder.isWorktree && (
            <span
              title={folder.repoPath ? `Worktree of ${folder.repoPath}` : "Git worktree"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                padding: "0 5px",
                borderRadius: 3,
                // Same tokens as the worktree tag in the chat header, so one
                // concept reads the same in both places.
                background: "var(--badge-worktree)",
                color: "var(--text-on-accent)",
                flexShrink: 0,
              }}
            >
              <GitFork size={10} style={{ flexShrink: 0 }} />
              worktree
            </span>
          )}
          {/*
            Size on disk. Opt-in — the parent only asks for it when the user
            turns sizes on — so its absence here is "not measured", never zero.
            It is the number the whole cleanup story is about: 43 directories is
            not something anyone acts on, 40 GB is.
          */}
          {size && (
            <span
              title={
                folder.diskUsage?.error ? `Disk usage: ${folder.diskUsage.error}` : `Approximately ${size} on disk (du -sk, measured at most every 5 minutes)`
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                padding: "0 5px",
                borderRadius: 3,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-item-time-text)",
                flexShrink: 0,
              }}
            >
              <HardDrive size={10} style={{ flexShrink: 0 }} />
              {size}
            </span>
          )}
          {/*
            Several workspace records on one directory. Supported, not a bug —
            and after the registry-hygiene fix a `useWorktree` chat on the main
            checkout produces exactly this. The row stays one row and says how
            many; the records themselves are a drill-down in Manage worktrees.
          */}
          {recordCount > 1 && (
            <span
              title={`${recordCount} workspace records share this directory. That is a supported state; open Manage worktrees to see them individually.`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                padding: "0 5px",
                borderRadius: 3,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-item-time-text)",
                flexShrink: 0,
              }}
            >
              <Layers size={10} style={{ flexShrink: 0 }} />
              {recordCount} workspaces
            </span>
          )}
          {note && note.tone === "muted" && (
            <span
              title={note.title}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                padding: "0 5px",
                borderRadius: 3,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-item-time-text)",
                flexShrink: 0,
                opacity: 0.85,
              }}
            >
              <Lock size={10} style={{ flexShrink: 0 }} />
              {note.text}
            </span>
          )}
          <span style={{ opacity: 0.5 }}>({folder.chatCount})</span>
        </div>
      </div>

      {/* New chat button */}
      <div style={{ marginLeft: 8, flexShrink: 0 }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!newChatDisabled) onNewChat();
          }}
          disabled={newChatDisabled}
          title={isMissing ? "The directory no longer exists" : newChatDisabled ? "Chat in progress" : "New chat in this folder"}
          style={{
            background: newChatDisabled ? "var(--bg-secondary)" : "var(--accent)",
            color: newChatDisabled ? "var(--text-muted)" : "var(--text-on-accent)",
            padding: "6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: newChatDisabled ? "not-allowed" : "pointer",
            opacity: newChatDisabled ? 0.4 : 1,
            border: "none",
          }}
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
