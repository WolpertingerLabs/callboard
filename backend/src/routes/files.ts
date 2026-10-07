import { Router, type Response } from "express";
import { existsSync, realpathSync, statSync, createReadStream } from "fs";
import path from "path";
import { setSandboxedContentHeaders } from "../utils/served-content.js";
import { BlockedDestinationError, fetchPublicUrl, type PublicFetchOptions } from "../utils/public-url-fetch.js";

const ALLOWED_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
};

const MAX_SERVE_SIZE = 100 * 1024 * 1024; // 100MB

/** Test seam for the URL proxy's address policy and resolver; production passes nothing. */
export type FilesRouterOptions = Pick<PublicFetchOptions, "isAllowedAddress" | "lookup">;

/**
 * Every response here is user, agent or external bytes on the app origin, so
 * all of them carry the sandboxing CSP: an SVG (or anything a browser might
 * render as a document) gets an opaque origin and runs nothing, however it is
 * opened.
 */
export function createFilesRouter(proxyOptions: FilesRouterOptions = {}) {
  const router = Router();

  // Serve a local file by absolute path, or proxy an http(s) URL
  router.get("/serve", (req, res) => {
    const filePath = req.query.path as string | undefined;
    const urlParam = req.query.url as string | undefined;

    if (urlParam) {
      return serveUrl(urlParam, res, proxyOptions);
    }

    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "Missing path or url query parameter" });
    }

    return serveLocalFile(filePath, res);
  });

  return router;
}

export const filesRouter = createFilesRouter();

function serveLocalFile(filePath: string, res: Response) {
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

  // Check it's a regular file
  const stat = statSync(realPath);
  if (!stat.isFile()) {
    return res.status(400).json({ error: "Not a regular file" });
  }

  if (stat.size > MAX_SERVE_SIZE) {
    return res.status(413).json({ error: "File too large" });
  }

  // MIME allowlist
  const ext = path.extname(realPath).toLowerCase();
  const mimeType = ALLOWED_MIME[ext];
  if (!mimeType) {
    return res.status(415).json({ error: "Unsupported file type" });
  }

  // Set headers and stream
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", "inline");
  setSandboxedContentHeaders(res);

  const stream = createReadStream(realPath);
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read file" });
    }
  });
}

/**
 * Proxy an external media URL. The served type is always the one the URL's
 * extension implies — never the upstream's Content-Type, which the upstream
 * controls (a ".pdf" answering `image/svg+xml` would otherwise be served as a
 * script-capable document). Destinations are restricted to public addresses
 * on every hop; see {@link fetchPublicUrl}.
 */
async function serveUrl(url: string, res: Response, proxyOptions: FilesRouterOptions) {
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
  const ext = path.extname(parsed.pathname).toLowerCase();
  const mimeType = ALLOWED_MIME[ext];
  if (!mimeType) {
    return res.status(415).json({ error: "Unsupported file type" });
  }

  try {
    const upstream = await fetchPublicUrl(parsed.href, {
      ...proxyOptions,
      headers: {
        "User-Agent": "Callboard/1.0 (media proxy)",
        Accept: mimeType + ", */*",
      },
      signal: AbortSignal.timeout(30_000),
    });

    const status = upstream.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      upstream.resume();
      return res.status(502).json({ error: `Upstream returned ${status}` });
    }

    const contentLength = upstream.headers["content-length"];

    // Check size if known
    if (contentLength && parseInt(contentLength) > MAX_SERVE_SIZE) {
      upstream.destroy();
      return res.status(413).json({ error: "File too large" });
    }

    res.setHeader("Content-Type", mimeType);
    if (contentLength && /^\d+$/.test(contentLength)) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Content-Disposition", "inline");
    setSandboxedContentHeaders(res);

    // A client that goes away mid-stream releases the upstream socket now, not at the timeout.
    res.once("close", () => upstream.destroy());

    let totalBytes = 0;
    for await (const chunk of upstream as AsyncIterable<Buffer>) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_SERVE_SIZE) {
        upstream.destroy();
        res.destroy();
        return;
      }
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err: any) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof BlockedDestinationError) {
      return res.status(403).json({ error: err.message });
    }
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return res.status(504).json({ error: "Upstream request timed out" });
    }
    return res.status(502).json({ error: `Failed to fetch URL: ${err.message}` });
  }
}
