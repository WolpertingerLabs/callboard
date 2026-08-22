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
/**
 * The address the remote-access IP allowlist should judge, and whether this
 * request is exempt from it at all.
 *
 * ## Why this is not {@link getClientKey}
 *
 * It was, and that was a hole. `getClientKey` takes the **head** of
 * `X-Forwarded-For`, which is the original client in a well-formed chain and
 * anything the caller likes in a hostile one. Measured against the gate before
 * this function existed, with the allowlist set to a single address that was not
 * the caller's:
 *
 *     X-Forwarded-For: 8.8.8.8               → 403          (gate works)
 *     X-Forwarded-For: 127.0.0.1, 8.8.8.8    → 200 {"ok":true} on /api/auth/login
 *
 * — the gate skipped entirely, and a session issued. The same header shape is
 * *correct* for `getClientKey`'s own job (rate-limit buckets must not collapse
 * into one shared `127.0.0.1` under the tunnel), which is exactly why the loose
 * question and the strict one need different answers. `client-ip.ts` already
 * said so about `isDirectLocalClient`; the gate reached for the loose helper
 * anyway.
 *
 * ## The rule
 *
 * 1. **Socket is public** — a direct connection from the internet. Judge the
 *    socket address and ignore every header: they are the caller's to write.
 * 2. **Socket is loopback/LAN with no forwarding header** — a genuine local or
 *    LAN client. **Exempt**, and this case is load-bearing: it is the path by
 *    which an operator repairs a settings file that has locked everyone else
 *    out.
 * 3. **Socket is loopback/LAN with a forwarding header** — something proxied
 *    this, so it is not local however the header spells itself. Never exempt.
 *    The address is `CF-Connecting-IP` (the supported cloudflared path, which
 *    that proxy overwrites), else the **last** `X-Forwarded-For` entry — the one
 *    a proxy appends, rather than the head a client controls — else the socket
 *    address, which will not be on any allowlist and so refuses.
 *
 * Case 3 is deliberately fail-closed and it has a cost: an operator running
 * their own loopback reverse proxy *and* a non-empty allowlist must put their
 * address on it. That is the honest meaning of "the allowlist gates every /api
 * route", it only bites when a list is configured (an empty one still means no
 * restriction, so the default install is untouched), and a self-managed proxy
 * was already outside the supported set — see {@link getClientKey}'s last note.
 */
export interface AllowlistSubject {
  /** The address to test against the allowlist. */
  address: string;
  /** True ⇒ do not gate at all. Only a direct loopback/LAN client with no forwarding header. */
  exempt: boolean;
}

export function allowlistSubject(req: Request): AllowlistSubject {
  const headers = req.headers ?? {};
  const socketIp = req.socket?.remoteAddress || req.ip || "";

  // 1. A direct connection from a public address. Its headers are its own.
  if (!isPrivateOrLoopback(socketIp)) return { address: socketIp || "unknown", exempt: false };

  const forwarded = FORWARDING_HEADERS.some((name) => headers[name] !== undefined && headers[name] !== null);

  // 2. Genuinely local. The repair path.
  if (!forwarded) return { address: socketIp, exempt: true };

  // 3. Proxied. Attribute as conservatively as the headers allow.
  const cf = headers["cf-connecting-ip"];
  const cfValue = (typeof cf === "string" ? cf : Array.isArray(cf) ? cf[0] : "")?.trim();
  if (cfValue) return { address: cfValue, exempt: false };

  const xff = headers["x-forwarded-for"];
  const chain = (typeof xff === "string" ? xff : Array.isArray(xff) ? xff.join(",") : "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // The LAST entry, not the first: entries are appended as a request crosses
  // proxies, so the rightmost is the hop nearest this daemon and the leftmost is
  // whatever the client chose to claim.
  const nearest = chain[chain.length - 1];
  if (nearest) return { address: nearest, exempt: false };

  // A hop announced itself (`x-forwarded-proto`, `forwarded`, …) without giving
  // an address. Nothing to attribute, so nothing to exempt.
  return { address: socketIp, exempt: false };
}

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
