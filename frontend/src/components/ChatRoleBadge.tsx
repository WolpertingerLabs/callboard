import { ArrowRightLeft, FoldVertical, GitFork, History, MessageSquareQuote, type LucideIcon } from "lucide-react";
import RunningDot from "./RunningDot";
import { attentionDot, attentionSuffix, NO_ATTENTION, type AsideAttention } from "../utils/asideAttention";
import { ASIDE_ROLE, PRE_COMPRESSION_ROLE, SUPERSEDED_ROLE } from "../utils/chatRewrite";

/**
 * Roles shown as an icon rather than a word. Forks and engine switches are the
 * common case, and the word crowds a narrow row; an original that a
 * continue-from or a compression replaced is labelled by what happened to it.
 */
const ICON_ROLES: Record<string, { Icon: LucideIcon; label: string }> = {
  fork: { Icon: GitFork, label: "Fork" },
  "engine-switch": { Icon: ArrowRightLeft, label: "Engine switch" },
  [ASIDE_ROLE]: { Icon: MessageSquareQuote, label: "Aside" },
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

/** `2 asides` — the one wording of an aside count, wherever it shows. */
export function asideCountLabel(count: number): string {
  return `${count} aside${count === 1 ? "" : "s"}`;
}

const ATTENTION_DOT: Record<Exclude<ReturnType<typeof attentionDot>, null | "running">, string> = {
  summoned: "var(--warning)",
  waiting: "var(--warning)",
  unread: "var(--chatlist-unread-dot)",
};

/**
 * The dot an aside count carries for its asides' attention signals — the most
 * pressing one (see `attentionDot`). Colour alone, so the caller names it.
 */
export function AsideAttentionDot({ attention }: { attention: AsideAttention }) {
  const dot = attentionDot(attention);
  if (!dot) return null;
  if (dot === "running") return <RunningDot style={{ width: 6, height: 6, marginLeft: 2 }} />;
  return (
    <span
      aria-hidden
      data-testid={`aside-attention-${dot}`}
      style={{ display: "inline-block", width: 6, height: 6, marginLeft: 2, borderRadius: "50%", flexShrink: 0, background: ATTENTION_DOT[dot] }}
    />
  );
}

/**
 * How many asides a chat has, where the sidebar shows the chat: asides are
 * folded into their parent's row rather than listed as rows of their own
 * (they open in the chat's side panel). Nothing for none.
 *
 * `attention` (utils/asideAttention.ts) adds a dot for what they need — a
 * summon, a prompt waiting, unread output, a live run — and says so in the
 * accessible name. Only the count: the row's own status stays the parent's.
 */
export function AsideCount({ count, attention = NO_ATTENTION }: { count: number; attention?: AsideAttention }) {
  if (count <= 0) return null;
  const label = asideCountLabel(count) + attentionSuffix(attention);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="aside-count"
      style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, fontSize: 10, color: "var(--chatlist-icon)" }}
    >
      <MessageSquareQuote size={11} aria-hidden />
      {count}
      <AsideAttentionDot attention={attention} />
    </span>
  );
}
