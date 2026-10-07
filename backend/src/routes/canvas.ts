import { Router } from "express";
import { createReadStream, readFileSync, statSync } from "fs";
import { resolveSnapshot } from "../services/canvas-service.js";
import { SIZE_REPORTER_SCRIPT, injectBeforeBodyClose } from "../services/html-injection.js";
import { setSandboxedContentHeaders } from "../utils/served-content.js";

export const canvasRouter = Router();

const CANVAS_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * HTML canvases are agent-written pages that are meant to run their own
 * script (dashboards, charts) inside `<iframe sandbox="allow-scripts">`
 * (CanvasRenderer). This repeats exactly that sandbox at the response level,
 * so the page keeps an opaque origin — no cookie, no same-origin API access,
 * no reach into `window.opener` — even when it is opened directly as a
 * top-level page, which the iframe attribute alone does not cover.
 *
 * Deliberately not the artifact CSP's `default-src 'none'`: canvases have
 * always been able to load CDN libraries and remote images, and an opaque
 * origin is what keeps them away from the user's session.
 */
export const CANVAS_HTML_CSP = "sandbox allow-scripts";

/**
 * GET /api/canvas/:canvasId/:version
 *
 * Serves a canvas snapshot with the appropriate Content-Type.
 * HTML snapshots are served as full pages (for iframe rendering) with
 * a height-reporter script injected so the parent can auto-resize.
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

  // For HTML content, inject the height reporter script
  if (mimeType!.startsWith("text/html")) {
    // Inject before </body> if present, otherwise append
    const html = injectBeforeBodyClose(readFileSync(filePath!, "utf-8"), SIZE_REPORTER_SCRIPT);

    const buf = Buffer.from(html, "utf-8");
    res.setHeader("Content-Type", mimeType!);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Content-Disposition", "inline");
    setSandboxedContentHeaders(res, CANVAS_HTML_CSP);
    return res.send(buf);
  }

  // Non-HTML (SVG and raster images, shown via <img>): nothing may execute if opened directly
  const stat = statSync(filePath!);
  res.setHeader("Content-Type", mimeType!);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", "inline");
  setSandboxedContentHeaders(res);

  const stream = createReadStream(filePath!);
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read snapshot" });
    }
  });
});
