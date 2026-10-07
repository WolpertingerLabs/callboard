/**
 * GET an http(s) URL on behalf of the media proxy (`/api/files/serve?url=`),
 * refusing any destination that is not a public unicast address.
 *
 * Why not `fetch`: it follows redirects itself and resolves DNS out of our
 * sight, so a check on the URL we were given says nothing about where the
 * socket actually goes. Here:
 *  - every hop is checked — redirects are followed by hand, up to
 *    {@link MAX_REDIRECTS}, each `Location` going through the same checks;
 *  - the check runs on the *resolved* addresses. An IP-literal host is checked
 *    as written; a hostname is resolved inside the socket's own `lookup`, every
 *    address it resolves to must pass, and the socket connects to those same
 *    validated addresses. There is no second resolution for a rebinding DNS
 *    server to answer differently.
 *
 * Not covered: a public address that itself forwards to an internal one (an
 * open proxy or a port-forward on someone's router). HTTP(S)_PROXY is not a
 * gap: Node's `http` ignores those variables, so there is no proxy hop.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";

export const MAX_REDIRECTS = 5;

/** Thrown when a hop's destination is not allowed. `message` is safe to show. */
export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedDestinationError";
  }
}

/**
 * Public unicast only. `ipaddr.process` unwraps IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`) first, so the IPv4 rules apply to it. Everything
 * ipaddr.js classes as anything but `unicast` is refused: loopback, private
 * (RFC 1918), CGNAT (100.64/10), link-local (169.254/16, fe80::/10), ULA
 * (fc00::/7), unspecified (0.0.0.0/8, ::), multicast, broadcast, reserved and
 * documentation ranges, and the IPv6 transition prefixes that embed an IPv4
 * address (NAT64 64:ff9b::/96 and 64:ff9b:1::/48, SIIT ::ffff:0:0:0/96, 6to4,
 * Teredo).
 *
 * The one IPv4-embedding form ipaddr.js calls `unicast` is IPv4-compatible
 * IPv6, `::a.b.c.d` (::/96, deprecated by RFC 4291) — `::7f00:1` is 127.0.0.1
 * — so ::/96 is refused explicitly.
 */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).match(IPV4_COMPATIBLE)) return false;
  return parsed.range() === "unicast";
}

const IPV4_COMPATIBLE: [ipaddr.IPv6, number] = [ipaddr.IPv6.parse("::"), 96];

type LookupAddress = { address: string; family: number };
type Lookup = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

export interface PublicFetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Address policy. Tests swap it to reach a local fixture server; production always uses {@link isPublicAddress}. */
  isAllowedAddress?: (address: string) => boolean;
  /** Resolver, for tests. Defaults to `dns.lookup`. */
  lookup?: Lookup;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GET `url`, following up to {@link MAX_REDIRECTS} redirects, with every hop's
 * resolved destination checked. Resolves to the final non-redirect response
 * (any status) for the caller to stream; rejects with
 * {@link BlockedDestinationError} when a hop is refused.
 */
export async function fetchPublicUrl(url: string, opts: PublicFetchOptions = {}): Promise<http.IncomingMessage> {
  const isAllowed = opts.isAllowedAddress ?? isPublicAddress;
  const resolve = opts.lookup ?? (dns.lookup as unknown as Lookup);
  let current = new URL(url);

  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new BlockedDestinationError("Redirect to a non-http(s) URL refused");
    }
    // `hostname` keeps the brackets of an IPv6 literal.
    const host = current.hostname.replace(/^\[(.*)\]$/, "$1");
    if (net.isIP(host) && !isAllowed(host)) {
      throw new BlockedDestinationError(`Destination ${host} is not a public address`);
    }

    const res = await requestOnce(current, opts, isAllowed, resolve);
    const location = res.headers.location;
    if (!REDIRECT_STATUSES.has(res.statusCode ?? 0) || !location) return res;

    res.resume();
    if (hop >= MAX_REDIRECTS) throw new BlockedDestinationError(`More than ${MAX_REDIRECTS} redirects`);
    current = new URL(location, current);
  }
}

function requestOnce(
  target: URL,
  opts: PublicFetchOptions,
  isAllowed: (address: string) => boolean,
  resolve: Lookup,
): Promise<http.IncomingMessage> {
  // Validate inside the socket's own resolution, so the address checked is the
  // address connected to. Node calls this for hostnames only (IP literals
  // connect directly, and were checked by the caller).
  const lookup = (hostname: string, options: dns.LookupOptions, callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { family: options.family as number | undefined, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const blocked = addresses.find((a) => !isAllowed(a.address));
      if (blocked) return callback(new BlockedDestinationError(`${hostname} resolves to ${blocked.address}, which is not a public address`));
      if (addresses.length === 0) return callback(Object.assign(new Error(`${hostname} did not resolve`), { code: "ENOTFOUND" }));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };

  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolvePromise, reject) => {
    const req = client.request(
      target,
      {
        method: "GET",
        headers: opts.headers,
        signal: opts.signal,
        lookup: lookup as net.LookupFunction,
        // A fresh connection per hop: no pooled socket from an earlier lookup.
        agent: false,
      },
      resolvePromise,
    );
    req.on("error", reject);
    req.end();
  });
}
