import type { SandboxDeliveriesResponse, SandboxKeptRetryResult } from "shared/types/index.js";

/**
 * Sandbox desktop deliverables (`GET /api/computer-use/:chatId/deliverables`)
 * and the two actions on a container kept for recovery. Same-origin cookie
 * session, like the rest of `/api/computer-use`; the server refuses API keys.
 */
async function call<T>(chatId: string, path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await fetch(`/api/computer-use/${encodeURIComponent(chatId)}/${path}`, {
    method,
    credentials: "include",
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status})`);
  return data as T;
}

/** Shape check: anything malformed is dropped, never rendered. */
export function validateDeliveries(value: SandboxDeliveriesResponse): SandboxDeliveriesResponse {
  const sessions = Array.isArray(value?.sessions) ? value.sessions : [];
  const kept = Array.isArray(value?.kept) ? value.kept : [];
  return {
    sessions: sessions
      .filter((session) => session && typeof session.sessionId === "string" && Array.isArray(session.files) && Array.isArray(session.refused))
      .map((session) => ({
        ...session,
        files: session.files.filter(
          (file) => file && typeof file.path === "string" && file.path.startsWith("/") && typeof file.name === "string" && Number.isSafeInteger(file.size),
        ),
      })),
    kept: kept.filter((k) => k && typeof k.sessionId === "string" && Number.isFinite(k.expiresAt)),
  };
}

export const sandboxDeliveriesClient = {
  list: (chatId: string) => call<SandboxDeliveriesResponse>(chatId, "deliverables").then(validateDeliveries),
  retryKept: (chatId: string, sessionId: string) => call<SandboxKeptRetryResult>(chatId, `kept/${encodeURIComponent(sessionId)}/retry`, "POST"),
  discardKept: (chatId: string, sessionId: string) => call<unknown>(chatId, `kept/${encodeURIComponent(sessionId)}/discard`, "POST"),
};
