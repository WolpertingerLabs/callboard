import { Router, type Request, type Response } from "express";
import { existsSync, realpathSync, statSync } from "fs";
import path from "path";
import { setSandboxedContentHeaders } from "../utils/served-content.js";
import { BlockedDestinationError, fetchPublicUrl, type PublicFetchOptions } from "../utils/public-url-fetch.js";
import { mediaTypeForPath } from "../utils/media-types.js";
import { formatByteRange, parseRangeHeader, upstreamRangeFor, validateUpstreamContentRange } from "../utils/http-range.js";
import { createLogger } from "../utils/logger.js";
import { DATA_DIR } from "../utils/paths.js";
import { deliverablePathForChat } from "../services/sandbox-deliverables.js";

const log = createLogger("files");

/**
 * Per-response cap on proxied bodies: a full 200, or each relayed 206. Every
 * proxied byte is daemon bandwidth on a fetch the agent chose. Local files
 * have no cap — they stream with backpressure, and Range means a large file
 * costs only the bytes the browser asks for.
 */
export const MAX_PROXY_BYTES = 100 * 1024 * 1024; // 100MB

/** How long a proxied response may make no socket progress before it is dropped. */
export const PROXY_IDLE_TIMEOUT_MS = 60_000;

/**
 * How long the proxy waits for upstream response headers: connect, every
 * redirect hop, and the final hop's headers. Cleared once they arrive; the
 * body is then bounded by {@link PROXY_IDLE_TIMEOUT_MS} instead, so a large
 * window from a slow-but-live upstream is not cut off mid-stream.
 */
export const PROXY_HEADERS_TIMEOUT_MS = 30_000;

const UPSTREAM_UNSATISFIED_RANGE = /^bytes \*\/\d+$/;
/** Validators relayed from upstream only in these shapes: a quoted (optionally weak) ETag, and an IMF-fixdate. */
const SAFE_ETAG = /^(W\/)?"[\x21\x23-\x7e]{0,200}"$/;
const SAFE_HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Served bytes may be rewritten in place (an agent regenerating a chart) and
 * are private to this user: revalidate on every use (ETag/Last-Modified make
 * that a cheap 304 locally) and never store in a shared cache. Without an
 * explicit header the validators alone invite heuristic freshness.
 */
const SERVED_CACHE_CONTROL = "private, no-cache";

/** Test seam for the URL proxy's address policy and resolver; production passes nothing. */
export type FilesRouterOptions = Pick<PublicFetchOptions, "isAllowedAddress" | "lookup"> & {
  /** Overrides {@link MAX_PROXY_BYTES}, for tests. */
  maxProxyBytes?: number;
  /** Overrides {@link PROXY_IDLE_TIMEOUT_MS}, for tests. */
  proxyIdleTimeoutMs?: number;
  /** Overrides {@link PROXY_HEADERS_TIMEOUT_MS}, for tests. */
  proxyHeadersTimeoutMs?: number;
  /** Called when a proxy request's handler has fully finished, for tests. */
  onProxySettled?: () => void;
  /** The data directory whose Sandbox desktop deliverables are chat-scoped (default `DATA_DIR`), for tests. */
  dataDir?: string;
};

/**
 * Every response here is user, agent or external bytes on the app origin, so
 * all of them carry the sandboxing CSP: an SVG (or anything a browser might
 * render as a document) gets an opaque origin and runs nothing, however it is
 * opened.
 */
/** Headers that describe a media body; stripped before answering with a JSON error instead. */
const MEDIA_BODY_HEADERS = ["ETag", "Last-Modified", "Content-Range", "Accept-Ranges", "Content-Disposition"];

/**
 * A JSON error after media headers may already be set (by us or by `send`).
 * `res.json` keeps an existing Content-Type, so without this a late error
 * would go out as e.g. `video/mp4` with a stale Content-Range/ETag.
 */
function lateJsonError(res: Response, status: number, error: string) {
  for (const name of MEDIA_BODY_HEADERS) res.removeHeader(name);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json({ error });
}

