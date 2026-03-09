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

const MAX_SERVE_SIZE = 100 * 1024 * 1024; // 100MB

filesRouter.get("/serve", (req, res) => {
  const filePath = req.query.path as string;

  if (!filePath || typeof filePath !== "string") {
    return res.status(400).json({ error: "Missing path query parameter" });
  }

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
});
