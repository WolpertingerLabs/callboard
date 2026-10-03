/**
 * Storage + artifact tools — folded into the always-on `callboard-tools`
 * server (see callboard-tools.ts), so every session can use them.
 *
 *   Storage:   list_storage_keys, create_storage_key, list_storage_items,
 *              read_storage_item, save_storage_item, delete_storage_item,
 *              delete_storage_key
 *   Artifacts: list_artifacts, read_artifact, save_artifact, delete_artifact,
 *              render_artifact (a UI tool — see CALLBOARD_UI_TOOLS)
 *
 * All validation lives in the services; these handlers translate arguments
 * and turn a thrown StorageError into the usual `{ error }` JSON result.
 *
 * `source_path` arguments read any file the callboard process can read — the
 * same authority `render_file` and the agent's own Read tool already have —
 * with render_file's checks (absolute, no NUL, realpath'd, regular file,
 * size-limited).
 */
import { closeSync, readFileSync } from "fs";
import { z } from "zod";
import { defineTool, jsonError, jsonResult } from "../agents/ports/tools.js";
import type { AnyToolDefinition, ToolCallResult } from "../agents/ports/tools.js";
import { ARTIFACT_CONTENT_TYPES, ARTIFACT_STORAGE_ACCESS } from "shared/types/index.js";
import type { RenderArtifactToolResult } from "shared/types/index.js";
import {
  STORAGE_MAX_ITEM_BYTES,
  STORAGE_MAX_ITEMS_PER_KEY,
  STORAGE_MAX_KEY_BYTES,
  STORAGE_MAX_STORE_BYTES,
  StorageError,
  createStorageKey,
  decodeBase64Strict,
  deleteStorageItem,
  deleteStorageKey,
  listStorageItems,
  listStorageKeys,
  openStorageItem,
  saveStorageItem,
  saveStorageItemFromFile,
  storageKeyExists,
} from "./storage-service.js";
import { deleteArtifact, getArtifact, listArtifacts, readArtifactVersion, saveArtifact, saveArtifactFromFile } from "./artifact-service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("storage-artifact-tools");

/** Largest text/base64 payload returned inline by read_storage_item. */
export const READ_INLINE_MAX_BYTES = 1024 * 1024;
/** Largest image returned as an MCP image block (the model API's per-image ceiling). */
export const READ_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_BLOCK_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Run a handler body; a StorageError (or anything else) becomes the `{ error }` result. */
async function guard(what: string, fn: () => Promise<ToolCallResult> | ToolCallResult): Promise<ToolCallResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageError) return jsonError(err.message);
    log.error(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    return jsonError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Is this MIME type safe to decode as utf-8 text for the model? */
function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    [
      "application/xml",
      "application/javascript",
      "application/yaml",
      "application/toml",
      "application/jsonl",
      "application/x-ndjson",
      "image/svg+xml",
    ].includes(mimeType)
  );
}

const MB = (n: number) => `${n / 1024 / 1024}MB`;

