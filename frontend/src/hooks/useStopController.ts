import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { getChat, getMessages, stopChat, type Chat, type ParsedMessage } from "../api";
import type { PendingAction } from "../components/FeedbackPanel";
import { endsWithInterruptMarker } from "../utils/inFlightMessages";

// Transcript marker for a run the user stopped. Shown both when the run's own
// terminal event reports the abort and when we settle the stop locally.
export const INTERRUPTED_MESSAGE = "Session was interrupted.";

// How long to wait for the stopped run's terminal event before settling the UI
// anyway. Generous: the server has already aborted the run and killed the
// provider process, and a run parked in a slow tool call can take a moment to
// unwind — this is a backstop against waiting forever, not a normal path.
const STOP_CONFIRM_TIMEOUT_MS = 10_000;

// Delay before the post-stop transcript resync. The harness flushes the killed
// turn's partial output and interrupt marker as it unwinds (~1s in practice),
// which lands after the terminal event the settle path refetches on.
const STOP_RESYNC_DELAY_MS = 2_500;

export interface StopControllerOptions {
  id: string | undefined;
  streaming: boolean;
  /**
   * Whether anything is there to stop, before `stopping` is considered: the
   * page is streaming, or the server reports a web session it controls.
   */
  stoppable: boolean;
  /** The page's live SSE connection. Read and cleared at call time, never captured. */
  abortRef: MutableRefObject<AbortController | null>;
  /** A brand-new chat's temp tracking id, until `chat_created` gives it a real one. */
  tempChatIdRef: MutableRefObject<string | null>;
  /** The chat on screen, for dropping refetches that land after a switch. */
  currentIdRef: MutableRefObject<string | undefined>;
  /** Set on a stop so auto-connect doesn't reattach to the run being cancelled. */
  suppressReconnectAfterStopRef: MutableRefObject<boolean>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  setPendingAction: (action: PendingAction | null) => void;
  setNetworkError: Dispatch<SetStateAction<string | null>>;
  setChat: Dispatch<SetStateAction<Chat | null>>;
  setMessages: Dispatch<SetStateAction<ParsedMessage[]>>;
  clearInFlightMessages: () => void;
  refreshActivity: (chatId: string) => void;
}

/**
 * The Stop button: the request, the wait for the run to actually unwind, and
 * the transcript resync afterwards. Owns no stream state — the SSE controller
 * and the reconnect suppression stay the page's, and are only read and set
 * through the refs passed in, at the same moments the page itself would.
 */
