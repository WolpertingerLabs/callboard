import { ArrowRightLeft, FoldVertical, GitFork, History, type LucideIcon } from "lucide-react";
import { PRE_COMPRESSION_ROLE, SUPERSEDED_ROLE } from "../utils/chatRewrite";

/**
 * Roles shown as an icon rather than a word. Forks and engine switches are the
 * common case, and the word crowds a narrow row; an original that a
 * continue-from or a compression replaced is labelled by what happened to it.
 */
const ICON_ROLES: Record<string, { Icon: LucideIcon; label: string }> = {
  fork: { Icon: GitFork, label: "Fork" },
  "engine-switch": { Icon: ArrowRightLeft, label: "Engine switch" },
  [SUPERSEDED_ROLE]: { Icon: History, label: "Original — replaced by a continuation from an earlier message" },
  [PRE_COMPRESSION_ROLE]: { Icon: FoldVertical, label: "Original — before compression" },
};

/** Whether `role` renders as an icon (and so suits a compact row). */
export function isIconRole(role: string | undefined): role is string {
  return !!role && role in ICON_ROLES;
}

/**
 * A chat-tree node's role, as shown in tree rows (sidebar and header
 * dropdown) and on a sidebar row for a chat that is itself a fork. Icon roles
 * get an icon; every other role keeps its label.
 */
export default function ChatRoleBadge({ role }: { role: string }) {
  const icon = ICON_ROLES[role];
  if (icon) {
    const { Icon, label } = icon;
    return (
      <span role="img" aria-label={label} title={label} style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>
        <Icon size={12} aria-hidden />
      </span>
    );
  }
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "1px 5px",
        borderRadius: 4,
        background: "var(--chatlist-badge-status-bg)",
        color: "var(--chatlist-badge-status-text)",
        flexShrink: 0,
      }}
    >
      {role}
    </span>
  );
}
