import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AdminMeta } from "drawlatch-admin-types";
import { api, DAEMON_UNREACHABLE, isDaemonDown, isUnreachable } from "../api";

type DaemonStatus = "up" | "down" | "unknown";

interface DaemonContextValue {
  daemon: DaemonStatus;
  /** Null until the first successful poll, and while the daemon is down. */
  meta: AdminMeta | null;
  /** Increments on every completed poll — use as a refetch dependency. */
  tick: number;
  /** Poll now (the offline banner's "Retry now"). Resolves when done. */
  recheck: () => Promise<void>;
}

const DaemonContext = createContext<DaemonContextValue>({
  daemon: "unknown",
  meta: null,
  tick: 0,
  recheck: () => Promise.resolve(),
});

const POLL_INTERVAL_MS = 5_000;

export function useDaemon(): DaemonContextValue {
  return useContext(DaemonContext);
}

export function DaemonProvider({ children }: { children: ReactNode }) {
  const [daemon, setDaemon] = useState<DaemonStatus>("unknown");
  const [meta, setMeta] = useState<AdminMeta | null>(null);
  const [tick, setTick] = useState(0);
  const mountedRef = useRef(true);
  // One poll at a time: a slow or hanging request must not pile up more.
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastPollAtRef = useRef(0);

  const markDown = useCallback(() => {
    setDaemon("down");
    // Stale pid/uptime next to "offline" is wrong information; drop it.
    setMeta(null);
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      // Health is the heartbeat; meta carries version/pid for the sidebar
      // and Overview, and may change across a restart, so refresh it too.
      const health = await api.health();
      if (!mountedRef.current) return;
      if (isDaemonDown(health)) {
        // 401: the auth handler is already switching to Login.
        if (health.kind === "auth") return;
        if (isUnreachable(health)) {
          markDown();
          return;
        }
        // Any other error means the daemon answered: fall through to meta.
      }

      const metaRes = await api.meta();
      if (!mountedRef.current) return;
      if (isDaemonDown(metaRes)) {
        if (metaRes.kind === "auth") return;
        if (isUnreachable(metaRes)) {
          markDown();
          return;
        }
        // Reachable but meta failed: up, keeping the last meta we had.
        setDaemon("up");
        return;
      }
      setDaemon("up");
      setMeta(metaRes);
    } catch {
      // getJson doesn't throw, but nothing here may leave the status stuck.
      if (mountedRef.current) markDown();
    } finally {
      if (mountedRef.current) setTick((t) => t + 1);
    }
  }, [markDown]);

  const poll = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    lastPollAtRef.current = Date.now();
    const p = pollOnce().finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = p;
    return p;
  }, [pollOnce]);

  useEffect(() => {
    mountedRef.current = true;
    void poll();

    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (interval !== null) return;
      interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };

    if (document.visibilityState === "visible") start();

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Resume immediately so the UI reflects current state without waiting
        // a full poll interval.
        void poll();
        start();
      } else {
        stop();
      }
    };

    // Any request that got no response: check now rather than in 5s (but
    // not once per failed request while every page poll is failing).
    const onUnreachable = () => {
      if (Date.now() - lastPollAtRef.current < 1_500) return;
      void poll();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(DAEMON_UNREACHABLE, onUnreachable);

    return () => {
      mountedRef.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(DAEMON_UNREACHABLE, onUnreachable);
    };
  }, [poll]);

  const value = useMemo(
    () => ({ daemon, meta, tick, recheck: poll }),
    [daemon, meta, tick, poll],
  );

  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}
