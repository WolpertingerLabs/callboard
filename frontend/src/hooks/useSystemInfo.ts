import { useEffect, useRef, useState } from "react";
import { getSystemInfo, type SystemInfo } from "../api";

export interface UseSystemInfoOptions {
  /**
   * Bypass the tab's cached payload. Pass it wherever the answer *gates*
   * something rather than merely being displayed — see `getSystemInfo` for why
   * the cached default is not "fresh, a moment late". Each caller states its
   * own reason; this hook takes no position.
   */
  refresh?: boolean;
  /**
   * Runs with the payload in the same tick it is stored, so state a caller
   * derives from it (a provider downgrade, say) lands in the same render as
   * the payload itself. Read through a ref: the latest one is called, and
   * changing it does not refetch.
   */
  onLoad?: (info: SystemInfo) => void;
}

/**
 * `/api/system-info`, fetched exactly once per mount.
 *
 * `info` is `null` until the request settles, and stays `null` if it fails —
 * `failed` is what tells those apart, for the callers that treat an
 * unreachable daemon as "unavailable" rather than "still loading".
 */
export function useSystemInfo({ refresh = false, onLoad }: UseSystemInfoOptions = {}): { info: SystemInfo | null; failed: boolean } {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const onLoadRef = useRef(onLoad);
  useEffect(() => {
    onLoadRef.current = onLoad;
  });
  // Mount-only on purpose: `refresh` is a per-call-site constant, and a second
  // fetch would be a second metered request for an answer this mount has.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    let cancelled = false;
    (refreshRef.current ? getSystemInfo({ refresh: true }) : getSystemInfo())
      .then((fresh) => {
        if (cancelled) return;
        onLoadRef.current?.(fresh);
        setInfo(fresh);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { info, failed };
}
