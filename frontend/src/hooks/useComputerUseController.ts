import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComputerUseSession, ComputerUseStatus } from "shared/types/computerUse.js";
import { computerUseClient as client } from "../api/computerUse";

export const isTerminal = (session: ComputerUseSession) => ["stopped", "revoked", "closed", "failed", "expired"].includes(session.state);
export const isPending = (session: ComputerUseSession) => ["pending", "awaiting_approval", "approval_required", "pending_approval"].includes(session.state);

// Bound the UI wait, not the accepted server operation. In particular, a timed-out
// stop may still complete: do not abort it on timeout, navigation or viewer cleanup.
export const COMPUTER_CONTROL_WAIT_MS = 5000;
async function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Request timed out; server completion is unverified.")), COMPUTER_CONTROL_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  const readSequence = useRef(0);
  const mutationSequence = useRef(0);
  const stopSequence = useRef(0);
  const known = useRef<ComputerUseStatus | null>(null);
  // Stop-only knowledge is deliberately independent of display authority. A
  // successful open can arrive after a newer (empty) poll or a connection error.
  // Absence from a snapshot never proves that an accepted session was stopped.
  const emergency = useRef(new Map<string, ComputerUseSession>());
  const terminalIds = useRef(new Set<string>());
  const rememberEmergency = useCallback((response: unknown) => {
    if (!response || typeof response !== "object") return;
    const value = response as Partial<ComputerUseSession>;
    if (typeof value.id !== "string" || typeof value.state !== "string") return;
    if (isTerminal(value as ComputerUseSession)) {
      terminalIds.current.add(value.id);
      emergency.current.delete(value.id);
      return;
    }
    if (terminalIds.current.has(value.id)) return; // Session IDs cannot be revived.
    const previous = emergency.current.get(value.id);
    if (!["browser", "native"].includes(value.kind ?? "") || !Number.isSafeInteger(value.generation) || value.generation! < 0) return;
    if (!previous || value.generation! >= previous.generation)
      emergency.current.set(value.id, { ...value, controller: value.controller ?? null } as ComputerUseSession);
  }, []);
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
      if (value.id && terminalIds.current.has(value.id) && !isTerminal(value as ComputerUseSession)) return;
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
  // Every shared status read (poll, viewer retry/post-action, discovery and
  // verification) uses the same ordering. Newer reads win, and any intervening
  // authority update invalidates older reads, including their error responses.
  const readStatus = useCallback(
    async (signal?: AbortSignal, inScope: () => boolean = () => true) => {
      if (!chatId || signal?.aborted) return undefined;
      const epoch = lifetime.current;
      const scoped = () => mounted.current && current.current === chatId && lifetime.current === epoch && inScope() && !signal?.aborted;
      const ticket = scoped() ? ++readSequence.current : -1;
      const authority = revision.current;
      const valid = () => scoped() && ticket === readSequence.current && authority === revision.current;
      try {
        const next = await bounded(client.status(chatId, signal));
        if (scoped()) for (const session of next.sessions) rememberEmergency(session);
        if (valid()) publish(next);
        // Discovery can still stop old-chat sessions after navigation, but must
        // never publish that old authority or invalidate the new route's reads.
        return next;
      } catch (error) {
        if (valid()) {
          fail("Status unavailable — last known state only. Retry status or stop computer control.");
          throw error;
        }
        return undefined;
      }
    },
    [chatId, publish, fail, rememberEmergency],
  );

  // Fence mutation responses as well as reads. A newer published status/error,
  // another mutation or emergency stop supersedes this response. The viewer
  // still performs a fresh, ordered post-mutation status read.
  const beginMutation = useCallback(() => {
    const epoch = lifetime.current;
    const mutation = ++mutationSequence.current;
    const authority = ++revision.current;
    return (response: unknown, present = true) => {
      const scoped = mounted.current && current.current === chatId && lifetime.current === epoch;
      if (scoped) rememberEmergency(response);
      if (
        present &&
        mounted.current &&
        current.current === chatId &&
        lifetime.current === epoch &&
        mutation === mutationSequence.current &&
        authority === revision.current
      )
        acceptResponse(response);
    };
  }, [chatId, acceptResponse, rememberEmergency]);

  useEffect(() => {
    ++lifetime.current;
    mounted.current = true;
    known.current = null;
    emergency.current.clear();
    terminalIds.current.clear();
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
      try {
        await readStatus(abort.signal, () => alive);
      } catch {
        // readStatus owns the shared error fence and unavailable state.
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
  }, [chatId, readStatus]);

  const stopAll = useCallback(async () => {
    if (!chatId || current.current !== chatId || stopActive.current) return;
    stopActive.current = true;
    const attempt = ++stopSequence.current;
    ++mutationSequence.current;
    ++revision.current;
    setStopping(true);
    setStopError("");
    // Unmount the viewer immediately: stop never waits for accepted captures.
    setViewerEpoch((value) => value + 1);
    const epoch = lifetime.current;
    const valid = () => mounted.current && current.current === chatId && lifetime.current === epoch && stopSequence.current === attempt;
    const errors: string[] = [];
    const report = (message: string) => {
      errors.push(message);
      // Show each failure immediately, even while discovery/verification waits.
      if (valid()) setStopError(`${errors.join(" ")} Retry Stop computer control when this attempt finishes.`);
    };
    const sessions = new Map(emergency.current);
    const attempted = new Set<string>();
    const stopSession = async (session: ComputerUseSession) => {
      if (attempted.has(session.id)) return;
      attempted.add(session.id);
      try {
        const result = await bounded(client.control(chatId, session.id, "stop", session.generation));
        if (valid()) {
          rememberEmergency(result);
          acceptResponse(result);
        }
      } catch (error) {
        report(`${session.kind} ${session.id}: ${error instanceof Error ? error.message : "stop failed"}`);
      }
    };
    // Dispatch known emergency stops immediately, even if discovery is slow.
    const knownStops = Promise.all([...sessions.values()].map(stopSession));
    try {
      try {
        const next = await readStatus(undefined, valid);
        if (!next) report("Could not discover all sessions; attempting every last-known session.");
        for (const item of next?.sessions ?? []) {
          if (!isTerminal(item) && (!valid() || !terminalIds.current.has(item.id))) sessions.set(item.id, item);
        }
      } catch {
        report("Could not discover all sessions; attempting every last-known session.");
      }
      // All known browser/native sessions, including pending approvals. Each wait
      // is bounded, but accepted stop requests are not aborted. Late settlements
      // of timed-out requests have no publication callbacks and cannot undo retry.
      if (valid()) for (const [id, session] of emergency.current) sessions.set(id, session);
      await Promise.all([knownStops, ...[...sessions.values()].map(stopSession)]);
      try {
        const next = await readStatus(undefined, valid);
        if (!next) report("Could not verify stopped state.");
        else if (next.sessions.some((item) => !isTerminal(item)) || (valid() && emergency.current.size > 0))
          report("Some sessions are still active or pending.");
      } catch {
        report("Could not verify stopped state.");
      }
    } finally {
      if (valid()) {
        stopActive.current = false;
        setStopping(false);
        setStopError(errors.length ? `${errors.join(" ")} Retry Stop computer control.` : "");
      }
    }
  }, [chatId, readStatus, acceptResponse, rememberEmergency]);
  const visible = snapshot.chatId === chatId ? snapshot : { status: null, error: "" };
  return { status: visible.status, statusError: visible.error, readStatus, beginMutation, stopAll, stopping, stopError, viewerEpoch };
}
export type ComputerUseController = ReturnType<typeof useComputerUseController>;
