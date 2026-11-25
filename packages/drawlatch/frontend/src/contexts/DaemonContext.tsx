import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AdminMeta } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";

type DaemonStatus = "up" | "down" | "unknown";

interface DaemonContextValue {
  daemon: DaemonStatus;
  meta: AdminMeta | null;
  /** Increments on every successful poll — use as a refetch dependency. */
  tick: number;
}

const DaemonContext = createContext<DaemonContextValue>({
  daemon: "unknown",
  meta: null,
  tick: 0,
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
  const pollRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    mountedRef.current = true;

    const poll = async () => {
      // Health is the heartbeat. When it succeeds, also refresh meta if we
      // don't have it yet (or if the daemon was previously down — pid/version
      // could have changed across a restart).
      const health = await api.health();
      if (!mountedRef.current) return;

      if (isDaemonDown(health)) {
        setDaemon("down");
        setMeta(null);
        setTick((t) => t + 1);
        return;
      }

      const metaRes = await api.meta();
      if (!mountedRef.current) return;
      if (isDaemonDown(metaRes)) {
        setDaemon("down");
        setMeta(null);
      } else {
        setDaemon("up");
        setMeta(metaRes);
      }
      setTick((t) => t + 1);
    };

    pollRef.current = poll;
    poll();

    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (interval !== null) return;
      interval = setInterval(() => {
        pollRef.current();
      }, POLL_INTERVAL_MS);
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
        pollRef.current();
        start();
      } else {
        stop();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mountedRef.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <DaemonContext.Provider value={{ daemon, meta, tick }}>
      {children}
    </DaemonContext.Provider>
  );
}
