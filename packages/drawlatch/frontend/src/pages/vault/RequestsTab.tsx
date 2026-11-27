/**
 * Vault → Requests: the pending access-request queue (Grant, Deny) and a
 * collapsible history. The reason is agent-written text: it is labelled as
 * such and rendered as plain text (React escapes it).
 *
 * Polls every 10s while the browser tab is visible, so a request an agent
 * files while the page is open shows up without a reload.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Check, Inbox, X } from "lucide-react";
import type { AdminVaultRequest } from "drawlatch-admin-types";
import { api, isDaemonDown, notifyVaultRequestsChanged } from "../../api";
import EmptyState, { LoadingState } from "../../components/EmptyState";
import {
  Binding,
  DenyRequestModal,
  GrantRequestModal,
} from "../../components/vault/RequestModals";
import { KIND_LABEL, ModeBadge, RequestStatusBadge } from "../../components/vault/labels";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePolling } from "../../hooks/usePolling";

const POLL_MS = 10_000;

type Load =
  | { status: "loading" }
  | { status: "ok"; data: AdminVaultRequest[] }
  | { status: "error"; message: string };

type Action =
  | { kind: "grant"; request: AdminVaultRequest }
  | { kind: "deny"; request: AdminVaultRequest };

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function ItemCell({ r }: { r: AdminVaultRequest }) {
  const isPending = r.status === "pending";
  return (
    <>
      <div className="cell-primary mono dl-vault-break">
        {r.owner}/{r.item?.name ?? r.itemName}
      </div>
      <div className="cell-secondary">
        {r.item === null ? (
          <span className="dl-vault-missing">
            {isPending ? "No such item: this request can only be denied" : "No such item"}
          </span>
        ) : (
          <>
            {KIND_LABEL[r.item.kind]} · {r.item.exposure}
            {r.item.name !== r.itemName && <> · asked as {r.itemName}</>}
            <div>
              <Binding item={r.item} grantee={r.requester} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Agent-written reason, clamped to three lines with "Show more". */
