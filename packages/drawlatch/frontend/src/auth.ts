// Frontend auth helpers for the dashboard's session cookie flow.
// All requests must send the session cookie via `credentials: "include"`.

export interface AuthCheckResult {
  authenticated: boolean;
  error?: string;
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

export async function checkAuth(): Promise<AuthCheckResult> {
  try {
    const res = await fetch("/api/auth/check", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    const data = (await res.json().catch(() => ({}))) as AuthCheckResult;
    if (res.ok) return { authenticated: !!data.authenticated };
    return { authenticated: false, error: data.error };
  } catch {
    return { authenticated: false };
  }
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
