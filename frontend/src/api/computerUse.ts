import type { ComputerUseActionRequest, ComputerUseKind, ComputerUseObservation, ComputerUseSession, ComputerUseStatus } from "shared/types/computerUse.js";

/** A failed route response. The server's `code` (`not_found`, `stale_generation`,
 * `denied`, …) travels with the message so callers can distinguish "the server no
 * longer knows this session" from a transport failure that is worth retrying.
 */
export interface ComputerUseRequestError extends Error {
  status: number;
  code?: string;
}
export function controlErrorCode(error: unknown): string | undefined {
  const code = (error as Partial<ComputerUseRequestError> | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Same-origin cookie authentication, as in api.ts. The server must enforce
 * Origin/CSRF, chat ownership, scoped grants and generation fencing on every route.
 * Keep endpoint/envelope adaptations here, not in the viewer.
 */
async function request<T>(chatId: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/computer-use/${encodeURIComponent(chatId)}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const reason = typeof data?.error === "string" ? data.error : (data?.error?.message ?? data?.message);
    const failure: ComputerUseRequestError = Object.assign(
      new Error(
        typeof reason === "string" ? reason : `Computer control unavailable (${response.status}). Check server configuration and chat permissions, then retry.`,
      ),
      { status: response.status, ...(typeof data?.code === "string" ? { code: data.code } : {}) },
    );
    throw failure;
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const sessionPath = (id: string, operation: string) => `${encodeURIComponent(id)}/${operation}`;

export function validateStatus(value: ComputerUseStatus): ComputerUseStatus {
  if (
    !value ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.sessions) ||
    !["allow", "ask", "deny"].includes(value.permission) ||
    (value.events !== undefined &&
      (!Array.isArray(value.events) ||
        value.events.length > 100 ||
        value.events.some(
          (event) =>
            !event ||
            typeof event.sessionId !== "string" ||
            typeof event.type !== "string" ||
            !Number.isSafeInteger(event.generation) ||
            !Number.isFinite(event.at),
        ))) ||
    value.sessions.some(
      (session) =>
        !session ||
        typeof session.id !== "string" ||
        !["browser", "native"].includes(session.kind) ||
        typeof session.state !== "string" ||
        !["agent", "human", null].includes(session.controller) ||
        !Number.isSafeInteger(session.generation) ||
        session.generation < 0,
    ) ||
    value.capabilities.some((capability) => !capability || !["browser", "native"].includes(capability.kind) || typeof capability.available !== "boolean")
  ) {
    throw new Error("Invalid computer-control status. Check the server viewer contract and retry.");
  }
  return value;
}

export function validateObservation(value: ComputerUseObservation): ComputerUseObservation {
  const frame = value?.frame;
  if (
    !frame ||
    typeof value.frameId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.frameId) ||
    !["image/png", "image/jpeg", "image/webp"].includes(frame.mimeType) ||
    typeof frame.data !== "string" ||
    frame.data.length > 28_000_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data) ||
    !Number.isSafeInteger(frame.width) ||
    frame.width <= 0 ||
    frame.width > 16384 ||
    !Number.isSafeInteger(frame.height) ||
    frame.height <= 0 ||
    frame.height > 16384 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) {
    throw new Error("Invalid screenshot response. Refresh status or check the server viewer contract.");
  }
  return value;
}

export const computerUseClient = {
  status: (chatId: string, signal?: AbortSignal) => request<ComputerUseStatus>(chatId, "status", undefined, signal).then(validateStatus),
  open: (chatId: string, kind: ComputerUseKind, signal?: AbortSignal) => request<{ session: ComputerUseSession }>(chatId, "open", { kind }, signal),
  observe: (chatId: string, sessionId: string, signal?: AbortSignal) =>
    request<ComputerUseObservation>(chatId, sessionPath(sessionId, "observe"), {}, signal).then(validateObservation),
  action: (chatId: string, sessionId: string, action: ComputerUseActionRequest, signal?: AbortSignal) =>
    request<unknown>(chatId, sessionPath(sessionId, "action"), action, signal),
  control: (
    chatId: string,
    sessionId: string,
    operation: "takeover" | "resume" | "stop" | "revoke" | "approve",
    expectedGeneration: number,
    signal?: AbortSignal,
  ) => request<unknown>(chatId, sessionPath(sessionId, operation), { expectedGeneration }, signal),
};
