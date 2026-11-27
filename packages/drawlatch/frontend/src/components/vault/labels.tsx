/**
 * One set of labels and badges for vault kinds, modes and request states,
 * so the Items, Requests and Grants tabs and the dialogs say the same thing.
 */
import type {
  AdminVaultExposure,
  AdminVaultKind,
  AdminVaultRequestStatus,
} from "drawlatch-admin-types";

export const KIND_LABEL: Record<AdminVaultKind, string> = {
  token: "Token",
  password: "Password",
  note: "Note",
  "key-value": "Key/value set",
};

/** Inject (use by reference) or reveal (readable), as a badge. Used for an
 *  item's exposure and for the mode of a request or grant. */
export function ModeBadge({ mode }: { mode: AdminVaultExposure }) {
  return (
    <span className={`badge ${mode === "reveal" ? "badge-warning" : "badge-accent"}`}>
      {mode}
    </span>
  );
}

const STATUS_CLASS: Record<AdminVaultRequestStatus, string> = {
  pending: "badge-warning",
  granted: "badge-success",
  denied: "badge-danger",
  cancelled: "badge-muted",
  withdrawn: "badge-muted",
};

export function RequestStatusBadge({ status }: { status: AdminVaultRequestStatus }) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{status}</span>;
}
