import { Router } from "express";
import type { Request, Response } from "express";
import type { ArtifactContentType } from "shared/types/index.js";
import { deleteArtifact, getArtifact, listArtifacts, readArtifactVersion, saveArtifact, updateArtifact } from "../services/artifact-service.js";
import { ARTIFACT_BRIDGE_SHIM_SCRIPT } from "../services/artifact-bridge-shim.js";
import { SIZE_REPORTER_SCRIPT, injectBeforeBodyClose } from "../services/html-injection.js";
import { StorageError } from "../services/storage-service.js";
import { sendStorageError } from "./storage.js";

export const artifactsRouter = Router();

/**
 * CSP for a rendered HTML artifact: inline script and style only, images and
 * media only from data:/blob:, and **no network at all** — every byte of data
 * reaches the artifact through the storage bridge.
 *
 * The trailing `sandbox allow-scripts` repeats the iframe's own sandbox at the
 * response level, so the document keeps an opaque origin even when it is
 * opened directly as a top-level page (a link, "open frame in new tab") rather
 * than inside the renderer's sandboxed iframe — otherwise it would run
 * same-origin with the user's session and could reach `window.opener`.
 */
export const ARTIFACT_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; sandbox allow-scripts";

/** SVG renders are for `<img>` (scripts inert); if opened directly, still no script and an opaque origin. */
export const ARTIFACT_SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox";

/** Raw source and markdown are text; nothing in them may ever execute. */
export const ARTIFACT_TEXT_CSP = "default-src 'none'; sandbox";

type Handler = (req: Request, res: Response) => unknown;
const wrap =
  (what: string, fn: Handler) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      sendStorageError(res, err, what);
    }
  };

function parseVersion(raw: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) throw new StorageError("invalid", "Invalid version number");
  return Number(raw);
}

/**
 * Insert the bridge shim as early as the document allows — after `<head …>`,
 * else after `<html …>`, else after the doctype, else at the very start — so
 * `window.callboard` exists before any of the artifact's own scripts run.
 */
export function injectBridgeShim(html: string): string {
  for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + ARTIFACT_BRIDGE_SHIM_SCRIPT + html.slice(m.index + m[0].length);
  }
  return ARTIFACT_BRIDGE_SHIM_SCRIPT + html;
}

/** The served document for an HTML artifact: bridge shim early, size reporter before `</body>`. */
export function renderArtifactHtml(source: string): string {
  return injectBeforeBodyClose(injectBridgeShim(source), SIZE_REPORTER_SCRIPT);
}

function sendText(res: Response, body: string, contentType: string, csp: string): void {
  const buf = Buffer.from(body, "utf-8");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", buf.length);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
}

/**
 * GET /api/artifacts
 */
artifactsRouter.get(
  "/",
  wrap("List artifacts", (_req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'List artifacts'
    res.json({ artifacts: listArtifacts() });
  }),
);

/**
 * POST /api/artifacts  { id, name, description?, contentType, storageAccess?, content, note? }
 */
artifactsRouter.post(
  "/",
  wrap("Create artifact", async (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Create an artifact (version 1)'
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await saveArtifact(
      {
        id: b.id as string,
        name: b.name as string | undefined,
        description: b.description as string | undefined,
        contentType: b.contentType as ArtifactContentType | undefined,
        storageAccess: b.storageAccess as never,
        content: b.content as string,
        note: b.note as string | undefined,
      },
      "create",
    );
    res.status(201).json({ artifact: result.artifact, version: result.version });
  }),
);

/**
 * GET /api/artifacts/:id
 */
artifactsRouter.get(
  "/:id",
  wrap("Get artifact", (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Get an artifact with its versions'
    res.json({ artifact: getArtifact(req.params.id) });
  }),
);

/**
 * PATCH /api/artifacts/:id  { name?, description?, storageAccess? }
 */
artifactsRouter.patch(
  "/:id",
  wrap("Update artifact", async (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Update artifact metadata'
    const b = (req.body ?? {}) as Record<string, unknown>;
    res.json({
      artifact: await updateArtifact(req.params.id, { name: b.name as never, description: b.description as never, storageAccess: b.storageAccess as never }),
    });
  }),
);

/**
 * DELETE /api/artifacts/:id
 */
artifactsRouter.delete(
  "/:id",
  wrap("Delete artifact", async (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Delete an artifact and all its versions'
    await deleteArtifact(req.params.id);
    res.json({ success: true });
  }),
);

/**
 * POST /api/artifacts/:id/versions  { content, note? }
 */
artifactsRouter.post(
  "/:id/versions",
  wrap("Save artifact version", async (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Save a new artifact version'
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await saveArtifact({ id: req.params.id, content: b.content as string, note: b.note as string | undefined }, "append");
    res.status(201).json({ artifact: result.artifact, version: result.version });
  }),
);

/**
 * GET /api/artifacts/:id/versions/:n — raw source, as text.
 */
artifactsRouter.get(
  "/:id/versions/:n",
  wrap("Read artifact source", (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Raw source of one artifact version (text/plain)'
    const { content } = readArtifactVersion(req.params.id, parseVersion(req.params.n));
    sendText(res, content, "text/plain; charset=utf-8", ARTIFACT_TEXT_CSP);
  }),
);

/**
 * GET /api/artifacts/:id/versions/:n/render — the served document.
 *
 * html → the page with the bridge shim and size reporter injected, under a
 * no-network CSP; svg → image/svg+xml (the host uses <img>); markdown →
 * text/plain (the host renders it; it never executes).
 */
artifactsRouter.get(
  "/:id/versions/:n/render",
  wrap("Render artifact", (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Render one artifact version for the sandboxed renderer'
    const { artifact, content } = readArtifactVersion(req.params.id, parseVersion(req.params.n));
    if (artifact.contentType === "html") {
      sendText(res, renderArtifactHtml(content), "text/html; charset=utf-8", ARTIFACT_HTML_CSP);
    } else if (artifact.contentType === "svg") {
      sendText(res, content, "image/svg+xml", ARTIFACT_SVG_CSP);
    } else {
      sendText(res, content, "text/plain; charset=utf-8", ARTIFACT_TEXT_CSP);
    }
  }),
);
