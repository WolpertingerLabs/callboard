/**
 * The twelve storage/artifact tools, driven through their handlers, plus the
 * wiring that makes them reachable: the callboard-tools spec, the manifest,
 * and `render_artifact`'s membership of CALLBOARD_UI_TOOLS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALLBOARD_UI_TOOLS, callboardUiTool, codexUiToolName } from "shared/types/callboard-ui-tools.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-sa-tools-"));
process.env.CALLBOARD_DATA_DIR = DATA;

// callboard-tools ⇄ claude are mutually recursive; only schemas are read here.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

const { buildStorageArtifactTools, READ_INLINE_MAX_BYTES } = await import("./storage-artifact-tools.js");
const { STORAGE_ROOT } = await import("./storage-service.js");
const { ARTIFACTS_ROOT } = await import("./artifact-service.js");

const STORAGE_ARTIFACT_TOOL_NAMES = [
  "list_storage_keys",
  "create_storage_key",
  "list_storage_items",
  "read_storage_item",
  "save_storage_item",
  "delete_storage_item",
  "delete_storage_key",
  "list_artifacts",
  "read_artifact",
  "save_artifact",
  "delete_artifact",
  "render_artifact",
] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function raw(name: string, args: Record<string, unknown> = {}): Promise<Block[]> {
  const tool = buildStorageArtifactTools().find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return (await (tool.handler as (a: unknown) => Promise<{ content: Block[] }>)(args)).content;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const [first] = await raw(name, args);
  return JSON.parse((first as { text: string }).text);
}

beforeEach(() => {
  rmSync(STORAGE_ROOT, { recursive: true, force: true });
  rmSync(ARTIFACTS_ROOT, { recursive: true, force: true });
});

describe("wiring", () => {
  it("builds exactly the twelve tools", () => {
    expect(buildStorageArtifactTools().map((t) => t.name)).toEqual([...STORAGE_ARTIFACT_TOOL_NAMES]);
  });

  it("every tool is on the callboard-tools server and in the manifest", async () => {
    const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
    const { getMcpToolsManifest } = await import("./mcp-tool-registry.js");
    const spec = buildCallboardToolsSpec(() => "chat-1");
    const manifest = getMcpToolsManifest("chat").tools.filter((t) => t.serverName === "callboard-tools");
    for (const name of STORAGE_ARTIFACT_TOOL_NAMES) {
      expect(
        spec.tools.some((t) => t.name === name),
        name,
      ).toBe(true);
      expect(manifest.find((t) => t.name === name)?.qualifiedName, name).toBe(`mcp__callboard-tools__${name}`);
    }
    // Importing callboard-tools pulls in most of the backend; generous for CI.
  }, 60_000);

  it("render_artifact is a Callboard UI tool under every alias; the others are not", () => {
    expect(CALLBOARD_UI_TOOLS).toContain("render_artifact");
    for (const raw of ["render_artifact", "mcp__callboard-tools__render_artifact", "callboard-ui__render_artifact", "mcp__callboard_ui__render_artifact"]) {
      expect(callboardUiTool(raw), raw).toBe("render_artifact");
    }
    expect(codexUiToolName("render_artifact", "mcp__callboard_ui")).toBe("callboard-ui__render_artifact");
    for (const name of STORAGE_ARTIFACT_TOOL_NAMES.filter((n) => n !== "render_artifact")) expect(callboardUiTool(name), name).toBeUndefined();
  });
});

describe("storage tools", () => {
  it("create / list / save / list items / delete item / delete key", async () => {
    expect(await call("create_storage_key", { key: "deck", description: "Birds" })).toMatchObject({ key: { key: "deck", description: "Birds" } });
    expect((await call("create_storage_key", { key: "deck" })).error).toMatch(/already exists/);
    expect((await call("list_storage_keys")).keys).toEqual([expect.objectContaining({ key: "deck", itemCount: 0 })]);
    expect((await call("save_storage_item", { key: "deck", name: "a.txt", content: "hi" })).item).toMatchObject({ name: "a.txt", size: 2 });
    expect((await call("list_storage_items", { key: "deck" })).items.map((i: { name: string }) => i.name)).toEqual(["a.txt"]);
    expect(await call("delete_storage_item", { key: "deck", name: "a.txt" })).toMatchObject({ success: true });
    expect((await call("delete_storage_key", { key: "deck", confirm: false })).error).toMatch(/confirm: true/);
    expect(await call("delete_storage_key", { key: "deck", confirm: true })).toMatchObject({ success: true });
    expect((await call("list_storage_keys")).keys).toEqual([]);
  });

  it("save_storage_item: exactly one source; missing key needs create_key; invalid names are errors", async () => {
    expect((await call("save_storage_item", { key: "k", name: "a.txt" })).error).toMatch(/exactly one/);
    expect((await call("save_storage_item", { key: "k", name: "a.txt", content: "a", content_base64: "YQ==" })).error).toMatch(/exactly one/);
    expect((await call("save_storage_item", { key: "k", name: "a.txt", content: "a" })).error).toMatch(/create_key/);
    expect((await call("save_storage_item", { key: "k", name: "a.bin", content_base64: "AQID", create_key: true })).item).toMatchObject({ size: 3 });
    expect((await call("save_storage_item", { key: "k", name: "../x", content: "a" })).error).toMatch(/Invalid item name/);
    expect((await call("save_storage_item", { key: "k", name: "b.bin", content_base64: "%%%" })).error).toMatch(/base64/);
  });

  it("save_storage_item source_path: render_file's checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "callboard-sa-src-"));
    const file = join(dir, "photo.jpg");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
    await call("create_storage_key", { key: "k" });
    expect((await call("save_storage_item", { key: "k", name: "p.jpg", source_path: "photo.jpg" })).error).toMatch(/absolute/);
    expect((await call("save_storage_item", { key: "k", name: "p.jpg", source_path: `${file}\0` })).error).toMatch(/Invalid source_path/);
    expect((await call("save_storage_item", { key: "k", name: "p.jpg", source_path: join(dir, "nope") })).error).toMatch(/not found/);
    expect((await call("save_storage_item", { key: "k", name: "p.jpg", source_path: dir })).error).toMatch(/regular file/);
    symlinkSync(file, join(dir, "link"));
    expect((await call("save_storage_item", { key: "k", name: "p.jpg", source_path: join(dir, "link") })).item).toMatchObject({
      mimeType: "image/jpeg",
      size: 3,
    });
  });

  it("read_storage_item: text inline with file_path; images as an image block; binary needs base64; >1MB text errors with the path", async () => {
    await call("create_storage_key", { key: "k" });
    await call("save_storage_item", { key: "k", name: "deck.json", content: '{"cards":[]}' });
    const text = await call("read_storage_item", { key: "k", name: "deck.json" });
    expect(text).toMatchObject({ name: "deck.json", encoding: "text", content: '{"cards":[]}', file_path: expect.stringMatching(new RegExp(`^${escapeRe(join(STORAGE_ROOT, "k", "items", "deck.json~"))}[0-9a-f]{16}$`)) });

    await call("save_storage_item", { key: "k", name: "img.png", content_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") });
    const blocks = await raw("read_storage_item", { key: "k", name: "img.png" });
    expect(blocks).toHaveLength(2);
    expect(JSON.parse((blocks[0] as { text: string }).text)).toMatchObject({ name: "img.png", file_path: expect.stringMatching(new RegExp(`^${escapeRe(join(STORAGE_ROOT, "k", "items", "img.png~"))}[0-9a-f]{16}$`)) });
    expect(blocks[1]).toEqual({ type: "image", data: "iVBORw==", mimeType: "image/png" });

    await call("save_storage_item", { key: "k", name: "blob.bin", content_base64: "AAEC" });
    const bin = await call("read_storage_item", { key: "k", name: "blob.bin" });
    expect(bin.content).toBeUndefined();
    expect(bin.file_path).toBeTruthy();
    expect(await call("read_storage_item", { key: "k", name: "blob.bin", encoding: "base64" })).toMatchObject({ encoding: "base64", content: "AAEC" });

    await call("save_storage_item", { key: "k", name: "big.txt", content: "x".repeat(READ_INLINE_MAX_BYTES + 1) });
    const big = await call("read_storage_item", { key: "k", name: "big.txt" });
    expect(big.error).toMatch(/inline limit/);
    expect(big.error).toContain(join(STORAGE_ROOT, "k", "items", "big.txt"));
    expect((await call("read_storage_item", { key: "k", name: "missing" })).error).toMatch(/not found/);
  });

  it("read_storage_item caps on the size of the file it opened, not meta's recorded size", async () => {
    await call("save_storage_item", { key: "k2", name: "grew.txt", content: "tiny", create_key: true });
    // The file on disk is now far over the inline cap while meta still says 4 bytes.
    const { getStorageItem } = await import("./storage-service.js");
    writeFileSync(getStorageItem("k2", "grew.txt").filePath, "x".repeat(READ_INLINE_MAX_BYTES + 1));
    const res = await call("read_storage_item", { key: "k2", name: "grew.txt" });
    expect(res.error).toMatch(/over the 1MB inline limit/);
    expect(res.content).toBeUndefined();
  });
});

describe("artifact tools", () => {
  it("save (create + append) / list / read / delete", async () => {
    const created = await call("save_artifact", { id: "app", name: "App", content_type: "html", content: "<p>1</p>", storage_access: "read" });
    expect(created).toMatchObject({ created: true, artifact: { id: "app", storageAccess: "read", currentVersion: 1 }, version: { version: 1 } });
    expect(created.artifact.versions).toBeUndefined();
    expect(await call("save_artifact", { id: "app", content: "<p>2</p>", note: "v2" })).toMatchObject({ created: false, version: { version: 2, note: "v2" } });
    expect((await call("save_artifact", { id: "new", content: "x" })).error).toMatch(/name is required/);
    expect((await call("save_artifact", { id: "app" })).error).toMatch(/exactly one/);
    expect((await call("list_artifacts")).artifacts.map((a: { id: string }) => a.id)).toEqual(["app"]);
    expect(await call("read_artifact", { id: "app", version: 1 })).toMatchObject({ version: 1, content: "<p>1</p>", artifact: { currentVersion: 2 } });
    expect((await call("read_artifact", { id: "app" })).content).toBe("<p>2</p>");
    expect((await call("delete_artifact", { id: "app", confirm: false })).error).toMatch(/confirm/);
    expect(await call("delete_artifact", { id: "app", confirm: true })).toMatchObject({ success: true });
    expect((await call("read_artifact", { id: "app" })).error).toMatch(/not found/);
  });

  it("render_artifact: result shape, unbound → none, bound → the declared access", async () => {
    await call("save_artifact", { id: "rw", name: "RW", content_type: "html", content: "x", storage_access: "readwrite" });
    await call("create_storage_key", { key: "deck" });
    const { getArtifact } = await import("./artifact-service.js");
    const sha256 = getArtifact("rw").versions[0].sha256;
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await call("render_artifact", { id: "rw" })).toEqual({
      type: "render_artifact",
      artifact_id: "rw",
      version: 1,
      sha256,
      name: "RW",
      content_type: "html",
      storage_access: "none",
    });
    expect(await call("render_artifact", { id: "rw", storage_key: "deck", caption: "Deck", display_mode: "fullscreen" })).toEqual({
      type: "render_artifact",
      artifact_id: "rw",
      version: 1,
      sha256,
      name: "RW",
      content_type: "html",
      storage_key: "deck",
      storage_access: "readwrite",
      caption: "Deck",
      display_mode: "fullscreen",
    });
    await call("save_artifact", { id: "ro", name: "RO", content_type: "html", content: "x", storage_access: "read" });
    expect((await call("render_artifact", { id: "ro", storage_key: "deck" })).storage_access).toBe("read");
  });

  it("render_artifact errors: missing key, access none, missing version or artifact", async () => {
    await call("save_artifact", { id: "rw", name: "RW", content_type: "html", content: "x", storage_access: "readwrite" });
    await call("save_artifact", { id: "pic", name: "Pic", content_type: "svg", content: "<svg/>" });
    expect((await call("render_artifact", { id: "rw", storage_key: "nope" })).error).toMatch(/Storage key not found/);
    expect((await call("render_artifact", { id: "rw", storage_key: "../etc" })).error).toMatch(/Invalid storage key/);
    await call("create_storage_key", { key: "deck" });
    expect((await call("render_artifact", { id: "pic", storage_key: "deck" })).error).toMatch(/storage_access "none"/);
    expect((await call("render_artifact", { id: "rw", version: 9 })).error).toMatch(/Version 9/);
    expect((await call("render_artifact", { id: "ghost" })).error).toMatch(/not found/);
  });
});
