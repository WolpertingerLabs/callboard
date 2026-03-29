import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

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
  /** Whether the SSE connection to the server is established */
  connected: boolean;
  /** Incremented on chat_metadata_updated / user_summoned SSE events — use as a dependency to trigger refetch */
  metadataVersion: number;
  /** Set of chatIds that currently have an active summon (for immediate visual feedback) */
  summonedChatIds: Set<string>;
}

const SessionContext = createContext<SessionContextValue>({
  activeSessions: new Map(),
  connected: false,
  metadataVersion: 0,
  summonedChatIds: new Set(),
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
 * refetch when chat metadata changes (status, summon, title) via SSE events.
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

const RECONNECT_DELAY_MS = 3_000;

/**
 * Provider that maintains a global SSE connection to /api/sessions/events
 * and keeps an in-memory map of all active chat sessions.
 *
 * Wrap your app with this provider to give all components access to
 * real-time session status without per-chat polling.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Map<string, ActiveSessionInfo>>(new Map());
  const [connected, setConnected] = useState(false);
  const [metadataVersion, setMetadataVersion] = useState(0);
  const [summonedChatIds, setSummonedChatIds] = useState<Set<string>>(new Set());
  // Incrementing this counter triggers a reconnection attempt
  const [reconnectCount, setReconnectCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const es = new EventSource("/api/sessions/events", { withCredentials: true });

    // Handle initial snapshot
    es.addEventListener("snapshot", (e: MessageEvent) => {
      if (!mounted) return;
      try {
        const data = JSON.parse(e.data) as Record<string, { type: SessionType; startedAt: number }>;
        const map = new Map<string, ActiveSessionInfo>();
        for (const [chatId, info] of Object.entries(data)) {
          map.set(chatId, { type: info.type, startedAt: info.startedAt });
        }
        setSessions(map);
        setConnected(true);
      } catch {
        // Ignore parse errors
      }
    });

    // Handle session started
    es.addEventListener("session_started", (e: MessageEvent) => {
      if (!mounted) return;
      try {
        const { chatId, type } = JSON.parse(e.data) as { chatId: string; type: SessionType };
        setSessions((prev) => {
          const next = new Map(prev);
          next.set(chatId, { type });
          return next;
        });
      } catch {
        // Ignore parse errors
      }
    });

    // Handle session stopped
    es.addEventListener("session_stopped", (e: MessageEvent) => {
      if (!mounted) return;
      try {
        const { chatId } = JSON.parse(e.data) as { chatId: string };
        setSessions((prev) => {
          if (!prev.has(chatId)) return prev;
          const next = new Map(prev);
          next.delete(chatId);
          return next;
        });
      } catch {
        // Ignore parse errors
      }
    });

    // Heartbeat — confirms the connection is alive (no action needed)
    es.addEventListener("heartbeat", () => {});

    // Chat metadata updated — bump version to trigger refetches
    es.addEventListener("chat_metadata_updated", (e: MessageEvent) => {
      if (!mounted) return;
      try {
        const { chatId, data } = JSON.parse(e.data) as { chatId: string; data?: { summon?: unknown } };
        setMetadataVersion((v) => v + 1);
        // If summon was cleared, remove from summoned set
        if (data && data.summon === null) {
          setSummonedChatIds((prev) => {
            if (!prev.has(chatId)) return prev;
            const next = new Set(prev);
            next.delete(chatId);
            return next;
          });
        }
      } catch {
        // Ignore parse errors
      }
    });

    // User summoned — add to summoned set + bump version + browser notification
    es.addEventListener("user_summoned", (e: MessageEvent) => {
      if (!mounted) return;
      try {
        const { chatId, data } = JSON.parse(e.data) as { chatId: string; data?: SummonInfo };
        setMetadataVersion((v) => v + 1);
        setSummonedChatIds((prev) => {
          const next = new Set(prev);
          next.add(chatId);
          return next;
        });
        // Browser notification for urgent summons
        if (data?.urgency === "urgent" && typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("Agent needs your attention", {
            body: data.message,
            tag: `summon-${chatId}`,
          });
        }
      } catch {
        // Ignore parse errors
      }
    });

    // Handle errors (connection lost, etc.)
    es.onerror = () => {
      if (!mounted) return;
      setConnected(false);
      es.close();

      // Schedule reconnection by incrementing the counter, which re-runs this effect
      reconnectTimer = setTimeout(() => {
        if (mounted) {
          setReconnectCount((c) => c + 1);
        }
      }, RECONNECT_DELAY_MS);
    };

    return () => {
      mounted = false;
      es.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [reconnectCount]);

  return <SessionContext.Provider value={{ activeSessions: sessions, connected, metadataVersion, summonedChatIds }}>{children}</SessionContext.Provider>;
}
