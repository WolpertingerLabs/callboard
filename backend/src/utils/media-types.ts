/**
 * The one extension → MIME table for media the app renders inline: the types
 * `render_file` accepts and `/api/files/serve` will serve (local path or URL
 * proxy).
 *
 * Every entry is served on the app origin with `Content-Disposition: inline`,
 * so each MIME must be one a browser renders without running script. That is
 * pinned by `media-types.test.ts`: `image/svg+xml` is the single
 * script-capable exception, admitted only because every served response
 * carries the sandboxing CSP (`utils/served-content.ts`). HTML, XML, JS, CSS
 * and plain text never belong here.
 *
 * Deliberately absent (browser playback is unreliable): .mkv, .avi, .3gp,
 * .heic, .jxl, .tif/.tiff.
 *
 * Backend-only on purpose: the frontend never maps extensions, so this need
 * not ship in the bundle or require `build:shared` for each new format.
 */
import path from "path";

/**
 * `captions` is servable (so a same-origin `<track src>` works) but is not a
 * render_file media type: render_file treats it as unsupported.
 */
export type MediaCategory = "image" | "audio" | "video" | "pdf" | "captions";

export interface MediaTypeInfo {
  mime: string;
  category: MediaCategory;
}

/** Keyed by lower-case extension including the dot (`".mp4"`). */
export const MEDIA_TYPES: Readonly<Record<string, MediaTypeInfo>> = Object.freeze({
  // image
  ".png": { mime: "image/png", category: "image" },
  ".jpg": { mime: "image/jpeg", category: "image" },
  ".jpeg": { mime: "image/jpeg", category: "image" },
  ".gif": { mime: "image/gif", category: "image" },
  ".webp": { mime: "image/webp", category: "image" },
  ".svg": { mime: "image/svg+xml", category: "image" },
  ".bmp": { mime: "image/bmp", category: "image" },
  ".avif": { mime: "image/avif", category: "image" },
  ".apng": { mime: "image/apng", category: "image" },
  ".ico": { mime: "image/vnd.microsoft.icon", category: "image" },
  // audio
  ".mp3": { mime: "audio/mpeg", category: "audio" },
  ".wav": { mime: "audio/wav", category: "audio" },
  ".ogg": { mime: "audio/ogg", category: "audio" },
  ".aac": { mime: "audio/aac", category: "audio" },
  ".flac": { mime: "audio/flac", category: "audio" },
  ".m4a": { mime: "audio/mp4", category: "audio" },
  ".opus": { mime: "audio/ogg", category: "audio" }, // Ogg Opus
  ".oga": { mime: "audio/ogg", category: "audio" },
  ".weba": { mime: "audio/webm", category: "audio" },
  // video
  ".mp4": { mime: "video/mp4", category: "video" },
  ".webm": { mime: "video/webm", category: "video" },
  ".mov": { mime: "video/quicktime", category: "video" },
  ".m4v": { mime: "video/mp4", category: "video" }, // not Apple's video/x-m4v, which Chrome won't play
  ".ogv": { mime: "video/ogg", category: "video" },
  // documents
  ".pdf": { mime: "application/pdf", category: "pdf" },
  // captions (served only; see MediaCategory)
  ".vtt": { mime: "text/vtt", category: "captions" },
});

/** The table entry for `p`'s extension (case-insensitive), or undefined. */
export function mediaTypeForPath(p: string): MediaTypeInfo | undefined {
  const ext = path.extname(p).toLowerCase();
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : undefined;
}
