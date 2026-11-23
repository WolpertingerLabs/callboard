/**
 * `render_file`: types come from the shared media table (utils/media-types.ts),
 * any other regular local file becomes a `file` (download) card, and local
 * files have no size cap — /api/files/serve streams them with Range.
 */
import { describe, it, expect, vi } from "vitest";
import { closeSync, ftruncateSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "callboard-render-file-"));
process.env.CALLBOARD_DATA_DIR = DATA;

// See callboard-tools.wait.test.ts: importing the tool module directly trips the claude.ts cycle.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
import type { ToolDefinition } from "../agents/ports/tools.js";

function renderFile(args: Record<string, unknown>) {
  const spec = buildCallboardToolsSpec(() => "chat-under-test", undefined, { includeJobTools: false });
  const tool = spec.tools.find((t) => t.name === "render_file") as ToolDefinition<any>;
  return tool.handler(args);
}

function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0].text!);
}

function file(name: string, content = "x"): string {
  const p = join(DATA, name);
  writeFileSync(p, content);
  return p;
}

describe("render_file", () => {
  it("accepts a local file over 100MB", async () => {
    const p = join(DATA, "long-recording.mp4");
    const size = 150 * 1024 * 1024;
    const fd = openSync(p, "w");
    ftruncateSync(fd, size); // sparse: no disk used
    closeSync(fd);
    const result = payload(await renderFile({ file_path: p }));
    expect(result).toMatchObject({ type: "render_file", media_type: "video", mime_type: "video/mp4", file_size: size });
  });

  it.each([
    ["clip.m4v", "video", "video/mp4"],
    ["clip.ogv", "video", "video/ogg"],
    ["voice.m4a", "audio", "audio/mp4"],
    ["voice.opus", "audio", "audio/ogg"],
    ["photo.AVIF", "image", "image/avif"],
    ["doc.pdf", "pdf", "application/pdf"],
  ])("%s → %s (%s)", async (name, mediaType, mime) => {
    const result = payload(await renderFile({ file_path: file(name) }));
    expect(result).toMatchObject({ media_type: mediaType, mime_type: mime });
  });

  it.each([
    ["archive.zip", "application/zip"],
    ["page.html", "text/html"],
    ["subs.vtt", "text/vtt"],
    ["notes.txt", "text/plain"],
    ["movie.mkv", "video/x-matroska"],
    ["blob.qqq", "application/octet-stream"],
    ["Makefile", "application/octet-stream"],
  ])("%s → a file card (%s)", async (name, mime) => {
    const p = file(name, "hello");
    const result = payload(await renderFile({ file_path: p, caption: "c", untrusted: true, untrusted_reason: "r" }));
    expect(result).toEqual({
      type: "render_file",
      file_path: p,
      media_type: "file",
      mime_type: mime,
      display_mode: "inline",
      file_size: 5,
      caption: "c",
      untrusted: true,
      untrusted_reason: "r",
    });
  });

  it("a directory and a missing path still error", async () => {
    expect(payload(await renderFile({ file_path: DATA })).error).toMatch(/not a regular file/);
    expect(payload(await renderFile({ file_path: join(DATA, "missing.zip") })).error).toMatch(/File not found/);
  });

  it("a URL is typed from the table too, and unknown-extension or .vtt URLs are unsupported", async () => {
    expect(payload(await renderFile({ url: "https://example.com/a/clip.m4v?x=1" }))).toMatchObject({ media_type: "video", mime_type: "video/mp4" });
    expect(payload(await renderFile({ url: "https://example.com/subs.vtt" })).error).toMatch(/Unsupported/);
    expect(payload(await renderFile({ url: "https://example.com/archive.zip" })).error).toMatch(/Unsupported/);
  });

  it("the tool definition and the UI registry carry the same description", async () => {
    const spec = buildCallboardToolsSpec(() => "chat-under-test", undefined, { includeJobTools: false });
    const tool = spec.tools.find((t) => t.name === "render_file")!;
    const { RENDER_FILE_DESCRIPTION } = await import("./render-file-description.js");
    expect(tool.description).toBe(RENDER_FILE_DESCRIPTION);
    expect(RENDER_FILE_DESCRIPTION).toMatch(/download card/);
  });
});
