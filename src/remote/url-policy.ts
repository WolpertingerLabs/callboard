/**
 * Outbound URL policy: allowlist matching, and the normalization that keeps
 * the string matched equal to the string sent.
 *
 * Shared by executeProxyRequest (every proxied request) and the poll ingestor,
 * whose URL can carry agent-set listener params.
 */

// ── Allowlist matching ──────────────────────────────────────────────────────

/** Prefix that turns an allowlist pattern into an exclusion. */
export const ALLOWLIST_EXCLUSION_PREFIX = '!';

/** Whether an allowlist entry is an exclusion (`!pattern`). */
export function isExclusionPattern(pattern: string): boolean {
  return pattern.startsWith(ALLOWLIST_EXCLUSION_PREFIX);
}

/**
 * Whether `url` matches one of the glob `patterns` and none of its exclusions.
 * An entry starting with `!` is an exclusion, as in .gitignore: a URL it
 * matches is refused even when another entry allows it (Calendar's
 * `!…/events/watch` next to `…/events/*`, since a glob can't tell an event ID
 * from the literal segment `watch`). Exclusions only subtract: a list of
 * nothing but exclusions allows nothing. An empty list allows everything;
 * callers that need "nothing" check for it themselves.
 */
export function isEndpointAllowed(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true; // no restrictions if empty
  // Callers pass parsed hrefs, which are canonical already; this keeps a raw
  // URL (`https://Host:443/…`) matching the same way.
  url = canonicalAuthority(url);
  const exclusions = patterns
    .filter(isExclusionPattern)
    .map((p) => canonicalPattern(p.slice(ALLOWLIST_EXCLUSION_PREFIX.length)));
  const inclusions = patterns.filter((p) => !isExclusionPattern(p)).map(canonicalPattern);
  if (!matchesAny(url, inclusions)) return false;
  // An upstream decodes `w%61tch` to `watch`, so an exclusion also checks the
  // URL with unreserved-character escapes decoded.
  return !matchesAny(url, exclusions) && !matchesAny(decodeUnreserved(url), exclusions);
}

/** Decode percent-escapes of RFC 3986 unreserved characters (`%61` → `a`). */
function decodeUnreserved(url: string): string {
  return url.replace(/%([0-9a-f]{2})/gi, (escape, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : escape;
  });
}

/** Whether `url` matches one of `patterns` (already canonical). */
function matchesAny(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Support simple glob patterns: * matches anything within a segment, ** matches across segments
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.__DOUBLE_STAR__.')
          .replace(/\*/g, '[^/]*')
          .replace(/\.__DOUBLE_STAR__\./g, '.*') +
        '$',
    );
    return regex.test(url) && wildcardHostMatches(url, pattern);
  });
}

const canonicalPatterns = new Map<string, string>();

/**
 * A pattern with its scheme and host written the way a parsed URL writes them:
 * lower-case, no default port (`:443` for https, `:80` for http), no trailing
 * dot on the host. Outbound URLs are matched in parsed form (see
 * normalizeOutboundUrl), so `https://API.example.com:443/**` must still match
 * `https://api.example.com/x`. Only the scheme://authority prefix changes;
 * the path and query are matched as written. Cached per pattern string.
 */
export function canonicalPattern(pattern: string): string {
  const cached = canonicalPatterns.get(pattern);
  if (cached !== undefined) return cached;
  const out = canonicalAuthority(pattern);
  canonicalPatterns.set(pattern, out);
  return out;
}

/** canonicalPattern() without the cache, for URLs. */
function canonicalAuthority(value: string): string {
  let out = value;
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(value);
  if (m) {
    const scheme = m[1].toLowerCase();
    let authority = m[2].toLowerCase();
    const defaultPort = scheme === 'https' ? ':443' : scheme === 'http' ? ':80' : null;
    if (defaultPort && authority.endsWith(defaultPort)) {
      authority = authority.slice(0, -defaultPort.length);
    }
    authority = authority.replace(/\.(?=(:\d+)?$)/, '');
    out = `${scheme}://${authority}${m[3]}`;
  }
  return out;
}

/**
 * Re-check a pattern whose host contains a wildcard against the host the URL
 * actually parses to.
 *
 * In the string match, a `*` in the host also matches `?`, `#`, and `@`, so
 * `https://*.amazonaws.com/**` alone would accept
 * `https://evil.example?.amazonaws.com/`, which fetch() sends to evil.example.
 * Here a host wildcard only matches characters a parsed host can contain.
 * Patterns without a scheme or without a host wildcard pass through unchanged.
 */
