/**
 * DaemonOffline: the banner every page shows while the daemon can't be
 * reached (`useDaemon().daemon === "down"`).
 *
 *   <DaemonOffline action="load callers" />
 *   → "Drawlatch daemon is not reachable. Start it with `drawlatch start` to
 *      load callers."  [Retry now]
 *
 * The daemon is polled every 5s anyway; "Retry now" checks at once. Pages
 * refetch on their own when it comes back (their effects depend on
 * `daemon`).
 */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useDaemon } from "../contexts/DaemonContext";

interface DaemonOfflineProps {
  /** Finishes the sentence "Start it with drawlatch start to …". */
  action?: string;
}

export default function DaemonOffline({ action }: DaemonOfflineProps) {
  const { recheck } = useDaemon();
  const [checking, setChecking] = useState(false);

  async function retry(): Promise<void> {
    if (checking) return;
    setChecking(true);
    try {
      await recheck();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="banner banner-offline" role="status">
      <span className="status-dot down" aria-hidden="true" />
      <span className="banner-offline-text">
        Drawlatch daemon is not reachable. Start it with <code>drawlatch start</code>
        {action ? ` to ${action}.` : "."}
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-sm banner-action"
        onClick={() => void retry()}
        disabled={checking}
      >
        <RefreshCw size={13} className={checking ? "spinner" : undefined} aria-hidden="true" />
        {checking ? "Checking…" : "Retry now"}
      </button>
    </div>
  );
}
