import type { Request } from "express";
import { isPrivateOrLoopback } from "./ip-allowlist.js";

/**
 * True when an address is a loopback address (IPv4 127.0.0.0/8 or IPv6 ::1).
 * Handles IPv4-mapped IPv6 addresses (e.g. "::ffff:127.0.0.1").
 */
function isLoopback(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const ip = addr.replace(/^::ffff:/i, "").trim();
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.");
}

/**
 * Resolve the identity used for per-client rate limiting and brute-force counters.
 *
 * Primary callboard usage is local — the browser runs on the same machine or on the
 * LAN and connects directly. In that case the socket's remote address IS the client,
 * so we key on it and deliberately IGNORE client-supplied forwarding headers, which a
 * remote attacker could otherwise spoof to mint themselves an unlimited number of
 * fresh rate-limit buckets.
 *
 * When callboard is exposed through the local cloudflared tunnel, every request
 * instead arrives from loopback (127.0.0.1) and cloudflared appends the genuine
 * remote client address in `CF-Connecting-IP` (and `X-Forwarded-For`). Only in that
 * loopback case do we trust those headers — otherwise all tunnel traffic would
 * collapse into a single shared 127.0.0.1 bucket, letting one remote client exhaust
 * the limit for everyone (and defeating per-IP login throttling entirely).
 *
 * Note: a self-managed non-loopback reverse proxy is intentionally not trusted here,
 * since the supported remote-access path is the bundled loopback cloudflared tunnel.
 */
export function getClientKey(req: Request): string {
  const socketIp = req.socket?.remoteAddress || req.ip || "unknown";

  if (isLoopback(socketIp)) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) {
      return cf.trim();
    }
    const xff = req.headers["x-forwarded-for"];
    const forwarded = (typeof xff === "string" ? xff : Array.isArray(xff) ? xff[0] : "")?.split(",")[0]?.trim();
    if (forwarded) {
      return forwarded;
    }
  }

  return socketIp;
}

/**
 * Is this request from the same machine or the same LAN, rather than from the
 * public internet through the remote-access tunnel?
 *
 * The gate for capabilities that are safe locally and not safe remotely — today
 * that is exactly one thing, `POST /api/engines/:id/install`, which runs
 * `npm install -g` on the daemon's machine. Remote access can put that daemon on
 * the public internet with a password as the only barrier (see
 * `services/web-tunnel.ts`), so "authenticated" is not a strong enough answer
 * for a command execution surface, and a tunnelled client gets the
 * copy-the-command fallback instead.
 *
 * Built on {@link getClientKey}, so it inherits that function's one piece of
 * judgement: forwarding headers are trusted **only** when the socket itself is
 * loopback, which is the shape cloudflared produces and the shape a remote
 * attacker connecting directly cannot. The residual case is a request that
 * arrives on loopback with no `CF-Connecting-IP` and no `X-Forwarded-For` — that
 * reads as local, because it is indistinguishable from a browser on the same
 * machine. `requireAuth` already trusts exactly the same derivation for the
 * remote-access IP allowlist, so this adds no new trust, only a new consumer.
 *
 * An unparseable or unknown address is **not** local: `isPrivateOrLoopback`
 * fails closed.
 */
export function isLocalClient(req: Request): boolean {
  return isPrivateOrLoopback(getClientKey(req));
}
