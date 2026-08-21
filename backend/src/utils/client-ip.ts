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
 * Headers that mean "something forwarded this request to me".
 *
 * Not an exhaustive census of proxy headers, and it does not need to be: the
 * rule below rejects a request that carries *any* of these, so the list only has
 * to cover what a proxy plausibly sends. `x-forwarded-proto` / `-host` are
 * deliberately included — they carry no address, but their presence is still
 * evidence of a hop, which is the thing being tested.
 *
 * Verified not to break Callboard's own dev setup: `frontend/vite.config.ts`
 * proxies `/api` with a bare string target, and `http-proxy`'s `xfwd` defaults
 * to false, so the dev proxy adds none of these.
 */
const FORWARDING_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "fastly-client-ip",
  "fly-client-ip",
  "forwarded",
] as const;

/**
 * Is this request certainly from the same machine or the same LAN, with nothing
 * in between?
 *
 * The gate for capabilities that are safe locally and not safe remotely — today
 * exactly one, `POST /api/engines/:id/install`, which runs `npm install -g` on
 * the daemon's machine. Remote access can put that daemon on the public internet
 * with a password as the only barrier (see `services/web-tunnel.ts`), so
 * "authenticated" is not a strong enough answer for a command execution surface.
 *
 * ## Why this is stricter than {@link getClientKey}, and not merely built on it
 *
 * It was, and that was wrong. `getClientKey` trusts forwarding headers whenever
 * the socket is loopback, which is correct for its own job (rate-limit buckets
 * must not collapse into one shared `127.0.0.1` under the tunnel) and correct
 * for the cloudflared path, where `CF-Connecting-IP` is preferred and checked
 * first. But `X-Forwarded-For` is a **list**, cloudflared *appends* to a
 * client-supplied one, and `getClientKey` takes the head — so a request whose
 * socket is loopback and whose header reads `127.0.0.1, 203.0.113.7` keys as
 * `127.0.0.1` and passed the old check. Measured.
 *
 * The exposure is not cloudflared. It is everything else that terminates on
 * loopback and does not overwrite the header: `ssh -R`, socat, a hand-rolled
 * nginx or Caddy vhost, Tailscale Funnel. Under any of those, a remote client
 * could hand itself this capability by sending one header.
 *
 * So for this capability the rule is **both** conditions, not a derived address:
 *
 * 1. the socket's own peer address is loopback or private/LAN, and
 * 2. the request carries no forwarding header at all.
 *
 * A genuine same-machine browser sends neither, so the strictness costs nothing
 * real. A tunnelled client fails (2) — cloudflared always sets
 * `CF-Connecting-IP` — and lands on the copy-command, which is where Decision 8
 * says it should land anyway. Anything that proxies *without* marking the hop is
 * indistinguishable from a local browser at the socket layer and always will be;
 * that residue is named in the report rather than papered over.
 *
 * This is deliberately **not** `getClientKey`-based and deliberately not called
 * `isLocalClient`: the loose question ("who do I bill this request to?") and the
 * strict one ("may this request execute a command?") have different answers, and
 * a shared name invites the next caller to pick the wrong one.
 *
 * An unparseable or absent address is not local: `isPrivateOrLoopback` fails
 * closed.
 */
export function isDirectLocalClient(req: Request): boolean {
  const headers = req.headers ?? {};
  for (const name of FORWARDING_HEADERS) {
    const value = headers[name];
    // An empty-string header still means a hop announced itself.
    if (value !== undefined && value !== null) return false;
  }
  const socketIp = req.socket?.remoteAddress;
  if (!socketIp) return false;
  return isPrivateOrLoopback(socketIp);
}