export function createFilesRouter(proxyOptions: FilesRouterOptions = {}) {
  const router = Router();

  // Serve a local file by absolute path, or proxy an http(s) URL
  router.get("/serve", (req, res) => {
    // First, so every response — including the early 400/403/404/413/415/502/504
    // JSON errors — carries nosniff, the sandbox CSP and the cache policy.
    setSandboxedContentHeaders(res);
    res.setHeader("Cache-Control", SERVED_CACHE_CONTROL);

    const filePath = req.query.path as string | undefined;
    const urlParam = req.query.url as string | undefined;
    const download = req.query.download === "1";

    // Phase 1 never proxies arbitrary downloads: a URL must be typed media.
    if (download && urlParam !== undefined) {
      return res.status(400).json({ error: "download is only supported for local paths" });
    }

    if (urlParam) {
      return serveUrl(urlParam, req, res, proxyOptions).finally(() => proxyOptions.onProxySettled?.());
    }

    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "Missing path or url query parameter" });
    }

    const chat = typeof req.query.chat === "string" ? req.query.chat : undefined;
    return serveLocalFile(filePath, req, res, download, { dataDir: proxyOptions.dataDir ?? DATA_DIR, chat });
  });

  return router;
}

export const filesRouter = createFilesRouter();

/**
 * `Content-Disposition: attachment` for `name`: an ASCII `filename` fallback
 * with quotes, backslashes and control characters removed (and `%` and any
 * other non-ASCII replaced by `_`), plus the exact name as RFC 5987 `filename*`.
 */
