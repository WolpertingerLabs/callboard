import { Router } from "express";
import { existsSync, realpathSync, statSync, createReadStream } from "fs";
import path from "path";

export const filesRouter = Router();

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

const ALLOWED_CONTENT_TYPES = new Set(Object.values(ALLOWED_MIME));

const MAX_SERVE_SIZE = 100 * 1024 * 1024; // 100MB

// Serve a local file by absolute path
filesRouter.get("/serve", (req, res) => {
  const filePath = req.query.path as string | undefined;
  const urlParam = req.query.url as string | undefined;

  if (urlParam) {
    return serveUrl(urlParam, res);
  }

  if (!filePath || typeof filePath !== "string") {
    return res.status(400).json({ error: "Missing path or url query parameter" });
  }

  return serveLocalFile(filePath, res);
});

function serveLocalFile(filePath: string, res: any) {
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
  res.setHeader("X-Content-Type-Options", "nosniff");

  const stream = createReadStream(realPath);
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read file" });
    }
  });
}

async function serveUrl(url: string, res: any) {
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

  // Validate extension from URL path
  const ext = path.extname(parsed.pathname).toLowerCase();
  const expectedMime = ALLOWED_MIME[ext];
  if (!expectedMime) {
    return res.status(415).json({ error: "Unsupported file type" });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Callboard/1.0 (media proxy)",
        Accept: expectedMime + ", */*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
    }

    // Validate content-type from upstream
    const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim() || "";
    if (!ALLOWED_CONTENT_TYPES.has(contentType) && contentType !== expectedMime) {
      // Fall back to extension-based MIME if upstream doesn't match
      // (some servers return generic types like application/octet-stream)
    }

    const contentLength = upstream.headers.get("content-length");

    // Check size if known
    if (contentLength && parseInt(contentLength) > MAX_SERVE_SIZE) {
      return res.status(413).json({ error: "File too large" });
    }

    // Use upstream content-type if it's in our allowlist, otherwise use extension-based
    const serveMime = ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : expectedMime;

    res.setHeader("Content-Type", serveMime);
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Stream the response body
    if (!upstream.body) {
      return res.status(502).json({ error: "No response body from upstream" });
    }

    const reader = upstream.body.getReader();
    let totalBytes = 0;

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        totalBytes += value.length;
        if (totalBytes > MAX_SERVE_SIZE) {
          reader.cancel();
          if (!res.headersSent) {
            res.status(413).json({ error: "File too large" });
          } else {
            res.destroy();
          }
          return;
        }
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    };

    await pump();
  } catch (err: any) {
    if (!res.headersSent) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        return res.status(504).json({ error: "Upstream request timed out" });
      }
      return res.status(502).json({ error: `Failed to fetch URL: ${err.message}` });
    }
  }
}
