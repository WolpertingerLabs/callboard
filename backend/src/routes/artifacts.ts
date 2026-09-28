import { createHash } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { ARTIFACT_BRIDGE_TOKEN_PATTERN, ARTIFACT_RENDER_SHA256_PATTERN } from "shared/types/index.js";
import type { ArtifactContentType } from "shared/types/index.js";
import { deleteArtifact, getArtifact, listArtifacts, readArtifactVersion, saveArtifact, updateArtifact } from "../services/artifact-service.js";
import { artifactBridgeShimScript } from "../services/artifact-bridge-shim.js";
import { SIZE_REPORTER_SCRIPT, injectBeforeBodyClose } from "../services/html-injection.js";
import { StorageError, httpStatusFor } from "../services/storage-service.js";
import { sendStorageError } from "./storage.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("artifacts-route");

export const artifactsRouter = Router();

/**
 * CSP for a rendered HTML artifact: inline script and style only, images and
 * media only from data:/blob:, and no fetch/XHR/WebSocket or remote
 * subresource of any kind — every byte of data reaches the artifact through
 * the storage bridge.
 *
 * That is not "no egress": CSP does not govern WebRTC (ICE/STUN packets leave
 * regardless) or the frame navigating itself to a URL carrying data. So an
 * artifact can leak whatever it can *read* — granting it read on a key means
 * its author can read that key. What it cannot do is reach the user's session:
 * see below.
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

/**
 * The render route's own error page (see {@link sendRenderError}): static
 * markup and inline style, no script of any kind, opaque origin.
 */
export const ARTIFACT_ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-src 'none'; sandbox";

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
export function injectBridgeShim(html: string, token: string | null): string {
  const shim = artifactBridgeShimScript(token);
  for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + shim + html.slice(m.index + m[0].length);
  }
  return shim + html;
}

/**
 * The served document for an HTML artifact: bridge shim (bound to `token`)
 * early, size reporter before `</body>`. `token: null` serves an unbound shim.
 */
export function renderArtifactHtml(source: string, token: string | null): string {
  return injectBeforeBodyClose(injectBridgeShim(source, token), SIZE_REPORTER_SCRIPT);
}

/**
 * The `?bridge=` token of a render request: absent ⇒ null (an unbound shim);
 * present ⇒ must be exactly one {@link ARTIFACT_BRIDGE_TOKEN_PATTERN} string.
 */
function parseBridgeToken(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !ARTIFACT_BRIDGE_TOKEN_PATTERN.test(raw)) throw new StorageError("invalid", "Invalid bridge token");
  return raw;
}

/**
 * The `?sha256=` pin (ARTIFACT_RENDER_SHA256_PATTERN): absent ⇒ null; present
 * ⇒ exactly one 64-hex string.
 */
function parseRenderPin(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !ARTIFACT_RENDER_SHA256_PATTERN.test(raw)) throw new StorageError("invalid", "Invalid render pin");
  return raw;
}

/** A pinned read (non-null `pin`) of bytes that no longer hash to the pin is a 409. */
function assertPinned(id: string, version: number, content: string, pin: string | null): void {
  if (pin !== null && createHash("sha256").update(content, "utf-8").digest("hex") !== pin) {
    throw new StorageError(
      "conflict",
      `Version ${version} of "${id}" has changed since it was checked (the artifact was deleted and recreated), so it is not run here. Render the artifact again.`,
    );
  }
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * A render failure as a tiny self-contained HTML page rather than JSON: the
 * render route is loaded into the artifact frame, so this is what the user
 * sees in place of the artifact. No shim, no script, no token — nothing in it
 * can bind the bridge — under {@link ARTIFACT_ERROR_CSP}.
 */
export function renderErrorDocument(message: string): string {
  const text = message.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Artifact unavailable</title>' +
    "<style>body{margin:0;padding:16px;font:13px/1.5 system-ui,sans-serif}</style></head>" +
    `<body><p><strong>This artifact could not be shown.</strong></p><p>${text}</p></body></html>`
  );
}

function sendRenderError(res: Response, err: unknown): void {
  let status = 500;
  let message = "Rendering the artifact failed.";
  if (err instanceof StorageError) {
    status = httpStatusFor(err.code);
    message = err.message;
  } else {
    log.error(`Render artifact failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  res.status(status);
  sendText(res, renderErrorDocument(message), "text/html; charset=utf-8", ARTIFACT_ERROR_CSP);
}

function sendText(res: Response, body: string, contentType: string, csp: string): void {
  const buf = Buffer.from(body, "utf-8");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", buf.length);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Cache-Control", "no-store");
  // A render URL can carry a bridge token; never hand it on as a Referer.
  res.setHeader("Referrer-Policy", "no-referrer");
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
 * GET /api/artifacts/:id/versions/:n — raw source, as text. `?sha256=` pins
 * the bytes as on the render route (409 when they differ): the chat's markdown
 * renderer reads through here.
 */
artifactsRouter.get(
  "/:id/versions/:n",
  wrap("Read artifact source", (req, res) => {
    // #swagger.tags = ['Artifacts']
    // #swagger.summary = 'Raw source of one artifact version (text/plain)'
    const version = parseVersion(req.params.n);
    const pin = parseRenderPin(req.query.sha256);
    const { artifact, content } = readArtifactVersion(req.params.id, version);
    assertPinned(artifact.id, version, content, pin);
    sendText(res, content, "text/plain; charset=utf-8", ARTIFACT_TEXT_CSP);
  }),
);

/**
 * GET /api/artifacts/:id/versions/:n/render — the served document.
 *
 * html → the page with the bridge shim (bound to `?bridge=<token>`, see
 * shared/types/artifact.ts) and size reporter injected, under
 * {@link ARTIFACT_HTML_CSP}; the response is no-store, so a token is only
 * ever in the one document the host asked for. svg → image/svg+xml (the host uses <img>); markdown →
 * text/plain (the host renders it; it never executes).
 *
 * `?sha256=` pins the bytes: the host checked the artifact before mounting,
 * but between that check and this GET the artifact can be deleted and
 * recreated (versions restart at 1), so the version number alone would serve
 * different code under the grant that check produced. The sha256 of the bytes
 * about to be served must equal the pin, or the response is a 409. A bridge
 * token without a pin is refused the same way — every bound render is pinned.
 *
 * Every failure here is an HTML error page (never JSON): this response is what
 * the artifact frame shows.
 */
artifactsRouter.get("/:id/versions/:n/render", (req, res) => {
  // #swagger.tags = ['Artifacts']
  // #swagger.summary = 'Render one artifact version for the sandboxed renderer'
  try {
    const version = parseVersion(req.params.n);
    const token = parseBridgeToken(req.query.bridge);
    const pin = parseRenderPin(req.query.sha256);
    if (token !== null && pin === null) {
      throw new StorageError("conflict", "This render is not pinned to a version sha256, so it is not run. Render the artifact again.");
    }
    const { artifact, content } = readArtifactVersion(req.params.id, version);
    assertPinned(artifact.id, version, content, pin);
    if (artifact.contentType === "html") {
      sendText(res, renderArtifactHtml(content, token), "text/html; charset=utf-8", ARTIFACT_HTML_CSP);
    } else if (artifact.contentType === "svg") {
      sendText(res, content, "image/svg+xml", ARTIFACT_SVG_CSP);
    } else {
      sendText(res, content, "text/plain; charset=utf-8", ARTIFACT_TEXT_CSP);
    }
  } catch (err) {
    sendRenderError(res, err);
  }
});
