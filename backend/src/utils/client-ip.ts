import type { Request } from "express";

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
