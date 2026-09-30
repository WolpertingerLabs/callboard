/**
 * The thirteen storage/artifact tools, driven through their handlers, plus the
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
  "update_storage_key",
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
  it("builds exactly the thirteen tools", () => {
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
    await call("create_storage_key", { key: "deck", artifacts: ["rw", "ro"] });
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
    await call("create_storage_key", { key: "deck", artifacts: ["pic"] });
    expect((await call("render_artifact", { id: "pic", storage_key: "deck" })).error).toMatch(/storage_access "none"/);
    expect((await call("render_artifact", { id: "rw", version: 9 })).error).toMatch(/Version 9/);
    expect((await call("render_artifact", { id: "ghost" })).error).toMatch(/not found/);
  });

  it("render_artifact refuses a key that does not list the artifact — strict: no list binds nothing — and names the fix", async () => {
    await call("save_artifact", { id: "rw", name: "RW", content_type: "html", content: "x", storage_access: "readwrite" });
    await call("create_storage_key", { key: "bare" });
    await call("create_storage_key", { key: "other", artifacts: ["cramhouse"] });
    const fix = (key: string) =>
      `add "rw" to storage key "${key}"'s artifacts via update_storage_key or Settings → Storage`;
    for (const key of ["bare", "other"]) {
      const res = await call("render_artifact", { id: "rw", storage_key: key });
      expect(res.type).toBeUndefined();
      expect(res.error).toContain(`storage key "${key}" is not designed for artifact "rw"`);
      expect(res.error).toContain(fix(key));
    }
    // Unbound renders are untouched by any key's list.
    expect((await call("render_artifact", { id: "rw" })).storage_access).toBe("none");
    // An agent fixes it with update_storage_key, and the same call now binds.
    await call("update_storage_key", { key: "bare", artifacts: ["rw"] });
    expect(await call("render_artifact", { id: "rw", storage_key: "bare" })).toMatchObject({ storage_key: "bare", storage_access: "readwrite" });
  });
});

describe("storage key artifacts list (tools)", () => {
  it("create_storage_key and update_storage_key validate the list; list_storage_keys returns it", async () => {
    expect((await call("create_storage_key", { key: "deck", artifacts: ["cramhouse", "cramhouse", "flag-deck"] })).key).toMatchObject({
      artifacts: ["cramhouse", "flag-deck"],
    });
    expect((await call("create_storage_key", { key: "bad", artifacts: ["Not An Id"] })).error).toMatch(/invalid artifact id/);
    expect((await call("list_storage_keys")).keys).toEqual([expect.objectContaining({ key: "deck", artifacts: ["cramhouse", "flag-deck"] })]);

    expect((await call("update_storage_key", { key: "deck" })).error).toMatch(/Provide description, artifacts, or add_artifacts/);
    expect((await call("update_storage_key", { key: "deck", artifacts: ["../x"] })).error).toMatch(/invalid artifact id/);
    expect((await call("update_storage_key", { key: "deck", artifacts: Array.from({ length: 33 }, (_, i) => `a${i}`) })).error).toMatch(/max 32/);
    expect((await call("update_storage_key", { key: "nope", artifacts: [] })).error).toMatch(/not found/);

    const updated = await call("update_storage_key", { key: "deck", description: "Birds", artifacts: ["gone-artifact"] });
    expect(updated.key).toMatchObject({ key: "deck", description: "Birds", artifacts: ["gone-artifact"] });
    expect(updated.key.items).toBeUndefined();
    expect((await call("update_storage_key", { key: "deck", description: "" })).key).toMatchObject({ artifacts: ["gone-artifact"] });
    expect((await call("update_storage_key", { key: "deck", artifacts: [] })).key.artifacts).toEqual([]);
  });

  it("update_storage_key add_artifacts / remove_artifacts change the stored list; artifacts cannot be combined with them", async () => {
    await call("create_storage_key", { key: "deck", artifacts: ["app-a", "app-b", "ghost"] });
    // Someone else narrows the list; an agent adding by delta keeps that change.
    await call("update_storage_key", { key: "deck", artifacts: ["app-a"] });
    expect((await call("update_storage_key", { key: "deck", add_artifacts: ["app-p"] })).key.artifacts).toEqual(["app-a", "app-p"]);
    expect((await call("update_storage_key", { key: "deck", remove_artifacts: ["app-a", "absent"], add_artifacts: ["app-q"] })).key.artifacts).toEqual([
      "app-p",
      "app-q",
    ]);
    expect((await call("update_storage_key", { key: "deck", artifacts: ["x"], add_artifacts: ["y"] })).error).toMatch(/cannot be combined/);
    expect((await call("update_storage_key", { key: "deck", artifacts: [], remove_artifacts: [] })).error).toMatch(/cannot be combined/);
    expect((await call("update_storage_key", { key: "deck", add_artifacts: ["../x"] })).error).toMatch(/invalid artifact id in artifacts to add/);
    expect((await call("update_storage_key", { key: "deck", add_artifacts: ["z"], remove_artifacts: ["z"] })).error).toMatch(/both added and removed/);
    expect((await call("update_storage_key", { key: "deck", add_artifacts: Array.from({ length: 31 }, (_, i) => `n${i}`) })).error).toMatch(/max 32/);
    expect((await call("list_storage_keys")).keys[0].artifacts).toEqual(["app-p", "app-q"]);
    // The description steers agents to the delta and warns what replacing does.
    const desc = buildStorageArtifactTools().find((t) => t.name === "update_storage_key")!.description;
    expect(desc).toMatch(/prefer add_artifacts \/ remove_artifacts/);
    expect(desc).toMatch(/overwrites any change made since you last read the list/);
  });

  it("list_artifacts names the keys each artifact can be rendered against", async () => {
    await call("save_artifact", { id: "app", name: "App", content_type: "html", content: "x", storage_access: "read" });
    await call("save_artifact", { id: "solo", name: "Solo", content_type: "html", content: "x" });
    await call("create_storage_key", { key: "a", artifacts: ["app"] });
    await call("create_storage_key", { key: "b", artifacts: ["app", "solo"] });
    await call("create_storage_key", { key: "c" });
    const { artifacts } = await call("list_artifacts");
    expect(Object.fromEntries(artifacts.map((a: { id: string; storage_keys: string[] }) => [a.id, a.storage_keys]))).toEqual({ app: ["a", "b"], solo: ["b"] });
  });

  it("the tool schemas take a plain string array (no z.record) and every description states the rule", () => {
    const tools = buildStorageArtifactTools();
    for (const name of ["create_storage_key", "update_storage_key"]) {
      expect(tools.find((t) => t.name === name)!.description, name).toMatch(/ONLY those artifacts can be rendered against the key/);
    }
    expect(tools.find((t) => t.name === "render_artifact")!.description).toMatch(/an artifact not on the list does not bind to the key at all/);
  });
});
