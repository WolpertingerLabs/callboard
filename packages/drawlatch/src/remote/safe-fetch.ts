/**
 * fetch() with redirects followed by hand, under a per-call policy.
 *
 * fetch()'s own `redirect: 'follow'` is unsafe for a request that carries
 * secrets. On a cross-origin hop it strips only `Authorization` and `Cookie`
 * (and `Proxy-Authorization`); every other header — `x-api-key`,
 * `Circle-Token`, `DD-API-KEY`, a caller header with a resolved `${SECRET}` —
 * goes to whatever host the `Location` names, and that host is never checked
 * against anything. An https → http hop goes out in cleartext.
 *
 * Here every hop is checked before it is sent:
 *
 *   - The target must parse, be http(s), and pass `isAllowed` (for proxied
 *     requests, the matched route's `allowedEndpoints`).
 *   - https → http is never followed, same host or not.
 *   - A cross-origin hop (scheme, host, or port differs from the previous
 *     URL) sends only `crossOriginHeaders`. Everything else is dropped. The
 *     one exception is a plain upgrade: same hostname, http on port 80 to
 *     https on port 443, which keeps its headers.
 *   - A cross-origin 307/308 is not followed when `bodyCarriesSecrets` is
 *     set, since it would resend the body as-is.
 *   - Method and body follow the fetch spec: 301/302 turn a POST into a GET,
 *     303 turns anything but GET/HEAD into a GET, and both drop the body and
 *     its content headers; 307/308 resend the method and body unchanged
 *     (bodies are typed to kinds that can be sent twice).
 *   - At most `maxRedirects` hops (default MAX_REDIRECTS).
 *
 * A hop that fails any of these is not an error: the 3xx itself is returned,
 * `Location` and all, and the caller decides what to do with it.
 */

/**
 * Default hop limit. Lower than fetch()'s 20: the APIs drawlatch proxies
 * redirect once or twice (a moved endpoint, a pre-signed download), and each
 * extra hop is another chance to end up somewhere unexpected.
 */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers describing the request body, dropped when a redirect drops the body. */
const BODY_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
  'content-length',
]);

export interface SafeFetchOptions {
  method: string;
  headers: Record<string, string>;
  /**
   * Only kinds fetch() can send twice, so a 307/308 can always resend it. A
   * stream would be consumed by the first send.
   */
  body?: string | FormData | Uint8Array<ArrayBuffer>;
  signal?: AbortSignal;
  /** Whether a redirect target may be requested at all. Checked on every hop. */
  isAllowed: (url: URL) => boolean;
  /** The only headers sent on and after a cross-origin hop. Default: none. */
  crossOriginHeaders?: Record<string, string>;
  /**
   * The body has secrets substituted into it. A 307/308 to another origin
   * would resend it there, so such a redirect is returned instead.
   */
  bodyCarriesSecrets?: boolean;
  /** Hop limit. 0 never follows: every 3xx comes straight back. */
  maxRedirects?: number;
  /** fetch() to use. Defaults to the global; injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  response: Response;
  /** URL of the request that produced `response`. */
  url: string;
  /** Number of redirects followed to get there. */
  redirects: number;
}

/** Whether two URLs share scheme, host, and port. */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin;
}

/**
 * Whether a hop from `from` to `to` may keep its headers: same origin, or the
 * same hostname upgraded from http on port 80 to https on port 443. `URL`
 * normalizes a default port to '', so explicit `:80` / `:443` count too. Any
 * other port change is cross-origin.
 */
export function keepsHeaders(from: URL, to: URL): boolean {
  if (isSameOrigin(from, to)) return true;
  return (
    from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    from.hostname === to.hostname &&
    from.port === '' &&
    to.port === ''
  );
}

/** An `isAllowed` policy for fixed, non-caller URLs: stay on the first URL's origin. */
export function sameOriginAs(url: string): (target: URL) => boolean {
  const origin = new URL(url);
  return (target) => isSameOrigin(origin, target);
}

/**
 * Where a redirect response may be followed to, or null when it must be
 * returned as-is: no or unparseable `Location`, a non-http(s) target, an
 * https → http downgrade, or a target `isAllowed` rejects.
 */
export function redirectTarget(
  location: string | null,
  current: URL,
  isAllowed: (url: URL) => boolean,
): URL | null {
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (current.protocol === 'https:' && target.protocol === 'http:') return null;
  return isAllowed(target) ? target : null;
}

export async function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  // An unparseable URL still goes to fetch(), which rejects it with its own
  // error — callers already handle (and scrub) that one.
  let current = URL.canParse(url) ? new URL(url) : null;
  let currentHref = url;
  let method = options.method;
  let headers = options.headers;
  let body = options.body;
  let redirects = 0;
  const doFetch = options.fetchImpl ?? fetch;

  for (;;) {
    const response = await doFetch(currentHref, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: options.signal,
    });

    if (!current || !REDIRECT_STATUSES.has(response.status) || redirects >= maxRedirects) {
      return { response, url: currentHref, redirects };
    }

    const target = redirectTarget(response.headers.get('location'), current, options.isAllowed);
    if (!target) return { response, url: currentHref, redirects };

    // Per fetch: 303 makes anything but GET/HEAD a GET; 301/302 do the same to POST.
    const upper = method.toUpperCase();
    const toGet =
      (response.status === 303 && upper !== 'GET' && upper !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && upper === 'POST');
    const sameSite = keepsHeaders(current, target);
    if (!toGet && !sameSite && options.bodyCarriesSecrets && body !== undefined) {
      return { response, url: currentHref, redirects };
    }
    let nextHeaders = sameSite ? headers : (options.crossOriginHeaders ?? {});
    if (toGet) {
      method = 'GET';
      body = undefined;
      nextHeaders = Object.fromEntries(
        Object.entries(nextHeaders).filter(([k]) => !BODY_HEADERS.has(k.toLowerCase())),
      );
    }

    // Free the connection; the redirect's own body is never read.
    await response.body?.cancel().catch(() => undefined);

    headers = nextHeaders;
    current = target;
    currentHref = target.href;
    redirects++;
  }
}