export function useStopController({
  id,
  streaming,
  stoppable,
  abortRef,
  tempChatIdRef,
  currentIdRef,
  suppressReconnectAfterStopRef,
  setStreaming,
  setPendingAction,
  setNetworkError,
  setChat,
  setMessages,
  clearInFlightMessages,
  refreshActivity,
}: StopControllerOptions) {
  // Stop requested, waiting for the run to actually unwind server-side. The
  // button stays in this state until the run's terminal event arrives (or the
  // confirmation deadline passes), so it never claims a cancel it hasn't got.
  const [stopping, setStopping] = useState(false);
  const stopConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStopConfirmTimeout = useCallback(() => {
    if (stopConfirmTimeoutRef.current) {
      clearTimeout(stopConfirmTimeoutRef.current);
      stopConfirmTimeoutRef.current = null;
    }
  }, []);
  const stopResyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStopResyncTimeout = useCallback(() => {
    if (stopResyncTimeoutRef.current) {
      clearTimeout(stopResyncTimeoutRef.current);
      stopResyncTimeoutRef.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      clearStopConfirmTimeout();
      clearStopResyncTimeout();
    },
    [clearStopConfirmTimeout, clearStopResyncTimeout],
  );

  /**
   * Refetch the persisted transcript (and the dock) for a stopped run, without
   * touching run state. Only a chat that exists server-side can be refetched — a
   * brand-new chat stopped during startup is still keyed by its temp tracking
   * id, which no record answers to.
   */
  const resyncStoppedTranscript = useCallback(
    (options?: { interrupted?: boolean }) => {
      const chatId = id || (tempChatIdRef.current?.startsWith("new-") ? null : tempChatIdRef.current);
      if (!chatId) {
        clearInFlightMessages();
        return;
      }
      // Refetch rather than keep the partially-streamed view: the server
      // persisted whatever the run produced before it died, including the
      // synthetic "interrupted" tool results.
      getChat(chatId)
        .then((chatData) => {
          if (currentIdRef.current !== chatId) return;
          setChat(chatData);
        })
        .catch(() => {});
      getMessages(chatId)
        .then((msgs) => {
          if (currentIdRef.current !== chatId) return;
          const msgArray = Array.isArray(msgs) ? msgs : [];
          // Skipped when the harness already wrote its own marker — see
          // endsWithInterruptMarker.
          const needsNotice = options?.interrupted && !endsWithInterruptMarker(msgArray);
          setMessages(needsNotice ? [...msgArray, { role: "system", type: "system", content: INTERRUPTED_MESSAGE }] : msgArray);
        })
        .catch(() => {})
        .finally(() => clearInFlightMessages());
      refreshActivity(chatId);
    },
    [id, tempChatIdRef, currentIdRef, setChat, setMessages, clearInFlightMessages, refreshActivity],
  );

  /**
   * Tear down the local view of a run that is no longer live server-side, and
   * resync the transcript. Used when there's no stream to carry the run's
   * terminal event to us: the session had already ended, we're not connected
   * (page was refreshed), or the confirmation deadline passed.
   */
  const finishStopLocally = useCallback(
    (options?: { interrupted?: boolean }) => {
      clearStopConfirmTimeout();
      abortRef.current?.abort();
      abortRef.current = null;
      setStopping(false);
      setStreaming(false);
      setPendingAction(null);
      resyncStoppedTranscript(options);
    },
    [clearStopConfirmTimeout, abortRef, setStreaming, setPendingAction, resyncStoppedTranscript],
  );

  const handleStop = useCallback(async () => {
    // A chat still being created is addressable by the temp tracking id we
    // generated for it (sent to /new/message as clientTrackingId).
    const chatId = id || tempChatIdRef.current;
    if (!chatId) {
      finishStopLocally();
      return;
    }

    setStopping(true);
    // Hold off auto-reconnect until the registry admits the run is gone —
    // otherwise the poll's stale "active" (or a CLI-watcher session spawned
    // from the killed run's log file) drags the UI back into "responding".
    suppressReconnectAfterStopRef.current = true;
    let stopped: boolean;
    try {
      // Deliberately does NOT close the SSE first: the stream is how the
      // server tells us the run actually finished unwinding, and it carries
      // the final transcript state with it. Killing it here is what made the
      // old stop look instant while the run kept going.
      ({ stopped } = await stopChat(chatId));
    } catch {
      setStopping(false);
      setNetworkError("Failed to stop the session — it may still be running.");
      return;
    }

    // Nothing was running server-side: our view was stale, so just resync.
    if (!stopped) {
      finishStopLocally();
      return;
    }

    // The harness writes the turn's partial output and its "[Request
    // interrupted by user]" marker as it dies — about a second after the abort,
    // i.e. AFTER the terminal event that triggers the settle refetch below. One
    // delayed resync picks that up, instead of leaving the killed turn's
    // response blank until the user reloads.
    clearStopResyncTimeout();
    stopResyncTimeoutRef.current = setTimeout(() => resyncStoppedTranscript({ interrupted: true }), STOP_RESYNC_DELAY_MS);

    // Cancelled. Without a live stream (page refreshed, inactivity timeout)
    // no terminal event can reach us, so settle now.
    if (!abortRef.current) {
      finishStopLocally({ interrupted: true });
      return;
    }

    // Otherwise wait for message_complete (reason: "aborted"), with a deadline
    // so a run whose unwind never lands can't pin the UI in "Stopping…".
    clearStopConfirmTimeout();
    stopConfirmTimeoutRef.current = setTimeout(() => finishStopLocally({ interrupted: true }), STOP_CONFIRM_TIMEOUT_MS);
  }, [
    id,
    tempChatIdRef,
    abortRef,
    suppressReconnectAfterStopRef,
    setNetworkError,
    finishStopLocally,
    clearStopConfirmTimeout,
    clearStopResyncTimeout,
    resyncStoppedTranscript,
  ]);

  // Any end-of-run event (complete, error, abort confirmation) clears the
  // pending-stop state — it's tied to a run being live.
  useEffect(() => {
    if (!streaming) {
      setStopping(false);
      clearStopConfirmTimeout();
    }
  }, [streaming, clearStopConfirmTimeout]);

  return { stopping, canStop: stoppable && !stopping, handleStop };
}
