import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
import { observeServerBuild, INITIAL_BUILD_WATCH, MY_BUILD_ID, type BuildWatchState } from "../utils/buildIdentity";

export type SessionType = "web" | "cli";

export interface ActiveSessionInfo {
  type: SessionType;
  startedAt?: number;
}

export interface SummonInfo {
  message: string;
  urgency: "normal" | "urgent";
  createdAt: string;
}

interface SessionContextValue {
  /** Map of chatId → session info for all currently active sessions */
  activeSessions: Map<string, ActiveSessionInfo>;
  /** Whether the connection to the server is healthy */
  connected: boolean;
  /** Incremented on chat_metadata_updated / user_summoned events — use as a dependency to trigger refetch */
  metadataVersion: number;
  /** Set of chatIds that currently have an active summon (for immediate visual feedback) */
  summonedChatIds: Set<string>;
  /**
   * The daemon's build id, once it has changed underneath this page load —
   * meaning this tab's JavaScript predates the daemon it is talking to. `null`
   * while the two are in step. See `utils/buildIdentity.ts` for the rules.
   */
  staleBuildId: string | null;
}

/** Exported for tests, which supply a value directly rather than standing up the poll. */
export const SessionContext = createContext<SessionContextValue>({
  activeSessions: new Map(),
  connected: false,
  metadataVersion: 0,
  summonedChatIds: new Set(),
  staleBuildId: null,
});

/**
 * Hook to access the full session context.
 */
export function useSessionContext(): SessionContextValue {
  return useContext(SessionContext);
}

/**
 * Convenience hook to check if a specific chat is currently active.
 * Returns the session info if active, or null if not.
 */
export function useIsSessionActive(chatId: string | undefined): ActiveSessionInfo | null {
  const { activeSessions } = useSessionContext();
  if (!chatId) return null;
  return activeSessions.get(chatId) ?? null;
}

/**
 * Hook to get the metadata version counter. Use as a dependency to trigger
 * refetch when chat metadata changes (status, summon, title) via polling.
 */
export function useMetadataVersion(): number {
  return useSessionContext().metadataVersion;
}

/**
 * Hook to get the set of chat IDs that currently have an active summon.
 */
export function useSummonedChatIds(): Set<string> {
  return useSessionContext().summonedChatIds;
}

/**
 * Hook for the daemon build id this tab has fallen behind, or null.
 */
export function useStaleBuildId(): string | null {
  return useSessionContext().staleBuildId;
}

const POLL_INTERVAL_MS = 1_000;
const FAILURE_THRESHOLD = 3;

