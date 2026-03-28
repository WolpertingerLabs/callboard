import { Router } from "express";
import { createReadStream, readFileSync, statSync } from "fs";
import { resolveSnapshot } from "../services/canvas-service.js";

export const canvasRouter = Router();

const CANVAS_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Small script injected before </body> in HTML canvases.
 * Reports document dimensions to the parent via postMessage so the
 * iframe can auto-resize and scale to fit. Works even with
 * sandbox="allow-scripts" (no allow-same-origin needed).
 * Uses ResizeObserver to track dynamic changes.
 */
const SIZE_REPORTER_SCRIPT = `<script>
(function(){
  function send(){
    var h = document.documentElement.scrollHeight;
    var w = document.documentElement.scrollWidth;
    window.parent.postMessage({type:"canvas-resize",height:h,width:w},"*");
  }
  if(typeof ResizeObserver!=="undefined"){
    new ResizeObserver(send).observe(document.documentElement);
  }
  window.addEventListener("load",send);
  send();
})();
</script>`;

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
    let html = readFileSync(filePath!, "utf-8");

    // Inject before </body> if present, otherwise append
    if (html.includes("</body>")) {
      html = html.replace("</body>", SIZE_REPORTER_SCRIPT + "</body>");
    } else {
      html += SIZE_REPORTER_SCRIPT;
    }

    const buf = Buffer.from(html, "utf-8");
    res.setHeader("Content-Type", mimeType!);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(buf);
  }

  // Non-HTML: stream as before
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
