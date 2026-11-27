/**
 * EmptyState: "there is nothing here yet", with an optional icon, an
 * explanation and an action. LoadingState: the one loading line.
 *
 *   <EmptyState icon={<Inbox size={20} />} title="No pending requests"
 *     body="Agents ask for another caller's item with vault_request_access."
 *     action={<button className="btn btn-secondary">…</button>} />
 */
import type { ReactNode } from "react";

interface EmptyStateProps {
  /** A lucide icon at size 20, shown in a circle. */
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  /** Usually one `.btn` or a link. */
  action?: ReactNode;
  /** Less padding, for empty sections inside a card or tab. */
  compact?: boolean;
  className?: string;
}

export default function EmptyState({
  icon,
  title,
  body,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={["empty-state", compact ? "is-compact" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="empty-state-title">{title}</div>
      {body && <div className="empty-state-body">{body}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/** "Loading callers…" — pass what is loading; defaults to "Loading…". */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="banner banner-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