function wildcardHostMatches(url: string, pattern: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(pattern);
  if (!m?.[2].includes('*')) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = m[1].toLowerCase();
  if (parsed.protocol !== `${scheme}:`) return false;

  // `parsed.host` omits a default port, so drop one written into the pattern.
  const defaultPort = scheme === 'https' ? ':443' : scheme === 'http' ? ':80' : null;
  let authority = m[2].toLowerCase();
  if (defaultPort && authority.endsWith(defaultPort)) {
    authority = authority.slice(0, -defaultPort.length);
  }

  const hostRegex = new RegExp(
    '^' +
      authority.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '[a-z0-9_.:[\\]-]*') +
      '$',
  );
  return hostRegex.test(parsed.host);
}

// ── Normalization ───────────────────────────────────────────────────────────

/** C0 controls (TAB, CR, LF, NUL, …) and DEL. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Throws if `url` contains a C0 control character or DEL (see normalizeOutboundUrl). */
export function assertNoControlChars(url: string, shownUrl: string): void {
  if (CONTROL_CHARS.test(url)) {
    throw new Error(
      `Endpoint not allowed: ${JSON.stringify(shownUrl)}. The URL contains a control ` +
        'character (tab, carriage return, newline, …), which URL parsing removes before ' +
        'sending, so the request would not go where the allowlist checked.',
    );
  }
}

/**
 * Whether a URL's path contains a dot segment (`.` or `..`), counting the
 * forms a URL parser or an upstream treats the same way: `%2e` for `.`, and
 * `%2f`, `%5c`, or `\` for `/`.
 *
 * fetch() resolves `/calendar/v3/../../drive/v3/files` (and `%2e%2e`) to
 * `/drive/v3/files`. No API needs a dot segment, so one is refused on every
 * route even though the allowlist is also checked on the normalized URL. A
 * lone `%2F` (GitLab's `group%2Fproject`) is fine.
 *
 * Out of scope, deliberately: `..;` (a Java/Tomcat path-parameter trick) and
 * double-encoded `%252e%252e`. fetch() resolves neither, so the path sent is
 * the path matched; they only matter to an upstream that decodes twice or
 * strips `;` parameters before routing, which none of the APIs drawlatch
 * targets does. Refusing them would also refuse legitimate `%25` sequences.
 */
export function pathHasDotSegment(url: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*([^?#]*)/i.exec(url);
  const rawPath = m ? m[1] : (/^[^?#]*/.exec(url)?.[0] ?? '');
  const decoded = rawPath.replace(/%2e/gi, '.').replace(/%2f|%5c|\\/gi, '/');
  return decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * Check an outbound URL and return the exact string to send.
 *
 * Allowlist patterns are globs over the URL string, but fetch() sends what the
 * WHATWG parser makes of it. The two differ in ways an attacker can use:
 *
 *   - The parser deletes TAB, CR, and LF anywhere in the URL, so
 *     `/calendar/v3/.\t./.\t./drive/v3/files` is `/calendar/v3/../../drive…`
 *     once parsed, and `*` / `**` happily match the tab. Any C0 control or
 *     DEL is refused outright.
 *   - It resolves dot segments, including `%2e` forms. Refused, see
 *     pathHasDotSegment().
 *   - It lower-cases the host, drops a default port, and percent-encodes
 *     some characters. Harmless, but to keep "checked" and "sent" identical
 *     the allowlist is matched against the parsed `href`, and the `href` is
 *     what the caller must send.
 *
 * @param shownUrl the caller's own URL, for error messages (the resolved form
 *   can carry substituted secrets).
 * @throws Error when the URL contains control characters or dot segments,
 *   isn't an absolute URL, or its normalized form isn't allowlisted.
 */
export function normalizeOutboundUrl(url: string, patterns: string[], shownUrl: string): string {
  assertNoControlChars(url, shownUrl);
  if (pathHasDotSegment(url)) {
    throw new Error(
      `Endpoint not allowed: ${shownUrl}. The path contains a "." or ".." segment ` +
        '(possibly percent-encoded), which would be resolved before sending and could ' +
        'reach a path the allowlist does not cover. Send the normalized path instead.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Endpoint not allowed: ${shownUrl}. It is not a valid absolute URL.`);
  }
  // `host.` and `host` are the same host to DNS; send (and match) one form.
  if (parsed.hostname.endsWith('.')) parsed.hostname = parsed.hostname.slice(0, -1);
  if (!isEndpointAllowed(parsed.href, patterns)) {
    throw new Error(`Endpoint not allowed after resolution: ${shownUrl}`);
  }
  return parsed.href;
}
