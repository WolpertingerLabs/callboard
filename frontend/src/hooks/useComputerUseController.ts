import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComputerUseSession, ComputerUseStatus } from "shared/types/computerUse.js";
import { computerUseClient as client } from "../api/computerUse";

export const isTerminal = (session: ComputerUseSession) => ["stopped", "revoked", "closed", "failed", "expired"].includes(session.state);
export const isPending = (session: ComputerUseSession) => ["pending", "awaiting_approval", "approval_required", "pending_approval"].includes(session.state);

/** Chat-scoped status only. No target creation, permission changes or observation.
 * Each closure retains its original chat ID; stale results cannot publish to a new route.
 */
export function useComputerUseController(chatId: string | undefined) {
  const [snapshot, setSnapshot] = useState<{ chatId?: string; status: ComputerUseStatus | null; error: string }>({ status: null, error: "" });
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const [viewerEpoch, setViewerEpoch] = useState(0);
  const current = useRef(chatId);
  useLayoutEffect(() => {
    current.current = chatId;
    return () => {
      current.current = undefined;
    };
  }, [chatId]);
  const revision = useRef(0);
  const known = useRef<ComputerUseStatus | null>(null);
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const stopActive = useRef(false);
  const publish = useCallback(
    (status: ComputerUseStatus) => {
      if (!mounted.current || current.current !== chatId) return;
      ++revision.current;
      known.current = status;
      setSnapshot({ chatId, status, error: "" });
    },
    [chatId],
  );
  const fail = useCallback(
    (message: string) => {
      if (!mounted.current || current.current !== chatId) return;
      ++revision.current;
      setSnapshot({ chatId, status: known.current ? { ...known.current, capabilities: [] } : null, error: message });
    },
    [chatId],
  );
  const acceptResponse = useCallback(
    (response: unknown) => {
      if (!mounted.current || current.current !== chatId || !known.current || !response || typeof response !== "object") return;
      const value = response as Partial<ComputerUseSession>;
      if (typeof value.id !== "string" || typeof value.state !== "string") return;
      const status = {
        ...known.current,
        sessions: known.current.sessions.map((session) =>
          session.id === value.id
            ? {
                ...session,
                state: value.state!,
                ...(Number.isSafeInteger(value.generation) ? { generation: value.generation! } : {}),
                ...(["agent", "human", null].includes(value.controller ?? null) && value.controller !== undefined ? { controller: value.controller } : {}),
              }
            : session,
        ),
      };
      if (
        !status.sessions.some((session) => session.id === value.id) &&
        ["browser", "native"].includes(value.kind ?? "") &&
        Number.isSafeInteger(value.generation) &&
        value.controller !== undefined &&
        ["agent", "human", null].includes(value.controller)
      ) {
        status.sessions.push(value as ComputerUseSession);
      }
      ++revision.current;
      known.current = status;
      setSnapshot((previous) => ({ ...previous, status: previous.error ? { ...status, capabilities: [] } : status }));
    },
    [chatId],
  );
  useEffect(() => {
    ++lifetime.current;
    mounted.current = true;
    known.current = null;
    stopActive.current = false;
    setStopping(false);
    setStopError("");
    setSnapshot({ chatId, status: null, error: "" });
    if (!chatId) return;
    let alive = true;
    let inFlight = false;
    const abort = new AbortController();
    const refresh = async () => {
      if (inFlight || stopActive.current) return;
      inFlight = true;
      const ticket = revision.current;
      try {
        const next = await client.status(chatId, abort.signal);
        if (alive && ticket === revision.current) publish(next);
      } catch {
        if (alive && ticket === revision.current) fail("Status unavailable — last known state only. Retry status or stop computer control.");
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    return () => {
      alive = false;
      mounted.current = false;
      ++revision.current;
      abort.abort();
      window.clearInterval(timer);
    };
  }, [chatId, publish, fail]);

  const stopAll = useCallback(async () => {
    if (!chatId || current.current !== chatId || stopActive.current) return;
    stopActive.current = true;
    ++revision.current;
    setStopping(true);
    setStopError("");
    // Unmount the viewer immediately: stop never waits for accepted captures.
    setViewerEpoch((value) => value + 1);
    const epoch = lifetime.current;
    const valid = () => mounted.current && current.current === chatId && lifetime.current === epoch;
    const errors: string[] = [];
    const sessions = new Map((known.current?.sessions ?? []).filter((item) => !isTerminal(item)).map((item) => [item.id, item]));
    const attempted = new Set<string>();
    const stopSession = async (session: ComputerUseSession) => {
      if (attempted.has(session.id)) return;
      attempted.add(session.id);
      try {
        const result = await client.control(chatId, session.id, "stop", session.generation);
        if (valid()) acceptResponse(result);
      } catch (error) {
        errors.push(`${session.kind} ${session.id}: ${error instanceof Error ? error.message : "stop failed"}`);
      }
    };
    // Dispatch known emergency stops immediately, even if discovery is slow.
    const knownStops = Promise.all([...sessions.values()].map(stopSession));
    try {
      try {
        const ticket = revision.current;
        const next = await client.status(chatId);
        for (const item of next.sessions) {
          if (!isTerminal(item)) sessions.set(item.id, item);
          else sessions.delete(item.id);
        }
        if (valid() && ticket === revision.current) publish(next);
      } catch {
        errors.push("Could not discover all sessions; attempting every last-known session.");
      }
      // All known browser/native sessions, including pending approvals. Do not abort
      // accepted emergency requests on navigation, and never substitute revoke/resume.
      await Promise.all([knownStops, ...[...sessions.values()].map(stopSession)]);
      try {
        const next = await client.status(chatId);
        if (valid()) publish(next);
        if (next.sessions.some((item) => !isTerminal(item))) errors.push("Some sessions are still active or pending.");
      } catch {
        errors.push("Could not verify stopped state.");
        if (valid()) fail("Status unavailable — stop could not be verified.");
      }
    } finally {
      if (valid()) {
        stopActive.current = false;
        setStopping(false);
        setStopError(errors.length ? `${errors.join(" ")} Retry Stop computer control.` : "");
      }
    }
  }, [chatId, publish, fail, acceptResponse]);
  const visible = snapshot.chatId === chatId ? snapshot : { status: null, error: "" };
  return { status: visible.status, statusError: visible.error, publish, fail, acceptResponse, stopAll, stopping, stopError, viewerEpoch };
}
export type ComputerUseController = ReturnType<typeof useComputerUseController>;
