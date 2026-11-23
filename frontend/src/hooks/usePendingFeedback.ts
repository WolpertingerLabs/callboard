import { useCallback, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { PendingAction } from "../components/FeedbackPanel";

/** Mutable request ledger; redraws below publish its UI snapshot. */
class Scope {
  active = false;
  revision = 0;
  action: PendingAction | null = null;
  key = "";
  submissions = new Map<string, symbol>();
  /** When the last card went away, for {@link APPROVE_LOCK_MS}. */
  goneAt: number | undefined = undefined;
  /** A human-only card that replaced another is not approvable yet. */
  approveLocked = false;
  lockTimer: ReturnType<typeof setTimeout> | undefined = undefined;
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
/**
 * How long a human-only card that replaced another — or appeared within this
 * long of one going — keeps its approve button locked. Open computer-control
 * requests queue and appear one after another, so the next card can land where
 * the human's cursor already is; a double-click, or a click already on its
 * way, must not approve something they never read.
 */
export const APPROVE_LOCK_MS = 1000;

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
    const previous = scope.action;
    if (next?.requestId !== previous?.requestId) {
      const now = Date.now();
      const followsAnother = previous !== null || (scope.goneAt !== undefined && now - scope.goneAt < APPROVE_LOCK_MS);
      if (!next && previous) scope.goneAt = now;
      if (next?.humanOnly && followsAnother) {
        scope.approveLocked = true;
        clearTimeout(scope.lockTimer);
        scope.lockTimer = setTimeout(() => {
          scope.approveLocked = false;
          if (current.current === scope) redraw((n) => n + 1);
        }, APPROVE_LOCK_MS);
      } else if (next) {
        scope.approveLocked = false;
        clearTimeout(scope.lockTimer);
      }
    }
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
    approveLocked: scope.approveLocked,
    setPendingAction,
    capturePending,
    isCurrentPending,
    isUnchangedPending,
    beginResponse,
    finishResponse,
  };
}
