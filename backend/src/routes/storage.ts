import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { MULTIPART_FIELD_LIMITS, withUploadErrors } from "../utils/multipart-limits.js";
import { closeSync, createReadStream } from "fs";
import { STORAGE_ITEM_MIME_HEADER } from "shared/types/index.js";
import {
  STORAGE_MAX_ITEM_BYTES,
  StorageError,
  createStorageKey,
  decodeBase64Strict,
  deleteStorageItem,
  deleteStorageKey,
  getStorageKey,
  httpStatusFor,
  listStorageKeys,
  openStorageItem,
  saveStorageItem,
  updateStorageKey,
} from "../services/storage-service.js";
import { createLogger } from "../utils/logger.js";
import { SANDBOXED_CONTENT_CSP } from "../utils/served-content.js";

const log = createLogger("storage-route");

export const storageRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: STORAGE_MAX_ITEM_BYTES, files: 1, ...MULTIPART_FIELD_LIMITS },
});

/**
 * The only types ever served `inline` from storage. Everything else —
 * explicitly including text/html and image/svg+xml — is an `attachment`:
 * serving those inline from this origin would be same-origin script execution
 * under the user's cookie. The recorded MIME type is never trusted beyond
 * picking from this list.
 */
const INLINE_TYPES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
  "text/plain": "text/plain; charset=utf-8",
};

/** Headers every served item carries, inline or not. */
export const STORAGE_ITEM_CSP = SANDBOXED_CONTENT_CSP;

/** Map a service error to its status; anything else is a 500. */
export function sendStorageError(res: Response, err: unknown, what: string): void {
  if (err instanceof StorageError) {
    res.status(httpStatusFor(err.code)).json({ error: err.message });
    return;
  }
  log.error(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  res.status(500).json({ error: `${what} failed` });
}

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

/**
 * GET /api/storage
 */
storageRouter.get(
  "/",
  wrap("List storage keys", (_req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'List storage keys'
    res.json({ keys: listStorageKeys() });
  }),
);

/**
 * POST /api/storage  { key, description? }
 */
storageRouter.post(
  "/",
  wrap("Create storage key", async (req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'Create a storage key'
    const { key, description } = (req.body ?? {}) as { key?: unknown; description?: unknown };
    res.status(201).json({ key: await createStorageKey(key as string, description as string | undefined) });
  }),
);

/**
 * GET /api/storage/:key
 */
storageRouter.get(
  "/:key",
  wrap("Get storage key", (req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'Get a storage key and its items'
    res.json({ key: getStorageKey(req.params.key) });
  }),
);

/**
 * PATCH /api/storage/:key  { description }
 */
storageRouter.patch(
  "/:key",
  wrap("Update storage key", async (req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'Update a storage key description'
    const { description } = (req.body ?? {}) as { description?: unknown };
    if (typeof description !== "string") throw new StorageError("invalid", "description must be a string");
    res.json({ key: await updateStorageKey(req.params.key, { description }) });
  }),
);

/**
 * DELETE /api/storage/:key
 */
storageRouter.delete(
  "/:key",
  wrap("Delete storage key", async (req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'Delete a storage key and all its items'
    await deleteStorageKey(req.params.key);
    res.json({ success: true });
  }),
);

/**
 * GET /api/storage/:key/items/:name
 *
 * Raw bytes. `inline` only for raster images and text/plain; everything else
 * is an attachment served as application/octet-stream. Always nosniff, a
 * sandboxing CSP, and no-store.
 */
storageRouter.get(
  "/:key/items/:name",
  wrap("Read storage item", (req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'Download a storage item'
    const { item, fd, size } = openStorageItem(req.params.key, req.params.name);
    let stream: ReturnType<typeof createReadStream>;
    try {
      const inlineType = Object.prototype.hasOwnProperty.call(INLINE_TYPES, item.mimeType) ? INLINE_TYPES[item.mimeType] : undefined;
      res.setHeader("Content-Type", inlineType ?? "application/octet-stream");
      // What the open fd holds, not what meta recorded — they agree unless something outside the service touched the file.
      res.setHeader("Content-Length", size);
      // The name is validated to [A-Za-z0-9._-], so it is safe inside the quotes.
      res.setHeader("Content-Disposition", `${inlineType ? "inline" : "attachment"}; filename="${item.name}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", STORAGE_ITEM_CSP);
      res.setHeader("Cache-Control", "no-store");
      // Informational: the recorded type, for clients that re-type bytes they already hold (the artifact bridge's dataUrl read).
      // Validated to a bare type/subtype on save, so it is header-safe.
      res.setHeader(STORAGE_ITEM_MIME_HEADER, item.mimeType);
      stream = createReadStream("", { fd, autoClose: true });
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    stream.on("error", (err) => {
      log.error(`Read storage item stream failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: "Failed to read item" });
      else res.destroy();
    });
    stream.pipe(res);
  }),
);

const uploadItem = withUploadErrors(upload.single("file"), {
  tooLarge: `Item too large; the per-item limit is ${STORAGE_MAX_ITEM_BYTES / 1024 / 1024}MB`,
});

/** Multer only when the request is multipart — JSON bodies are already parsed by express.json. */
function maybeMultipart(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("multipart/form-data")) return next();
  uploadItem(req, res, next);
}

/**
 * PUT /api/storage/:key/items/:name
 *
 * JSON `{ content | content_base64, mimeType? }`, or multipart with a `file`
 * field (and optional `mimeType` field). Creates or overwrites.
 */
storageRouter.put(
  "/:key/items/:name",
  maybeMultipart,
  wrap("Save storage item", async (req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'Create or overwrite a storage item'
    const body = (req.body ?? {}) as { content?: unknown; content_base64?: unknown; mimeType?: unknown };
    const mimeType = typeof body.mimeType === "string" && body.mimeType ? body.mimeType : undefined;
    let data: Buffer;
    let fallbackMime: string | undefined;
    if (req.file) {
      data = req.file.buffer;
      fallbackMime = req.file.mimetype && req.file.mimetype !== "application/octet-stream" ? req.file.mimetype : undefined;
    } else {
      const hasText = body.content !== undefined;
      const hasB64 = body.content_base64 !== undefined;
      if (hasText === hasB64) throw new StorageError("invalid", "Provide exactly one of content or content_base64 (or a multipart file)");
      if (hasText && typeof body.content !== "string") throw new StorageError("invalid", "content must be a string");
      if (hasB64 && typeof body.content_base64 !== "string") throw new StorageError("invalid", "content_base64 must be a string");
      data = hasText ? Buffer.from(body.content as string, "utf-8") : decodeBase64Strict(body.content_base64 as string);
    }
    const item = await saveStorageItem(req.params.key, req.params.name, data, { mimeType: mimeType ?? fallbackMime });
    res.json({ item });
  }),
);

/**
 * DELETE /api/storage/:key/items/:name
 */
storageRouter.delete(
  "/:key/items/:name",
  wrap("Delete storage item", async (req, res) => {
    // #swagger.tags = ['Storage']
    // #swagger.summary = 'Delete a storage item'
    await deleteStorageItem(req.params.key, req.params.name);
    res.json({ success: true });
  }),
);
