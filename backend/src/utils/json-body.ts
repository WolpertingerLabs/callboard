import express, { type RequestHandler } from "express";

/**
 * `express.json()`, plus Express 4's guarantee that `req.body` is an object.
 *
 * Express 5's body-parser leaves `req.body` undefined when a request has no
 * body or is not JSON; Express 4 set `{}`. Route handlers destructure
 * `req.body` directly, and the client sends body-less POST, PATCH and DELETE
 * requests (stop, detach, read, held/take, DELETE /spaces/:id, ...), so
 * without the default those would answer 500. Multipart routes are unaffected:
 * multer replaces the object with its own.
 */
export function jsonBody(options?: Parameters<typeof express.json>[0]): RequestHandler[] {
  return [
    express.json(options),
    (req, _res, next) => {
      req.body ??= {};
      next();
    },
  ];
}
