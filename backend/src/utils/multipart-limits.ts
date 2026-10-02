import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";

/**
 * Field-name limits every multer instance must spread into its `limits`.
 *
 * multer parses bracket notation in text field names (`a[1][b]`) into nested
 * objects, and its defaults leave that unbounded: `items[4294967294]` followed
 * by `items[x]` makes it walk a 2^32-slot sparse array synchronously, freezing
 * the event loop (GHSA-535w-7cp7-47q4). Upgrading to multer ≥2.3.0 only adds
 * the knobs — the default for `fieldArrayIndexLimit` is still Infinity, so the
 * hang reproduces on 2.4.0 until these are set.
 *
 * No Callboard client sends a bracketed field name — or any text field at
 * all: image uploads are N × `images`, agent import and multipart storage
 * writes are 1 × `file` (storage also *accepts* an optional flat `mimeType`).
 * So any bracket is refused.
 */
export const MULTIPART_FIELD_LIMITS = {
  fieldNestingDepth: 0,
  fieldArrayIndexLimit: 0,
  fieldNameSize: 100,
  fields: 20,
} as const;

export interface UploadErrorMessages {
  /** Body for LIMIT_FILE_SIZE, answered with 413. */
  tooLarge: string;
  /** Body when the request carries more files than the route takes; `field` is the route's file field. */
  tooMany?: { field: string; message: string };
}

/**
 * Run a multer middleware and answer any failure as JSON instead of letting it
 * reach Express's default HTML 500: 413 for an oversized file, 400 for every
 * other refusal (a limit, a fileFilter rejection, a malformed body). MulterError
 * codes are passed through as `code`.
 */
export function withUploadErrors(middleware: RequestHandler, messages: UploadErrorMessages): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, (err?: unknown) => {
      if (!err) return next();
      if (!(err instanceof multer.MulterError)) {
        res.status(400).json({ error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: messages.tooLarge, code: err.code });
        return;
      }
      // An array()'s maxCount surfaces as LIMIT_UNEXPECTED_FILE on the route's own field;
      // on any other field it really is an unexpected field.
      const tooMany = err.code === "LIMIT_FILE_COUNT" || (err.code === "LIMIT_UNEXPECTED_FILE" && err.field === messages.tooMany?.field);
      const field = err.field ? ` (field "${err.field}")` : "";
      res.status(400).json({ error: tooMany && messages.tooMany ? messages.tooMany.message : `Upload rejected: ${err.message}${field}`, code: err.code });
    });
  };
}
