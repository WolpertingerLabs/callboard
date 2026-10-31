import { ArrowRightLeft, GitFork } from "lucide-react";

/**
 * A chat-tree node's role, as shown in tree rows (sidebar and header
 * dropdown). Forks and engine switches get an icon — they are the common
 * case, and the word crowds a narrow row — every other role keeps its label.
 */
export default function ChatRoleBadge({ role }: { role: string }) {
  if (role === "fork" || role === "engine-switch") {
    const Icon = role === "fork" ? GitFork : ArrowRightLeft;
    const label = role === "fork" ? "Fork" : "Engine switch";
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
