// Frontend auth helpers for the dashboard's session cookie flow.
// All requests must send the session cookie via `credentials: "include"`.

export interface AuthCheckResult {
  /**
   * `null` means "couldn't tell": the check was rate limited (429) or the
   * daemon didn't answer. Keep whatever screen is showing and check again
   * after `retryAfter` seconds; a valid session must not be sent to Login.
   */
  authenticated: boolean | null;
  error?: string;
  /** Seconds to wait before checking again (only when `authenticated` is null). */
  retryAfter?: number;
  /** True when the daemon gave no response at all. */
  unreachable?: boolean;
}

export interface AuthError {
  status: number;
  message: string;
}

let authRequiredHandler: (() => void) | null = null;

/** Register a single handler to be invoked when an admin call returns 401. */
export function onAuthRequired(handler: () => void): () => void {
  authRequiredHandler = handler;
  return () => {
    if (authRequiredHandler === handler) authRequiredHandler = null;
  };
}

/** Invoked by the api wrapper when a session-protected call returns 401. */
export function notifyAuthRequired(): void {
  authRequiredHandler?.();
}

function friendly429(): string {
  return "Too many attempts. Try again in a minute.";
}

/**
 * A 502/503/504 that a proxy in front of the daemon sent because the daemon
 * isn't answering. The daemon also sends 503 itself (no password set, vault
 * key missing), always with a JSON `{ error }`; that is a real error from a
 * running daemon, not "offline". Shared by api.ts and checkAuth.
 */
export function isGatewayFailure(status: number, daemonError?: unknown): boolean {
  if (status !== 502 && status !== 503 && status !== 504) return false;
  return !(typeof daemonError === "string" && daemonError !== "");
}

/** Seconds from a 429's Retry-After (or RateLimit-Reset), clamped to 1–120. */
function retryAfterSeconds(res: Response, fallback: number): number {
  for (const name of ["retry-after", "ratelimit-reset"]) {
    const raw = res.headers.get(name);
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.min(120, Math.max(1, Math.ceil(n)));
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) {
      return Math.min(120, Math.max(1, Math.ceil((at - Date.now()) / 1000)));
    }
  }
  return fallback;
}

const UNREACHABLE = "Can't reach the Drawlatch daemon. Is it running?";

export async function checkAuth(): Promise<AuthCheckResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/check", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch {
    return { authenticated: null, unreachable: true, retryAfter: 5, error: UNREACHABLE };
  }
  if (res.status === 429) {
    // /api/auth/check allows 20 a minute per IP: enough reloads or new tabs
    // trip it while the session is perfectly valid.
    return {
      authenticated: null,
      retryAfter: retryAfterSeconds(res, 30),
      error: "Too many requests to the daemon.",
    };
  }
  const data = (await res.json().catch(() => ({}))) as {
    authenticated?: boolean;
    error?: string;
  };
  if (isGatewayFailure(res.status, data.error)) {
    return { authenticated: null, unreachable: true, retryAfter: 5, error: UNREACHABLE };
  }
  if (res.ok) return { authenticated: !!data.authenticated };
  return { authenticated: false, error: data.error };
}

export async function login(password: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return;
  if (res.status === 429) {
    throw { status: 429, message: friendly429() } satisfies AuthError;
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw {
    status: res.status,
    message: data.error || "Login failed",
  } satisfies AuthError;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json" },
  }).catch(() => undefined);
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const res = await fetch("/api/auth/change-password", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (res.ok) return;
  if (res.status === 429) {
    throw { status: 429, message: friendly429() } satisfies AuthError;
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw {
    status: res.status,
    message: data.error || "Password change failed",
  } satisfies AuthError;
}
