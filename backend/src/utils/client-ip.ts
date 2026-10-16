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
 * The entries of a request's `X-Forwarded-For` chain, trimmed, empties dropped.
 * Entries are appended as a request crosses proxies, so the **last** one is the
 * hop nearest this daemon and the first is whatever the client chose to claim.
 */
function forwardedForChain(req: Request): string[] {
  const xff = req.headers?.["x-forwarded-for"];
  return (typeof xff === "string" ? xff : Array.isArray(xff) ? xff.join(",") : "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Resolve the identity used for per-client rate limiting and brute-force counters.
 *
 * Primary callboard usage is local — the browser runs on the same machine or on the
 * LAN (or a VPN such as Tailscale) and connects directly. In that case the socket's
 * remote address IS the client, so we key on it and deliberately IGNORE
 * client-supplied forwarding headers, which a remote attacker could otherwise spoof
 * to mint themselves an unlimited number of fresh rate-limit buckets.
 *
 * Behind a reverse proxy on the same machine (`tailscale serve`, Caddy, nginx) every
 * request instead arrives from loopback and the proxy appends the real client to
 * `X-Forwarded-For`. Only in that loopback case do we read the header — otherwise
 * all proxied traffic would collapse into a single shared 127.0.0.1 bucket, letting
 * one remote client exhaust the limit for everyone (and defeating per-IP login
 * throttling entirely).
 *
 * We take the **last** entry, the one the loopback proxy appended, never the head:
 * a proxy that appends (Go's `httputil.ReverseProxy`, which `tailscale serve` is
 * built on, does) passes a client-supplied chain through, so the head is the
 * caller's to write and keying on it let one client mint a bucket per request.
 * `CF-Connecting-IP` is not read: it was trusted only while Callboard bundled a
 * cloudflared tunnel that overwrote it, and with that gone nothing on this host
 * sets it — through any other proxy it is a header the client wrote.
 *
 * Note: a non-loopback reverse proxy is intentionally not trusted here; its
 * clients share the proxy's bucket.
 */
export function getClientKey(req: Request): string {
  const socketIp = req.socket?.remoteAddress || req.ip || "unknown";

  if (isLoopback(socketIp)) {
    const chain = forwardedForChain(req);
    const nearest = chain[chain.length - 1];
    if (nearest) {
      return nearest;
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
 * the daemon's machine. Remote access (a VPN, a reverse proxy, a port someone
 * forwarded) leaves that daemon with a password as the only barrier, so
 * "authenticated" is not a strong enough answer for a command execution surface.
 *
 * ## Why this is stricter than {@link getClientKey}, and not merely built on it
 *
 * It was, and that was wrong. `getClientKey` trusts forwarding headers whenever
 * the socket is loopback, which is correct for its own job (rate-limit buckets
 * must not collapse into one shared `127.0.0.1` behind a proxy). But it then
 * took the *head* of `X-Forwarded-For`, a **list** that proxies *append* to — so
 * a request whose socket is loopback and whose header read
 * `127.0.0.1, 203.0.113.7` keyed as `127.0.0.1` and passed the old check.
 * Measured. (`getClientKey` now takes the last entry, but that only narrows the
 * question; it does not make a derived address the right test here.)
 *
 * The exposure is anything that terminates on loopback: `tailscale serve`,
 * `ssh -R`, socat, a hand-rolled nginx or Caddy vhost. Under any of those, a
 * remote client could hand itself this capability with one header.
 *
 * So for this capability the rule is **both** conditions, not a derived address:
 *
 * 1. the socket's own peer address is loopback or private/LAN, and
 * 2. the request carries no forwarding header at all.
 *
 * A genuine same-machine browser sends neither, so the strictness costs nothing
 * real. A client behind `tailscale serve` or any other appending proxy fails
 * (2) and lands on the copy-command, which is where Decision 8 says it should
 * land anyway. Anything that proxies *without* marking the hop is
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
 * — the gate skipped entirely, and a session issued. (`getClientKey` has since
 * moved to the last entry too, but its job — a rate-limit bucket — still
 * differs: it reads the header from loopback only and never exempts anyone.)
 * The loose question and the strict one need different answers.
 * `client-ip.ts` already said so about `isDirectLocalClient`; the gate reached
 * for the loose helper anyway.
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
 *    The address is the **last** `X-Forwarded-For` entry — the one a proxy
 *    appends, rather than the head a client controls — else the socket address,
 *    which will not be on any allowlist and so refuses. `CF-Connecting-IP` is
 *    not read: no proxy Callboard ships sets it any more, so behind
 *    `tailscale serve` it is the client's own header, and preferring it let an
 *    off-list client name an allowlisted address and walk through.
 *
 * Case 3 is deliberately fail-closed and it has a cost: an operator running
 * their own loopback reverse proxy *and* a non-empty allowlist must put their
 * address on it. That is the honest meaning of "the allowlist gates every /api
 * route", and it only bites when a list is configured (an empty one still means
 * no restriction, so the default install is untouched).
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

  // 3. Proxied. Attribute as conservatively as the headers allow: the LAST
  // forwarded entry, the one the nearest proxy appended.
  const chain = forwardedForChain(req);
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

/**
 * Did the browser reach us over https? Decides which session cookie login
 * issues: `__Secure-callboard_session` (Secure) over https, the plain
 * `callboard_session` over http — see `SECURE_SESSION_COOKIE_NAME` in auth.ts.
 *
 * The daemon itself only speaks plain http, so on a direct connection
 * `req.secure` is false (Express derives it from the socket, not a header,
 * because `trust proxy` is never set). Https exists only in front of a local
 * terminator — `tailscale serve`, Caddy, nginx — which connects to
 * `http://127.0.0.1:<port>` and may send `X-Forwarded-Proto: https`.
 *
 * So `X-Forwarded-Proto` is believed only when the socket is loopback — the
 * same gate {@link getClientKey} uses. From a LAN or public socket it is the
 * caller's own header and is ignored: a LAN browser on plain http that sent it
 * would otherwise be handed a Secure cookie it then refuses to store. A spoofed
 * value from loopback only chooses which cookie the spoofer itself receives,
 * which weakens nothing. In a list the LAST entry is used: proxies append, so
 * it is the one the loopback terminator wrote, not whatever the client sent.
 */
export function arrivedOverHttps(req: Request): boolean {
  if (req.secure) return true;
  if (!isLoopback(req.socket?.remoteAddress)) return false;
  const xfp = req.headers["x-forwarded-proto"];
  const chain = (typeof xfp === "string" ? xfp : Array.isArray(xfp) ? xfp.join(",") : "").split(",");
  return chain[chain.length - 1].trim().toLowerCase() === "https";
}
