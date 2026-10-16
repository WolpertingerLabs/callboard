import ipaddr from "ipaddr.js";

/**
 * IP allowlisting for remote access (any client that is not a direct
 * loopback/LAN connection).
 *
 * Scope decision (see plan): the allowlist gates ONLY remote clients. Direct
 * loopback and private-LAN connections are always allowed and never reach
 * `isIpAllowed`, because callboard's primary usage is local/LAN and we must
 * never let a list lock those users out. Enforcement lives in
 * `requireAllowedIp` (backend/src/auth.ts), which asks `allowlistSubject`
 * (utils/client-ip.ts) whether the request is exempt and only consults
 * `isIpAllowed` for the rest.
 */

type ParsedIp = ReturnType<typeof ipaddr.parse>;

/** Parse an address string, unwrapping IPv4-mapped IPv6 (::ffff:a.b.c.d). Returns null if invalid. */
function parse(addr: string): ParsedIp | null {
  let s = (addr || "").trim();
  if (!s) return null;
  // Strip brackets and IPv6 zone id (e.g. "[fe80::1%eth0]").
  s = s.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "");
  if (!ipaddr.isValid(s)) return null;
  let parsed: ParsedIp = ipaddr.parse(s);
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
  }
  return parsed;
}

/**
 * True for loopback and private/LAN/link-local ranges (IPv4 RFC1918 + 127/8 +
 * 169.254/16, IPv6 ::1 + fc00::/7 unique-local + fe80::/10 link-local).
 * Unknown/unparseable addresses are treated as NOT local (so they get gated).
 *
 * Deliberately NOT local: 100.64.0.0/10 (carrier-grade NAT), the range
 * Tailscale hands out. It is shared address space, not a LAN — an ISP's CGNAT
 * puts strangers in it too — so a tailnet device is gated by a configured
 * allowlist and refused the install/binary-override capabilities like any
 * other remote client. Operators who want their tailnet allowed add
 * `100.64.0.0/10` (or their devices' addresses) to the allowlist.
 */
export function isPrivateOrLoopback(addr: string): boolean {
  const parsed = parse(addr);
  if (!parsed) return false;
  const range = parsed.range();
  return range === "loopback" || range === "private" || range === "linkLocal" || range === "uniqueLocal";
}

/** True if a single allowlist entry is a syntactically valid IP or CIDR. */
export function validateAllowlistEntry(entry: string): boolean {
  const s = (entry || "").trim();
  if (!s) return false;
  if (s.includes("/")) {
    try {
      ipaddr.parseCIDR(s);
      return true;
    } catch {
      return false;
    }
  }
  return ipaddr.isValid(s);
}

/** Normalize a raw allowlist (array, or newline/comma-separated string) into trimmed, non-empty entries. */
export function parseAllowlist(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[\n,]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Is `addr` permitted by the allowlist?
 *
 * An empty (or all-blank) list means "no restriction" → always true. Otherwise
 * the address must match at least one entry, where an entry is either an exact
 * IP or a CIDR range. IPv4 and IPv6 are matched independently; mismatched kinds
 * never match. Malformed entries are skipped (validate them at save time).
 */
export function isIpAllowed(addr: string, entries: string[] | string | undefined | null): boolean {
  const list = parseAllowlist(entries);
  if (list.length === 0) return true;

  const parsed = parse(addr);
  if (!parsed) return false;

  for (const entry of list) {
    if (entry.includes("/")) {
      try {
        const cidr = ipaddr.parseCIDR(entry);
        // Kinds are verified equal at runtime; cast to a concrete type so the
        // overloaded match() signature resolves (the IPv4 | IPv6 union is not callable).
        if (cidr[0].kind() === parsed.kind() && (parsed as ipaddr.IPv4).match(cidr as [ipaddr.IPv4, number]))
          return true;
      } catch {
        // skip malformed CIDR
      }
    } else {
      const target = parse(entry);
      if (target && target.kind() === parsed.kind() && target.toNormalizedString() === parsed.toNormalizedString()) {
        return true;
      }
    }
  }
  return false;
}