function ReasonCell({ r }: { r: AdminVaultRequest }) {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [r.reason, expanded]);

  return (
    <div className="dl-vault-reason">
      <div className="dl-vault-reason-label">
        Written by the requesting agent{" "}
        <span className="mono dl-vault-reason-who">{r.requester}</span>, not by the owner
      </div>
      <div ref={textRef} className={`dl-vault-reason-text${expanded ? "" : " is-clamped"}`}>
        {r.reason}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          className="dl-vault-more dl-tap-compact"
          aria-expanded={expanded}
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function DecisionButtons({
  r,
  onAction,
  full = false,
}: {
  r: AdminVaultRequest;
  onAction: (a: Action) => void;
  full?: boolean;
}) {
  const subject = `${r.requester}'s request for ${r.owner}/${r.itemName}`;
  return (
    <div className={full ? "dl-vault-card-actions" : "dl-vault-actions"}>
      {r.item !== null && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          aria-label={`Grant ${subject}`}
          onClick={() => onAction({ kind: "grant", request: r })}
        >
          <Check size={14} aria-hidden="true" />
          Grant
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-label={`Deny ${subject}`}
        onClick={() => onAction({ kind: "deny", request: r })}
      >
        <X size={14} aria-hidden="true" />
        Deny
      </button>
    </div>
  );
}

export default function RequestsTab({ onChanged }: { onChanged: () => void }) {
  const isMobile = useIsMobile();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [action, setAction] = useState<Action | null>(null);
  const lastPending = useRef<number | null>(null);

  // Refreshes overlap (the 10s poll, a visibility change, a decision just
  // made). usePolling lets only the newest run write: refresh() supersedes a
  // poll in flight, whose older answer would put a request you just granted
  // back in the queue.
  const { refresh } = usePolling(async (ctx) => {
    const res = await api.vaultRequests();
    if (!ctx.active()) return;
    if (isDaemonDown(res)) {
      // A failed poll keeps the list on screen; only the first load errors.
      setLoad((prev) => (prev.status === "ok" ? prev : { status: "error", message: res.error }));
      return;
    }
    setLoad({ status: "ok", data: res });
    // New or decided elsewhere: let the nav badge and tab count follow.
    const count = res.filter((r) => r.status === "pending").length;
    if (lastPending.current !== null && lastPending.current !== count) {
      notifyVaultRequestsChanged();
    }
    lastPending.current = count;
  }, POLL_MS);

  const done = () => {
    void refresh();
    onChanged();
  };
  const close = useCallback(() => setAction(null), []);

  const pending = load.status === "ok" ? load.data.filter((r) => r.status === "pending") : [];
  const history = load.status === "ok" ? load.data.filter((r) => r.status !== "pending") : [];

  return (
    <>
      <p className="detail-note dl-vault-intro">
        Agents ask for another caller&apos;s item with <code>vault_request_access</code>. Only
        you can grant or deny here; no agent tool can. Grant <strong>inject</strong> unless the
        agent really needs to read the value.
      </p>

      {load.status === "loading" && <LoadingState label="Loading requests…" />}
      {load.status === "error" && (
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load requests: {load.message}</span>
        </div>
      )}

      {load.status === "ok" && pending.length === 0 && (
        <EmptyState
          icon={<Inbox size={20} />}
          title="No pending requests"
          body="When an agent asks for another caller's item, the request waits here for you. This list refreshes on its own."
        />
      )}
      {pending.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table dl-vault-table has-actions">
            <thead>
              <tr>
                <th>Requester</th>
                <th>Item</th>
                <th>Mode asked</th>
                <th>Reason</th>
                <th className="dl-vault-col-optional">Asked</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id}>
                  <td className="mono dl-vault-break">{r.requester}</td>
                  <td className="dl-vault-item-cell">
                    <ItemCell r={r} />
                  </td>
                  <td>
                    <ModeBadge mode={r.mode} />
                  </td>
                  <td>
                    <ReasonCell r={r} />
                  </td>
                  <td className="dl-vault-col-optional">{formatTime(r.createdAt)}</td>
                  <td>
                    <DecisionButtons r={r} onAction={setAction} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pending.length > 0 && isMobile && (
        <ul className="mobile-card-list dl-vault-cards" aria-label="Pending requests">
          {pending.map((r) => (
            <li key={r.id} className="mobile-card">
              <div className="mobile-card-header">
                <div className="mobile-card-title">
                  <span className="mono">{r.requester}</span>
                  <span className="cell-muted"> asks for</span>
                </div>
                <ModeBadge mode={r.mode} />
              </div>
              <div>
                <ItemCell r={r} />
              </div>
              <ReasonCell r={r} />
              <div className="cell-secondary">Asked {formatTime(r.createdAt)}</div>
              <DecisionButtons r={r} onAction={setAction} full />
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <details className="dl-vault-history">
          <summary>History ({history.length})</summary>
          {!isMobile ? (
            <div className="data-table-wrap">
              <table className="data-table dl-vault-table">
                <thead>
                  <tr>
                    <th>Requester</th>
                    <th>Item</th>
                    <th>Mode asked</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td className="mono dl-vault-break">{r.requester}</td>
                      <td className="dl-vault-item-cell">
                        <ItemCell r={r} />
                      </td>
                      <td>
                        <ModeBadge mode={r.mode} />
                      </td>
                      <td>
                        <RequestStatusBadge status={r.status} />
                        {r.decidedNote && (
                          <div className="cell-secondary">Note: {r.decidedNote}</div>
                        )}
                      </td>
                      <td>
                        <ReasonCell r={r} />
                      </td>
                      <td>{r.decidedAt ? formatTime(r.decidedAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="mobile-card-list dl-vault-cards">
              {history.map((r) => (
                <li key={r.id} className="mobile-card">
                  <div className="mobile-card-header">
                    <div className="mobile-card-title mono">{r.requester}</div>
                    <RequestStatusBadge status={r.status} />
                  </div>
                  <div>
                    <ItemCell r={r} />
                  </div>
                  <div className="badge-row">
                    <span className="cell-muted">Asked for</span>
                    <ModeBadge mode={r.mode} />
                  </div>
                  {r.decidedNote && <div className="cell-secondary">Note: {r.decidedNote}</div>}
                  <ReasonCell r={r} />
                  {r.decidedAt && (
                    <div className="cell-secondary">Decided {formatTime(r.decidedAt)}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {action?.kind === "grant" && (
        <GrantRequestModal request={action.request} onClose={close} onDone={done} />
      )}
      {action?.kind === "deny" && (
        <DenyRequestModal request={action.request} onClose={close} onDone={done} />
      )}
    </>
  );
}
