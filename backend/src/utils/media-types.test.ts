/**
 * Guard for the inline media table. Everything in it is served on the app
 * origin with `Content-Disposition: inline`, so it must stay a list of inert
 * renderers. Adding a script-capable type is a security decision, not a
 * format addition — this test makes it an explicit one.
 */
import { describe, expect, it } from "vitest";
import { MEDIA_TYPES, mediaTypeForPath } from "./media-types.js";

/** The only script-capable type allowed, neutralised by the sandbox CSP on every served response. */
const SCRIPT_CAPABLE_EXCEPTIONS = ["image/svg+xml"];

const INERT = (mime: string) =>
  /^image\/[a-z0-9.+-]+$/.test(mime) ||
  /^audio\/[a-z0-9.+-]+$/.test(mime) ||
  /^video\/[a-z0-9.+-]+$/.test(mime) ||
  mime === "application/pdf" ||
  mime === "text/vtt";

const FORBIDDEN = (mime: string) =>
  mime === "text/html" || mime === "application/xhtml+xml" || /[/+]xml$/.test(mime) || mime.includes("javascript") || mime === "text/css";

const entries = Object.entries(MEDIA_TYPES);

describe("MEDIA_TYPES", () => {
  it.each(entries)("%s → %o is a renderable-but-inert type", (_ext, { mime }) => {
    expect(INERT(mime)).toBe(true);
  });

  it("no type is script-capable, except the named sandboxed exception", () => {
    const scriptCapable = [...new Set(entries.map(([, { mime }]) => mime).filter(FORBIDDEN))];
    expect(scriptCapable).toEqual(SCRIPT_CAPABLE_EXCEPTIONS);
  });

  it("every key is a lower-case extension with a leading dot", () => {
    for (const [ext] of entries) expect(ext).toMatch(/^\.[a-z0-9]+$/);
  });

  it("never serves text/plain or markup by extension", () => {
    for (const ext of [".html", ".htm", ".xhtml", ".xml", ".js", ".mjs", ".css", ".json", ".txt", ".md", ".mkv", ".heic"]) {
      expect(mediaTypeForPath(`/x/a${ext}`)).toBeUndefined();
    }
  });
});

describe("mediaTypeForPath", () => {
  it("is case-insensitive and uses the last extension", () => {
    expect(mediaTypeForPath("/a/b/CLIP.M4V")).toEqual({ mime: "video/mp4", category: "video" });
    expect(mediaTypeForPath("/a/b.tar.mp3")).toEqual({ mime: "audio/mpeg", category: "audio" });
    expect(mediaTypeForPath("/a/subs.vtt")).toEqual({ mime: "text/vtt", category: "captions" });
  });

  it("ignores prototype keys and extensionless paths", () => {
    expect(mediaTypeForPath("/a/constructor")).toBeUndefined();
    expect(mediaTypeForPath("/a/b.constructor")).toBeUndefined();
    expect(mediaTypeForPath("/a/.png")).toBeUndefined(); // a dotfile named ".png" has no extension
  });
});
