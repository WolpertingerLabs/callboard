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
// Applied-state/remount generations are distinct from transport revisions.
// Captures and heartbeats alone do not prove that the server accepted a view.
let generation = 0;
let acceptedRevision = -1;
let reportError: ((error: string | undefined) => void) | undefined;
function appliedStateKey(view: Pick<ChatViewSnapshot, "filters" | "options" | "submittedSearch">) {
  return JSON.stringify([
    ...(["directoryInclude", "directoryExclude", "dateMin", "dateMax"] as const).map((key) => [view.filters[key].active, view.filters[key].value]),
    view.options.bookmarked,
    view.options.showTriggered,
    view.options.showArchived,
    view.submittedSearch,
  ]);
}
async function send() {
  if (!snapshot) return;
  const sending = snapshot;
  const sendingGeneration = generation;
  try {
    const response = await fetch("/api/chats/view-context", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sending),
    });
    if (!snapshot || generation !== sendingGeneration) return;
    if (response.ok) {
      acceptedRevision = Math.max(acceptedRevision, sending.revision);
    } else if (response.status === 429 || response.status >= 500) {
      // Rate limiting and daemon/proxy outages are transient, like network
      // failure. The next bounded heartbeat retries the live state; no loop.
    } else if (acceptedRevision < sending.revision) {
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
  const applied = { filters: normalized, options: { ...options }, submittedSearch: submittedSearch.trim() };
  if (!snapshot || appliedStateKey(snapshot) !== appliedStateKey(applied)) {
    generation++;
    acceptedRevision = -1;
  }
  snapshot = { viewId, revision: ++revision, ...applied };
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
  generation++;
  acceptedRevision = -1;
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