/**
 * Provider that polls /api/sessions/poll every second and keeps an
 * in-memory map of all active chat sessions.
 *
 * The server returns version counters with each response. When versions
 * haven't changed, the response is tiny and no state updates occur
 * (zero re-renders). Full session/summon payloads are only included
 * when the corresponding version counter has changed.
 *
 * The daemon's build id rides the same request on the same terms — echoed back
 * in `b`, returned in `build` only when it differs — which is what lets this
 * provider notice that the server was upgraded under a tab that never
 * reloaded. It reports that as `staleBuildId` and does nothing else about it;
 * offering the reload is `StaleBundleBanner`'s job, and taking it is the
 * user's.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Map<string, ActiveSessionInfo>>(new Map());
  const [connected, setConnected] = useState(false);
  const [metadataVersion, setMetadataVersion] = useState(0);
  const [summonedChatIds, setSummonedChatIds] = useState<Set<string>>(new Set());
  const [staleBuildId, setStaleBuildId] = useState<string | null>(null);

  // Track server versions and connection state in refs to avoid triggering re-renders on every poll
  const lastVersionRef = useRef<number | undefined>(undefined);
  const lastMetaVersionRef = useRef<number | undefined>(undefined);
  const buildWatchRef = useRef<BuildWatchState>(INITIAL_BUILD_WATCH);
  const consecutiveFailuresRef = useRef(0);
  const connectedRef = useRef(false);
  const pollRef = useRef<() => Promise<void>>();

  useEffect(() => {
    let mounted = true;

    const poll = async () => {
      try {
        const params = new URLSearchParams();
        if (lastVersionRef.current !== undefined) params.set("v", String(lastVersionRef.current));
        if (lastMetaVersionRef.current !== undefined) params.set("mv", String(lastMetaVersionRef.current));
        // Echo the daemon build id we already hold, so it stays silent while we
        // agree and the steady-state response keeps its ~40 bytes.
        if (buildWatchRef.current.baseline !== undefined) params.set("b", buildWatchRef.current.baseline);

        const res = await fetch(`/api/sessions/poll?${params}`, { credentials: "include" });
        if (!mounted) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (!mounted) return;

        consecutiveFailuresRef.current = 0;
        if (!connectedRef.current) {
          connectedRef.current = true;
          setConnected(true);
        }

        // Build id — has the daemon moved out from under this bundle?
        // `MY_BUILD_ID` is passed rather than defaulted so a test can substitute
        // a real build id for the dev sentinel vitest would otherwise supply.
        const nextWatch = observeServerBuild(buildWatchRef.current, typeof data.build === "string" ? data.build : undefined, MY_BUILD_ID);
        if (nextWatch !== buildWatchRef.current) {
          buildWatchRef.current = nextWatch;
          setStaleBuildId((prev) => (prev === (nextWatch.staleBuildId ?? null) ? prev : (nextWatch.staleBuildId ?? null)));
        }

        // Sessions changed — rebuild the map
        if (data.sessions !== undefined && data.version !== lastVersionRef.current) {
          const map = new Map<string, ActiveSessionInfo>();
          for (const [chatId, info] of Object.entries(data.sessions)) {
            map.set(chatId, info as ActiveSessionInfo);
          }
          setSessions(map);
        }
        lastVersionRef.current = data.version;

        // Metadata changed — bump local counter and diff summons
        if (data.metadataVersion !== lastMetaVersionRef.current) {
          lastMetaVersionRef.current = data.metadataVersion;
          setMetadataVersion((v) => v + 1);

          if (data.activeSummons) {
            const serverSummons = data.activeSummons as Record<string, SummonInfo>;
            const newSet = new Set(Object.keys(serverSummons));

            setSummonedChatIds((prev) => {
              // Fire browser notifications for newly-appeared summons
              for (const chatId of newSet) {
                if (!prev.has(chatId)) {
                  const summon = serverSummons[chatId];
                  if (summon?.urgency === "urgent" && typeof Notification !== "undefined" && Notification.permission === "granted") {
                    new Notification("Agent needs your attention", {
                      body: summon.message,
                      tag: `summon-${chatId}`,
                    });
                  }
                }
              }
              return newSet;
            });
          }
        }
      } catch {
        if (!mounted) return;
        consecutiveFailuresRef.current++;
        if (consecutiveFailuresRef.current >= FAILURE_THRESHOLD && connectedRef.current) {
          connectedRef.current = false;
          setConnected(false);
        }
      }
    };

    pollRef.current = poll;

    // Immediate first poll, then every POLL_INTERVAL_MS
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);

    // On tab resume (or network restore while visible), force an immediate
    // full poll so downstream consumers get accurate session state without
    // waiting up to POLL_INTERVAL_MS. Resetting version refs ensures the
    // server returns full payloads instead of "nothing changed" responses —
    // the browser may have missed version bumps while the tab was suspended.
    //
    // `buildWatchRef` is pointedly *not* reset here. A hidden tab is precisely
    // when a daemon gets restarted — close the laptop, `npm i -g`, open it
    // again — and dropping the baseline would make the daemon's new id look
    // like a first observation and get seeded in silence. The one signal worth
    // keeping across a suspend is the one this would throw away.
    const handleResume = () => {
      if (document.visibilityState === "visible") {
        lastVersionRef.current = undefined;
        lastMetaVersionRef.current = undefined;
        pollRef.current?.();
      }
    };

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("online", handleResume);

    return () => {
      mounted = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleResume);
      window.removeEventListener("online", handleResume);
    };
  }, []);

  return (
    <SessionContext.Provider value={{ activeSessions: sessions, connected, metadataVersion, summonedChatIds, staleBuildId }}>
      {children}
    </SessionContext.Provider>
  );
}
