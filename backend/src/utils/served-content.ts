/**
 * Headers for responses that hand user, agent or external bytes back to the
 * browser on the app origin (files, canvases, git previews, images, storage,
 * artifact source).
 *
 * The danger is a document that runs script *as Callboard*: an SVG or HTML
 * body opened top-level or in an unsandboxed iframe executes on the app origin
 * with the user's cookie, and can read any API. A response-level CSP `sandbox`
 * gives that document an opaque origin however it is opened (link, new tab,
 * iframe), and `default-src 'none'` stops it loading anything. It has no
 * effect on `<img>`/`<video>`/`<audio>` consumers: the policy of a subresource
 * response is not applied to the page that embeds it.
 */
import type { Response } from "express";

/** Nothing executes, nothing loads, opaque origin. The default for served content. */
export const SANDBOXED_CONTENT_CSP = "default-src 'none'; sandbox";

/** `nosniff` plus a sandboxing CSP — {@link SANDBOXED_CONTENT_CSP} unless the route needs a looser sandbox. */
export function setSandboxedContentHeaders(res: Response, csp: string = SANDBOXED_CONTENT_CSP): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", csp);
}
