import { Router } from "express";
import { createReadStream, statSync } from "fs";
import { resolveSnapshot } from "../services/canvas-service.js";

export const canvasRouter = Router();

const CANVAS_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * GET /api/canvas/:canvasId/:version
 *
 * Serves a canvas snapshot with the appropriate Content-Type.
 * HTML snapshots are served as full pages (for iframe rendering).
 */
canvasRouter.get("/:canvasId/:version", (req, res) => {
  const { canvasId, version: versionStr } = req.params;

  // Validate canvas ID (strict alphanumeric to prevent path traversal)
  if (!canvasId || !CANVAS_ID_REGEX.test(canvasId)) {
    return res.status(400).json({ error: "Invalid canvas ID" });
  }

  // Validate version is a positive integer
  const version = parseInt(versionStr, 10);
  if (!Number.isFinite(version) || version < 1) {
    return res.status(400).json({ error: "Invalid version number" });
  }

  const result = resolveSnapshot(canvasId, version);
  if (result.error) {
    return res.status(404).json({ error: result.error });
  }

  const { filePath, mimeType } = result;
  const stat = statSync(filePath!);

  res.setHeader("Content-Type", mimeType!);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const stream = createReadStream(filePath!);
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read snapshot" });
    }
  });
});
