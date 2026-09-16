import { newChatViewId } from "./ids.js";
import {
  chatFilterValidationError,
  chatSearchValidationError,
  type ChatFilters,
  type ChatViewOptions,
  type ChatViewSnapshot,
} from "shared/types/chat-filters.js";

// Module state belongs to this JS realm/tab, never localStorage or a server last-tab slot.
let snapshot: ChatViewSnapshot | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let revision = 0;
let viewId: string | undefined;
let reportError: ((error: string | undefined) => void) | undefined;
async function send() {
  if (!snapshot) return;
  const sending = snapshot;
  try {
    const response = await fetch("/api/chats/view-context", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sending),
    });
    if (!response.ok && snapshot === sending) {
      stopChatViewPublisher();
      reportError?.(
        "Browser view could not be registered. Visible chat search is unavailable; edit a sidebar filter to retry. Chat messages remain available.",
      );
    }
  } catch {
    /* The message snapshot closes publisher/network races. Expiry is explicit server-side. */
  }
}
export function publishChatView(filters: ChatFilters, options: ChatViewOptions, submittedSearch: string, onError?: (error: string | undefined) => void) {
  reportError = onError;
  const error = chatFilterValidationError(filters) ?? chatSearchValidationError(submittedSearch);
  if (error) {
    stopChatViewPublisher();
    reportError?.(error + " Visible chat search is unavailable until corrected; chat messages remain available.");
    return;
  }
  reportError?.(undefined);
  const normalized = structuredClone(filters);
  for (const key of ["dateMin", "dateMax"] as const) {
    const f = normalized[key];
    if (f.value && Number.isFinite(Date.parse(f.value))) f.value = new Date(f.value).toISOString();
  }
  viewId ??= newChatViewId();
  snapshot = { viewId, revision: ++revision, filters: normalized, options: { ...options }, submittedSearch: submittedSearch.trim() };
  void send();
  timer ??= setInterval(() => {
    if (snapshot) snapshot = { ...snapshot, revision: ++revision };
    void send();
  }, 25_000);
}
export function originatingChatView() {
  // Explicit foreground capture renews an expired view. A delayed old packet
  // keeps its old revision and cannot renew a tombstoned context.
  if (snapshot) snapshot = { ...snapshot, revision: ++revision };
  return snapshot ? structuredClone(snapshot) : undefined;
}
export function stopChatViewPublisher() {
  if (snapshot) {
    const body = JSON.stringify({ viewId: snapshot.viewId, revision: ++revision });
    void Promise.resolve()
      .then(() =>
        fetch("/api/chats/view-context", {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }),
      )
      .catch(() => {});
  }
  clearInterval(timer);
  timer = undefined;
  snapshot = undefined;
}
