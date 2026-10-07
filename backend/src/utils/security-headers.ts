import type { Express, NextFunction, Request, Response } from "express";

/**
 * The default `Content-Security-Policy` every response starts with: framing
 * only, nothing about scripts or styles. A full policy for the SPA (inline
 * styles, Vite chunks, workers, artifact frames) is deliberately deferred.
 */
export const DEFAULT_CSP = "frame-ancestors 'self'";

/**
 * Baseline hardening headers for every response, mounted first in `index.ts`.
 *
 * Each value is a *default*: it is set before any route runs, so a route that
 * sets its own header with `res.setHeader` replaces it. That is what keeps the
 * stricter per-route policies intact. Everything that serves user, agent or
 * external bytes on the app origin sets its own sandboxing
 * `Content-Security-Policy` — artifact renders and storage items, plus
 * `/api/files/serve`, canvas content, `/api/images/:id` and git raw file
 * content via `setSandboxedContentHeaders` (utils/served-content.ts) — and
 * artifact renders also set `Referrer-Policy: no-referrer`. Those win over
 * these looser defaults; the headers a route doesn't set (here, usually
 * `X-Frame-Options` and `Referrer-Policy`) keep the default.
 *
 * - `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`: the session
 *   cookie is SameSite=Strict, but "site" ignores the port, so a page on
 *   another port of this host is same-site and could frame the app with the
 *   cookie attached (clickjacking). The app's own frames (artifact renders,
 *   file previews) are framed directly by the app origin and still load.
 *
 *   Both checks apply to EVERY ancestor, not just the parent. So a document
 *   with an opaque origin — a sandboxed artifact or canvas frame — can no
 *   longer frame an app URL, even though the app framed it: its origin is not
 *   'self'. Nothing in the app does that today, and it is the desired result
 *   (untrusted content should not embed authenticated app pages), but a future
 *   feature that nests app URLs inside a sandboxed frame will be refused.
 * - `Referrer-Policy: same-origin`: no app URL (chat ids, file paths) leaks to
 *   an external link target.
 * - `X-Content-Type-Options: nosniff`.
 *
 * Hand-written rather than `helmet`: it is four headers, and helmet's defaults
 * include a script/style CSP that would have to be switched off here anyway.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", DEFAULT_CSP);
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}

/**
 * Everything `index.ts` does to the app before any other middleware, in one
 * place so the over-the-wire tests mount exactly what the daemon mounts.
 *
 * Note what is absent: CORS. Every browser client is same-origin — the SPA is
 * served by this server in production, and in development Vite proxies `/api`
 * server-side, so the browser only ever talks to the Vite origin. A reflective
 * `cors({ origin: true, credentials: true })` used to be mounted here. Because
 * SameSite=Strict ignores the port, a page on any other port of this host sent
 * the cookie, and that CORS policy then let it read every response.
 */
export function applyHttpHardening(app: Express): void {
  app.disable("x-powered-by");
  app.use(securityHeaders);
}