export function buildStorageArtifactTools(): AnyToolDefinition[] {
  return [
    // ── Storage ─────────────────────────────────────────────────────

    defineTool(
      "list_storage_keys",
      "List the Callboard storage catalogue: every storage key (a named bucket of items) with its description, item count, total size and last update. " +
        "Storage is shared with the user — they browse the same keys in Settings → Storage.",
      {},
      async () => guard("list_storage_keys", () => jsonResult({ keys: listStorageKeys() })),
    ),

    defineTool(
      "create_storage_key",
      "Create a new, empty storage key (a named bucket for items). Errors if the key already exists. Keys are lowercase slugs: " +
        '^[a-z0-9][a-z0-9._-]{0,63}$ (e.g. "cramhouse-birds-of-europe").',
      {
        key: z.string().describe('The new key, e.g. "project-notes"'),
        description: z.string().optional().describe("What this key holds (shown in the catalogue)"),
      },
      async (args) => guard("create_storage_key", async () => jsonResult({ key: await createStorageKey(args.key, args.description) })),
    ),

    defineTool(
      "list_storage_items",
      "List the items in one storage key: name, MIME type, size, sha256 and last update.",
      { key: z.string().describe("The storage key") },
      async (args) => guard("list_storage_items", () => jsonResult({ key: args.key, items: listStorageItems(args.key) })),
    ),

    defineTool(
      "read_storage_item",
      `Read one storage item. Text, JSON and code come back as text (up to ${MB(READ_INLINE_MAX_BYTES)} inline); png/jpeg/gif/webp images come back ` +
        `as an image you can see (up to ${MB(READ_IMAGE_MAX_BYTES)}). Pass encoding "base64" for raw bytes (up to ${MB(READ_INLINE_MAX_BYTES)}), or "text" to force a ` +
        "utf-8 decode. The result always includes the item's absolute file_path, so anything larger can be read with your own tools or shown with render_file.",
      {
        key: z.string().describe("The storage key"),
        name: z.string().describe("The item name"),
        encoding: z
          .enum(["text", "base64"])
          .optional()
          .describe("Force utf-8 text or base64 bytes (default: text for textual items, an image block for images)"),
      },
      async (args) =>
        guard("read_storage_item", () => {
          // Caps are checked against the size of the file actually opened (fstat), not
          // meta: a concurrent overwrite between the two cannot slip a large item through.
          const { item, filePath, fd, size } = openStorageItem(args.key, args.name);
          try {
            const base = { key: args.key, ...item, size, file_path: filePath };
            const read = () => readFileSync(fd);

            if (!args.encoding && IMAGE_BLOCK_TYPES.has(item.mimeType)) {
              if (size > READ_IMAGE_MAX_BYTES) {
                return jsonResult({
                  ...base,
                  note: `Image is larger than ${MB(READ_IMAGE_MAX_BYTES)}; not returned inline. Use file_path (e.g. with render_file).`,
                });
              }
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(base) },
                  { type: "image" as const, data: read().toString("base64"), mimeType: item.mimeType },
                ],
              };
            }

            const encoding = args.encoding ?? (isTextual(item.mimeType) ? "text" : undefined);
            if (!encoding) {
              return jsonResult({ ...base, note: 'Binary item — content not returned. Pass encoding "base64" (≤1MB) or use file_path.' });
            }
            if (size > READ_INLINE_MAX_BYTES) {
              return jsonError(
                `Item is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${MB(READ_INLINE_MAX_BYTES)} inline limit — read it from file_path instead: ${filePath}`,
              );
            }
            const data = read();
            return jsonResult({ ...base, encoding, content: encoding === "base64" ? data.toString("base64") : data.toString("utf-8") });
          } finally {
            closeSync(fd);
          }
        }),
    ),

    defineTool(
      "save_storage_item",
      "Create or overwrite one item in a storage key. Provide exactly one source: content (utf-8 text), content_base64 (bytes), or source_path " +
        `(an absolute path to a local file — e.g. an image you downloaded). Item names: ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$, flat (no folders). ` +
        `Limits: ${MB(STORAGE_MAX_ITEM_BYTES)} per item, ${MB(STORAGE_MAX_KEY_BYTES)} per key, ${STORAGE_MAX_ITEMS_PER_KEY} items per key, ${MB(STORAGE_MAX_STORE_BYTES)} for the whole store. ` +
        "The MIME type is taken from mime_type, else the name's extension. Pass create_key: true to create a missing key.",
      {
        key: z.string().describe("The storage key"),
        name: z.string().describe('The item name, e.g. "deck.json" or "img-card-12.jpg"'),
        content: z.string().optional().describe("UTF-8 text content"),
        content_base64: z.string().optional().describe("Base64-encoded bytes"),
        source_path: z.string().optional().describe("Absolute path of a local file to copy in"),
        mime_type: z.string().optional().describe("Explicit MIME type (default: from the name's extension)"),
        create_key: z.boolean().optional().describe("Create the key if it does not exist (default false)"),
      },
      async (args) =>
        guard("save_storage_item", async () => {
          const sources = [args.content, args.content_base64, args.source_path].filter((v) => v !== undefined).length;
          if (sources !== 1) return jsonError("Provide exactly one of content, content_base64 or source_path");
          if (!args.create_key && !storageKeyExists(args.key)) {
            return jsonError(`Storage key not found: ${args.key} — create it with create_storage_key, or pass create_key: true`);
          }
          const opts = { mimeType: args.mime_type, createKey: args.create_key };
          const item =
            args.source_path !== undefined
              ? await saveStorageItemFromFile(args.key, args.name, args.source_path, opts)
              : await saveStorageItem(
                  args.key,
                  args.name,
                  args.content !== undefined ? Buffer.from(args.content, "utf-8") : decodeBase64Strict(args.content_base64!),
                  opts,
                );
          return jsonResult({ key: args.key, item });
        }),
    ),

    defineTool(
      "delete_storage_item",
      "Delete one item from a storage key.",
      {
        key: z.string().describe("The storage key"),
        name: z.string().describe("The item name"),
      },
      async (args) =>
        guard("delete_storage_item", async () => {
          await deleteStorageItem(args.key, args.name);
          return jsonResult({ success: true, key: args.key, name: args.name });
        }),
    ),

    defineTool(
      "delete_storage_key",
      "Delete a storage key AND every item in it. Irreversible. Requires confirm: true.",
      {
        key: z.string().describe("The storage key to delete"),
        confirm: z.boolean().describe("Must be true — acknowledges that every item in the key is deleted"),
      },
      async (args) =>
        guard("delete_storage_key", async () => {
          if (args.confirm !== true) return jsonError("Refusing to delete: pass confirm: true to delete the key and all its items");
          await deleteStorageKey(args.key);
          return jsonResult({ success: true, key: args.key });
        }),
    ),

    // ── Artifacts ───────────────────────────────────────────────────

    defineTool(
      "list_artifacts",
      "List Callboard artifacts: named, versioned, reusable single-file HTML apps, SVGs and markdown documents. Each has a stable id, a content type, " +
        "the storage access it may be granted, and its current version.",
      {},
      async () => guard("list_artifacts", () => jsonResult({ artifacts: listArtifacts() })),
    ),

    defineTool(
      "read_artifact",
      "Read an artifact's source (the current version by default) plus its metadata and version list.",
      {
        id: z.string().describe("The artifact id"),
        version: z.number().int().positive().optional().describe("A specific version (default: current)"),
      },
      async (args) =>
        guard("read_artifact", () => {
          const { artifact, version, content } = readArtifactVersion(args.id, args.version);
          return jsonResult({ artifact, version: version.version, note: version.note, content });
        }),
    ),

    defineTool(
      "save_artifact",
      "Create an artifact, or save a new immutable version of an existing one. An artifact is a single-file HTML app (inline CSS/JS), an SVG, or a markdown " +
        "document, rendered in chat with render_artifact. HTML artifacts run in a sandbox that cannot fetch/XHR or load any remote resource; their only data " +
        "source is window.callboard.storage — list(), read(name, {as: 'text'|'json'|'dataUrl'}), write(name, data, {mimeType}), delete(name) — scoped to the ONE " +
        "storage key bound at render time (await window.callboard.ready first; it resolves to {storageKey, access}, or unbound with a reason if the host " +
        "never answers within 10s, e.g. after navigating back into the frame). Storage calls are rate-limited host-side by ONE budget for the whole " +
        "browser tab — 105 requests a minute with a burst of 20 — divided evenly between the renders making requests (each has its own share, which no other " +
        "render can spend), and at most 4 in flight per render (the shim queues the rest). A call costs 1, and re-checking the artifact's access costs 1 more " +
        "at most once per 2 s for writes/deletes and once per 5 s for reads (split between the renders of the artifact). So a render that is the only busy " +
        "one in the tab can sustain ~75 writes or ~93 reads a minute (1 write/s fits; a load-time burst of ~15 calls fits), but beside N other busy renders it " +
        "gets 1/(N+1) of that: ~35 writes a minute beside one, ~13 beside three — design for the shared case. A render calling less often than its share " +
        "allows (a refresh every 10–30 s, say) is never refused for it: a call that finds the share empty is answered late, up to 10 s, instead. Past its share a call rejects with an error " +
        "starting 'rate limited', and the render's next calls wait until its share refills — load data once and keep it in memory rather than polling. Images must come from storage " +
        "as data URLs (image/* items, SVG included, come back typed for <img>). The sandbox is not a data-loss barrier: a determined artifact can still " +
        "leak what it can read (by navigating its frame, or WebRTC), so granting read on a key means the artifact's author can read that key. The " +
        "artifact's JS runs in the page's process: an infinite loop freezes the whole Callboard tab (as with canvases), every time the chat is opened. Ids: ^[a-z0-9][a-z0-9-]{0,63}$. name and content_type are required on create; content_type cannot change later. " +
        "storage_access (none|read|readwrite, default none) is the MOST the artifact may ever be granted. Source ≤5MB; the last 50 versions are kept.",
      {
        id: z.string().describe('The artifact id, e.g. "cramhouse"'),
        content: z.string().optional().describe("Full source (HTML, SVG or markdown)"),
        source_path: z.string().optional().describe("Absolute path of a local file holding the full source"),
        name: z.string().optional().describe("Display name (required on create)"),
        description: z.string().optional().describe("What the artifact is for"),
        content_type: z.enum(ARTIFACT_CONTENT_TYPES).optional().describe("html, svg or markdown (create only)"),
        storage_access: z.enum(ARTIFACT_STORAGE_ACCESS).optional().describe("Maximum storage access: none, read or readwrite"),
        note: z.string().optional().describe("What changed in this version"),
      },
      async (args) =>
        guard("save_artifact", async () => {
          if ((args.content === undefined) === (args.source_path === undefined)) return jsonError("Provide exactly one of content or source_path");
          const input = {
            id: args.id,
            name: args.name,
            description: args.description,
            contentType: args.content_type,
            storageAccess: args.storage_access,
            note: args.note,
          };
          const result =
            args.source_path !== undefined
              ? await saveArtifactFromFile({ ...input, sourcePath: args.source_path })
              : await saveArtifact({ ...input, content: args.content! });
          const { versions: _versions, ...artifact } = result.artifact;
          return jsonResult({ created: result.created, artifact, version: result.version });
        }),
    ),

    defineTool(
      "delete_artifact",
      "Delete an artifact and all its versions. Irreversible. Requires confirm: true. Storage keys it was used with are not touched.",
      {
        id: z.string().describe("The artifact id"),
        confirm: z.boolean().describe("Must be true"),
      },
      async (args) =>
        guard("delete_artifact", async () => {
          if (args.confirm !== true) return jsonError("Refusing to delete: pass confirm: true to delete the artifact and all its versions");
          await deleteArtifact(args.id);
          return jsonResult({ success: true, id: args.id });
        }),
    ),

    defineTool(
      "render_artifact",
      "Render an artifact in the chat UI. HTML runs in a sandboxed frame that cannot fetch or load remote resources; SVG shows as an image; markdown is " +
        "rendered as a document. Pass storage_key to bind ONE existing storage key to this render: the artifact then reads (and, if its storage_access is " +
        "readwrite, writes) that key's items through window.callboard.storage. Binding requires the artifact's storage_access to be read or readwrite; each " +
        "time the render is shown it is granted at most the artifact's CURRENT storage_access, and nothing if that version has since been deleted or replaced; " +
        "while it is shown, lowering the artifact's storage_access or deleting it takes effect at the next write (and within seconds for reads). " +
        "Every render bound to a key is an independent live instance: two chat bubbles bound readwrite to the same key do not see each other's writes " +
        "until reloaded, and the last write wins — render once and reuse that bubble rather than stacking several live copies.",
      {
        id: z.string().describe("The artifact id"),
        version: z.number().int().positive().optional().describe("A specific version (default: current)"),
        storage_key: z.string().optional().describe("An existing storage key to bind to this render"),
        caption: z.string().optional().describe("Optional caption shown below the artifact"),
        display_mode: z.enum(["inline", "fullscreen"]).optional().describe("inline = compact view in chat flow; fullscreen = expanded modal view"),
      },
      async (args) =>
        guard("render_artifact", () => {
          const artifact = getArtifact(args.id);
          const version = args.version ?? artifact.currentVersion;
          const pinned = artifact.versions.find((v) => v.version === version);
          if (!pinned) {
            return jsonError(`Version ${version} of artifact "${args.id}" not found (kept versions: ${artifact.versions.map((v) => v.version).join(", ")})`);
          }
          if (args.storage_key !== undefined) {
            if (artifact.storageAccess === "none") {
              return jsonError(
                `Artifact "${args.id}" has storage_access "none" and cannot be bound to a storage key — save it with storage_access read or readwrite first`,
              );
            }
            if (!storageKeyExists(args.storage_key)) return jsonError(`Storage key not found: ${args.storage_key}`);
          }
          const result: RenderArtifactToolResult = {
            type: "render_artifact",
            artifact_id: artifact.id,
            version,
            // Pins the render to these exact bytes: the host refuses to bind storage if the version later differs (deleted + recreated) or is gone.
            sha256: pinned.sha256,
            name: artifact.name,
            content_type: artifact.contentType,
            ...(args.storage_key !== undefined ? { storage_key: args.storage_key } : {}),
            // The ceiling for this render: the artifact's declared access when bound, nothing when not.
            // The host re-reads the artifact on every mount and grants the lesser of this and the then-current declared access.
            storage_access: args.storage_key !== undefined ? artifact.storageAccess : "none",
            ...(args.caption ? { caption: args.caption } : {}),
            ...(args.display_mode ? { display_mode: args.display_mode } : {}),
          };
          return jsonResult(result);
        }),
    ),
  ];
}