export function attachmentDisposition(name: string): string {
  const ascii =
    name
      // eslint-disable-next-line no-control-regex
      .replace(/["\\\x00-\x1f\x7f]/g, "")
      // `%` too: some browsers percent-decode the plain `filename`.
      .replace(/[^\x20-\x7e]|%/g, "_")
      .trim() || "download";
  // encodeURIComponent leaves ' ( ) * ! — not attr-chars in RFC 5987.
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Serve a local file by absolute path. Inline, only types in the media table
 * are served, typed from it. With `download`, any regular file is served —
 * but always as `application/octet-stream` + `attachment`, so its bytes are
 * never interpreted on the app origin (and the sandbox CSP covers a browser
 * that ignores `attachment`).
 */
function serveLocalFile(filePath: string, req: Request, res: Response, download = false, scope: { dataDir: string; chat?: string } = { dataDir: DATA_DIR }) {
  // Validate absolute path, no null bytes
  if (!path.isAbsolute(filePath)) {
    return res.status(400).json({ error: "Path must be absolute" });
  }
  if (filePath.includes("\0")) {
    return res.status(400).json({ error: "Invalid path" });
  }

  // Resolve to collapse traversal sequences
  const resolved = path.resolve(filePath);

  if (!existsSync(resolved)) {
    return res.status(404).json({ error: "File not found" });
  }

  // Resolve symlinks to prevent symlink-based traversal
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return res.status(404).json({ error: "File not found" });
  }

  // Sandbox desktop deliverables are a chat's own: served only with `chat=`
  // naming the chat they were delivered to, so one chat's card can never
  // show another chat's (or another workspace's) files. A 404 either way,
  // which says nothing about whether the file exists.
  if (deliverablePathForChat(scope.dataDir, realPath, scope.chat) === "refused") {
    return res.status(404).json({ error: "File not found" });
  }

  // Check it's a regular file
  const stat = statSync(realPath);
  if (!stat.isFile()) {
    return res.status(400).json({ error: "Not a regular file" });
  }

  // Our headers go on first. `send` leaves an existing Content-Type alone, and
  // with a callback it reports errors to us instead of clearing headers, so
  // every status below (200, 206, 304, 416, HEAD) keeps our type, the cache
  // policy and the sandbox headers — downloads included.
  if (download) {
    res.setHeader("Content-Type", "application/octet-stream");
    // The requested name, not a symlink target's: the saved file matches the card.
    res.setHeader("Content-Disposition", attachmentDisposition(path.basename(resolved)));
  } else {
    // MIME allowlist
    const info = mediaTypeForPath(realPath);
    if (!info) {
      return res.status(415).json({ error: "Unsupported file type" });
    }
    res.setHeader("Content-Type", info.mime);
    res.setHeader("Content-Disposition", "inline");
  }
  // Cache-Control, nosniff and the CSP are already set at the top of /serve.
  setSandboxedContentHeaders(res);

  // RFC 9110: a syntactically invalid Range is ignored. `send` would answer
  // 416 to some (`bytes=x`), so drop those and let it serve the full body.
  const range = req.headers.range;
  if (range !== undefined && parseRangeHeader(range).kind === "invalid") {
    delete req.headers.range;
  }

  res.sendFile(
    realPath,
    {
      // The default ("ignore") 404s anything under a dot-directory, e.g. ~/.cache/x.mp4.
      dotfiles: "allow",
      acceptRanges: true,
      cacheControl: false, // ours (SERVED_CACHE_CONTROL) is already set
      lastModified: true,
      etag: true,
    },
    (err?: Error & { status?: number; statusCode?: number; code?: string }) => {
      if (!err) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err.status ?? err.statusCode;
      // 416 (send has set `Content-Range: bytes */size`) and 412: no body, nothing reflected.
      if (status === 416 || status === 412) {
        res.status(status).end();
        return;
      }
      if (status === 404 || err.code === "ENOENT") {
        lateJsonError(res, 404, "File not found");
        return;
      }
      lateJsonError(res, 500, "Failed to read file");
    },
  );
}

/**
 * Proxy an external media URL. The served type is always the one the URL's
 * extension implies — never the upstream's Content-Type, which the upstream
 * controls (a ".pdf" answering `image/svg+xml` would otherwise be served as a
 * script-capable document). Destinations are restricted to public addresses
 * on every hop; see {@link fetchPublicUrl}.
 */
async function serveUrl(url: string, req: Request, res: Response, proxyOptions: FilesRouterOptions) {
  const {
    maxProxyBytes = MAX_PROXY_BYTES,
    proxyIdleTimeoutMs = PROXY_IDLE_TIMEOUT_MS,
    proxyHeadersTimeoutMs = PROXY_HEADERS_TIMEOUT_MS,
    onProxySettled: _onSettled,
    ...fetchOptions
  } = proxyOptions;

  // Validate URL format and protocol
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "URL must use http or https" });
  }

  // The extension decides the served type
  const mimeType = mediaTypeForPath(parsed.pathname)?.mime;
  if (!mimeType) {
    return res.status(415).json({ error: "Unsupported file type" });
  }

  // Forward one range, re-serialised from integers; never the client's string.
  // Multi-range, invalid, or a suffix longer than the cap → no Range upstream.
  const clientRange = req.headers.range === undefined ? undefined : parseRangeHeader(req.headers.range);
  const requested = clientRange?.kind === "single" ? upstreamRangeFor(clientRange.range, maxProxyBytes) : undefined;

  // Bounds connect + headers across every hop (fetchPublicUrl resolves only
  // with the final hop's response), then is cleared; a client that leaves
  // while we wait aborts the fetch too.
  const headersAbort = new AbortController();
  const headersTimer = setTimeout(() => headersAbort.abort(new DOMException("Upstream headers timed out", "TimeoutError")), proxyHeadersTimeoutMs);
  const abortOnClientClose = () => headersAbort.abort();
  res.once("close", abortOnClientClose);

  try {
    const upstream = await fetchPublicUrl(parsed.href, {
      ...fetchOptions,
      headers: {
        "User-Agent": "Callboard/1.0 (media proxy)",
        Accept: mimeType + ", */*",
        ...(requested && { Range: formatByteRange(requested) }),
      },
      signal: headersAbort.signal,
    }).finally(() => {
      clearTimeout(headersTimer);
      res.off("close", abortOnClientClose);
    });

    const status = upstream.statusCode ?? 0;

    // Our type and sandbox headers go on every relayed response, error or not.
    const setServedHeaders = () => {
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", SERVED_CACHE_CONTROL);
      setSandboxedContentHeaders(res);
    };

    // Responses whose body we do not relay are destroyed, not drained: a
    // hostile upstream could otherwise stream forever until the abort timer.
    // (Each hop uses its own socket, so there is no connection to keep.)
    if (status === 416 && requested) {
      const contentRange = upstream.headers["content-range"];
      upstream.destroy();
      setServedHeaders();
      if (contentRange && UPSTREAM_UNSATISFIED_RANGE.test(contentRange)) {
        res.setHeader("Content-Range", contentRange);
      }
      return res.status(416).end();
    }

    // Only relay a 206 we asked for, with a Content-Range consistent with that request.
    const partial = status === 206;
    const contentLength = upstream.headers["content-length"];
    let contentRange: string | undefined;
    if (partial) {
      contentRange = requested && validateUpstreamContentRange(upstream.headers["content-range"], contentLength, requested);
      if (!contentRange) {
        upstream.destroy();
        log.warn(`media proxy: invalid partial response from ${parsed.host} (Content-Range ${JSON.stringify(upstream.headers["content-range"])})`);
        return res.status(502).json({ error: "Failed to fetch URL" });
      }
    }

    if (status < 200 || status >= 300) {
      upstream.destroy();
      log.warn(`media proxy: upstream ${parsed.host} returned ${status}`);
      return res.status(502).json({ error: "Failed to fetch URL" });
    }

    // Check size if known
    if (contentLength && parseInt(contentLength) > maxProxyBytes) {
      upstream.destroy();
      return res.status(413).json({ error: "File too large" });
    }

    setServedHeaders();
    if (contentLength && /^\d+$/.test(contentLength)) {
      res.setHeader("Content-Length", contentLength);
    }
    const etag = upstream.headers.etag;
    if (etag && SAFE_ETAG.test(etag)) res.setHeader("ETag", etag);
    const lastModified = upstream.headers["last-modified"];
    if (lastModified && SAFE_HTTP_DATE.test(lastModified)) res.setHeader("Last-Modified", lastModified);
    if (contentRange) {
      // Upstream ignoring the range (a 200) gets no Accept-Ranges: the browser
      // then treats the stream as unseekable, which is the honest answer.
      res.status(206);
      res.setHeader("Content-Range", contentRange);
      res.setHeader("Accept-Ranges", "bytes");
    }

    // A client that goes away mid-stream releases the upstream socket now, not at the timeout.
    res.once("close", () => upstream.destroy());

    if (req.method === "HEAD") {
      upstream.destroy();
      res.end();
      return;
    }

    // A response that makes no progress for the idle window (an upstream that
    // stalled, or a client that stopped reading so we never drain) is dropped
    // rather than held open forever. Our own timer, re-armed on every chunk
    // relayed, so the socket's keep-alive timeout is left alone.
    let idle: NodeJS.Timeout | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => res.destroy(), proxyIdleTimeoutMs);
    };
    touch();
    res.once("close", () => clearTimeout(idle));

    let totalBytes = 0;
    for await (const chunk of upstream as AsyncIterable<Buffer>) {
      totalBytes += chunk.length;
      if (totalBytes > maxProxyBytes) {
        upstream.destroy();
        res.destroy();
        return;
      }
      if (!res.write(chunk)) {
        // Also settle on close: a client gone mid-write never drains.
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.on("drain", done);
          res.on("close", done);
        });
        if (res.destroyed) return;
      }
      touch();
    }
    clearTimeout(idle);
    res.end();
  } catch (err: any) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Details stay in the server log; the client gets a generic message.
    if (err instanceof BlockedDestinationError) {
      log.warn(`media proxy: refused ${parsed.host}: ${err.message}`);
      return lateJsonError(res, 403, "Destination not allowed");
    }
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return lateJsonError(res, 504, "Upstream request timed out");
    }
    log.warn(`media proxy: fetch from ${parsed.host} failed: ${err.message}`);
    return lateJsonError(res, 502, "Failed to fetch URL");
  }
}
