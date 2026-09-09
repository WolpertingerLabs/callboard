import { useCallback, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { PendingAction } from "../components/FeedbackPanel";

/** Mutable request ledger; redraws below publish its UI snapshot. */
class Scope {
  active = false;
  revision = 0;
  action: PendingAction | null = null;
  key = "";
  submissions = new Map<string, symbol>();
  constructor(readonly route: string) {}
  activate(value: boolean) {
    this.active = value;
  }
}

interface Snapshot {
  scope: Scope;
  revision: number;
  key: string;
}
/** Prompt UI state belongs to a route lifetime AND a prompt, never the Chat component. */
export function usePendingFeedback(route: string) {
  const sequence = useRef(0);
  const scope = useMemo(() => new Scope(route), [route]);
  const current = useRef(scope);
  useLayoutEffect(() => {
    current.current = scope;
    scope.activate(true);
    return () => {
      scope.activate(false);
    };
  }, [scope]);
  const [, redraw] = useState(0);
  const setPendingAction = useCallback((update: SetStateAction<PendingAction | null>, newPrompt = false) => {
    const scope = current.current;
    const next = typeof update === "function" ? update(scope.action) : update;
    if (next === scope.action && !newPrompt) return;
    scope.key = next?.requestId ? `server:${next.requestId}` : `local:${++sequence.current}`;
    scope.action = next;
    scope.revision++;
    redraw((n) => n + 1);
  }, []);
  const capturePending = useCallback((): Snapshot => ({ scope: current.current, revision: current.current.revision, key: current.current.key }), []);
  const isCurrentPending = useCallback(
    (snapshot: Snapshot) => snapshot.scope.active && current.current === snapshot.scope && current.current.key === snapshot.key,
    [],
  );
  const isUnchangedPending = useCallback(
    (snapshot: Snapshot) => snapshot.scope.active && current.current === snapshot.scope && current.current.revision === snapshot.revision,
    [],
  );
  const beginResponse = useCallback(() => {
    const scope = current.current;
    if (!scope.action || scope.submissions.has(scope.key)) return null;
    const token = Symbol();
    scope.submissions.set(scope.key, token);
    redraw((n) => n + 1);
    return { ...capturePending(), token };
  }, [capturePending]);
  const finishResponse = useCallback((ticket: Snapshot & { token: symbol }) => {
    if (ticket.scope.submissions.get(ticket.key) === ticket.token) ticket.scope.submissions.delete(ticket.key);
    if (current.current === ticket.scope) redraw((n) => n + 1);
  }, []);
  return {
    pendingAction: scope.action,
    pendingKey: `${route}:${scope.key}`,
    responding: scope.submissions.has(scope.key),
    setPendingAction,
    capturePending,
    isCurrentPending,
    isUnchangedPending,
    beginResponse,
    finishResponse,
  };
}
