/**
 * Vault page (`/vault?caller=<alias>&tab=items|requests|grants`).
 *
 * Items is per caller (the selector); Requests and Grants span every caller.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Users } from "lucide-react";
import type { AdminCaller, AdminVaultStatus } from "drawlatch-admin-types";
import { api, isDaemonDown, VAULT_REQUESTS_CHANGED } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import GrantsTab from "./vault/GrantsTab";
import ItemsTab from "./vault/ItemsTab";
import RequestsTab from "./vault/RequestsTab";
import { usePolling } from "../hooks/usePolling";
import "./Vault.css";

interface TabDef {
  id: string;
  label: string;
}

const TABS: TabDef[] = [
  { id: "items", label: "Items" },
  { id: "requests", label: "Requests" },
  { id: "grants", label: "Grants" },
];

/** How often the pending-request count refreshes while the tab is visible. */
const STATUS_POLL_MS = 10_000;

export default function VaultPage() {
  const { daemon } = useDaemon();
  const [params, setParams] = useSearchParams();
  const [callers, setCallers] = useState<AdminCaller[] | null>(null);
  const [status, setStatus] = useState<AdminVaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const loadCallers = useCallback(async () => {
    const callersRes = await api.callers();
    if (isDaemonDown(callersRes)) {
      setError(callersRes.error);
      return;
    }
    setError(null);
    setCallers(callersRes);
  }, []);

  useEffect(() => {
    // Offline: drop the pending count rather than show a stale one.
    if (daemon === "down") setStatus(null);
    if (daemon !== "up") return;
    void loadCallers();
  }, [daemon, loadCallers]);

  // Keep the Requests count fresh (agents file requests at any time), and
  // follow decisions made in this tab (the sidebar badge listens too).
  // Polls overlap with those event-driven reloads; usePolling lets only the
  // newest write.
  const { refresh: loadStatus } = usePolling(
    async (ctx) => {
      const res = await api.vaultStatus();
      if (ctx.active() && !isDaemonDown(res)) setStatus(res);
    },
    STATUS_POLL_MS,
    { enabled: daemon === "up" },
  );

  useEffect(() => {
    const onChange = () => void loadStatus();
    window.addEventListener(VAULT_REQUESTS_CHANGED, onChange);
    return () => window.removeEventListener(VAULT_REQUESTS_CHANGED, onChange);
  }, [loadStatus]);

  // After a change: item counts live on the callers, the pending count on
  // the status.
  const reload = useCallback(() => {
    void loadCallers();
    void loadStatus();
  }, [loadCallers, loadStatus]);

  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "items";
  const requested = params.get("caller");
  const caller =
    callers?.find((c) => c.alias === requested) ??
    (requested === null ? callers?.[0] : undefined);

  const select = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) merged.set(k, v);
    setParams(merged, { replace: false });
  };

  // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    select({ tab: TABS[next].id });
    tabRefs.current[next]?.focus();
  };

  const pending = status?.pendingRequests ?? 0;
  const offline = daemon === "down";
  const noCallers = callers !== null && callers.length === 0;

  return (
    <>
      <header className="page-header dl-vault-header">
        <div className="dl-vault-heading">
          <h1 className="page-title">Vault</h1>
          <div className="page-subtitle">
            Encrypted per-caller items
            {status?.keyId && (
              <>
                {" "}
                · key id <span className="mono">{status.keyId}</span>
              </>
            )}
            {status && status.revision !== null && <> · revision {status.revision}</>}
          </div>
        </div>
        {tab === "items" && callers && callers.length > 0 && (
          <label className="dl-vault-caller-select">
            <span className="field-label dl-vault-caller-label">Caller</span>
            <select
              className="input"
              value={caller?.alias ?? ""}
              onChange={(e) => select({ caller: e.target.value })}
            >
              {caller === undefined && <option value="">Choose a caller…</option>}
              {callers.map((c) => (
                <option key={c.alias} value={c.alias}>
                  {c.name ? `${c.name} (${c.alias})` : c.alias}
                  {c.vaultItems !== null ? ` · ${c.vaultItems}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {offline && <DaemonOffline action="load the vault" />}
      {!offline && error && (
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load callers: {error}</span>
        </div>
      )}
      {!offline && status?.error && (
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>{status.error}</span>
        </div>
      )}

      <div className="dl-vault-tabs" role="tablist" aria-label="Vault sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`dl-vault-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="dl-vault-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`dl-vault-tab${tab === t.id ? " active" : ""}`}
            onClick={() => select({ tab: t.id })}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
            {t.id === "requests" && pending > 0 && (
              <span className="dl-vault-count">
                {pending}
                <span className="sr-only"> pending</span>
              </span>
            )}
          </button>
        ))}
      </div>

      <div id="dl-vault-panel" role="tabpanel" aria-labelledby={`dl-vault-tab-${tab}`}>
        {callers === null && daemon === "up" && !error && <LoadingState label="Loading the vault…" />}
        {/* The tabs stay mounted through an offline blip, so a dialog with
            typed values survives it (saving fails until the daemon is back). */}
        {tab === "items" && noCallers && (
          <EmptyState
            icon={<Users size={20} />}
            title="No callers yet"
            body="Each caller has its own vault. Create a caller first, then add items to it here."
            action={
              <Link to="/callers" className="btn btn-primary">
                Go to Callers
              </Link>
            }
          />
        )}
        {tab === "items" && !noCallers && callers !== null && caller === undefined && (
          <EmptyState
            icon={<Users size={20} />}
            title={`No caller named "${requested}"`}
            body="Choose a caller from the list above."
          />
        )}
        {tab === "items" && caller && (
          <ItemsTab key={caller.alias} caller={caller} onChanged={reload} />
        )}
        {tab === "requests" && (daemon === "up" || callers !== null) && (
          <RequestsTab onChanged={reload} />
        )}
        {tab === "grants" && (daemon === "up" || callers !== null) && (
          <GrantsTab onChanged={reload} />
        )}
      </div>
    </>
  );
}
