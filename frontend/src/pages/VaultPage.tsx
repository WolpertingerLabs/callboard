/**
 * Vault page (`/vault?caller=<alias>&tab=items`).
 *
 * Tabs are a list so later tabs (access requests, grants) slot in beside
 * Items without restructuring the page.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AdminCaller, AdminVaultStatus } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import ItemsTab from "./vault/ItemsTab";
import "./CallerList.css";
import "./Vault.css";

interface TabDef {
  id: string;
  label: string;
}

const TABS: TabDef[] = [{ id: "items", label: "Items" }];

export default function VaultPage() {
  const { daemon } = useDaemon();
  const [params, setParams] = useSearchParams();
  const [callers, setCallers] = useState<AdminCaller[] | null>(null);
  const [status, setStatus] = useState<AdminVaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCallers = useCallback(async () => {
    const [callersRes, statusRes] = await Promise.all([api.callers(), api.vaultStatus()]);
    if (isDaemonDown(callersRes)) {
      setError(callersRes.error);
      return;
    }
    setError(null);
    setCallers(callersRes);
    if (!isDaemonDown(statusRes)) setStatus(statusRes);
  }, []);

  useEffect(() => {
    if (daemon !== "up") return;
    void loadCallers();
  }, [daemon, loadCallers]);

  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "items";
  const requested = params.get("caller");
  const caller =
    callers?.find((c) => c.alias === requested) ??
    (requested === null ? callers?.[0] : undefined);

  const select = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) merged.set(k, v);
    setParams(merged, { replace: false });
  };

  return (
    <>
      <header className="page-header">
        <div>
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
        {callers && callers.length > 0 && (
          <label className="dl-vault-caller-select">
            <span className="dl-vault-caller-label">Caller</span>
            <select
              value={caller?.alias ?? ""}
              onChange={(e) => select({ caller: e.target.value })}
            >
              {caller === undefined && <option value="">Choose a caller</option>}
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

      {daemon === "down" && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code>.
          </span>
        </div>
      )}
      {error && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load callers: {error}</span>
        </div>
      )}
      {status?.error && (
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>{status.error}</span>
        </div>
      )}

      <div className="dl-vault-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`dl-vault-tab${tab === t.id ? " active" : ""}`}
            onClick={() => select({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {callers === null && daemon === "up" && !error && (
        <div className="banner banner-loading">Loading…</div>
      )}
      {callers !== null && caller === undefined && (
        <div className="placeholder">
          <span className="placeholder-title">
            {requested !== null ? `No caller named "${requested}"` : "No callers"}
          </span>
          <span>Choose a caller above.</span>
        </div>
      )}
      {tab === "items" && caller && (
        <ItemsTab key={caller.alias} caller={caller} onChanged={() => void loadCallers()} />
      )}
    </>
  );
}
