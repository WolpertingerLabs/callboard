import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  statSync,
} from "fs";
import path from "path";
import { join, extname } from "path";
import { DATA_DIR } from "../utils/paths.js";

// ── Constants ────────────────────────────────────────────────────────

const CANVAS_DIR = join(DATA_DIR, "canvas");
mkdirSync(CANVAS_DIR, { recursive: true });

const CANVAS_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_STRING_CONTENT = 5 * 1024 * 1024; // 5MB
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

const CONTENT_TYPE_EXT: Record<string, string> = {
  html: ".html",
  svg: ".svg",
  image: ".png", // default for image; overridden by file_path extension
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

// ── Types ────────────────────────────────────────────────────────────

interface VersionEntry {
  version: number;
  created: string;
  description?: string;
  ext: string; // file extension including dot, e.g. ".html"
}

interface CanvasMeta {
  id: string;
  name: string;
  contentType: "html" | "svg" | "image";
  currentVersion: number;
  created: string;
  updated: string;
  versions: VersionEntry[];
}

export interface CreateCanvasArgs {
  name: string;
  content?: string;
  file_path?: string;
  content_type: "html" | "svg" | "image";
}

export interface UpdateCanvasArgs {
  canvas_id: string;
  content?: string;
  file_path?: string;
  description?: string;
}

export interface CanvasResult {
  canvas_id: string;
  version: number;
  name: string;
  content_type: string;
  description?: string;
}

export interface CanvasContent {
  canvas_id: string;
  version: number;
  name: string;
  content_type: string;
  content?: string;
  file_size?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateCanvasId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function canvasDir(id: string): string {
  return join(CANVAS_DIR, id);
}

function snapshotsDir(id: string): string {
  return join(canvasDir(id), "snapshots");
}

function metaPath(id: string): string {
  return join(canvasDir(id), "meta.json");
}

function readMeta(id: string): CanvasMeta {
  return JSON.parse(readFileSync(metaPath(id), "utf-8"));
}

function writeMeta(id: string, meta: CanvasMeta): void {
  writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
}

function validateCanvasId(id: string): string | null {
  if (!id || !CANVAS_ID_REGEX.test(id)) return "Invalid canvas_id";
  if (!existsSync(canvasDir(id))) return `Canvas not found: ${id}`;
  return null;
}

// ── Public API ───────────────────────────────────────────────────────

export function createCanvas(args: CreateCanvasArgs): { error?: string; result?: CanvasResult } {
  const { name, content, file_path, content_type } = args;

  // Validate exactly one source
  if (!content && !file_path) return { error: "Provide either content or file_path" };
  if (content && file_path) return { error: "Provide either content or file_path, not both" };

  // Validate image requires file_path
  if (content_type === "image" && !file_path) {
    return { error: "content_type 'image' requires file_path, not content" };
  }

  // Determine extension
  let ext: string;
  if (file_path) {
    ext = extname(file_path).toLowerCase() || CONTENT_TYPE_EXT[content_type];
    // Validate file
    const fileErr = validateFilePath(file_path);
    if (fileErr) return { error: fileErr };
  } else {
    ext = CONTENT_TYPE_EXT[content_type];
    if (content!.length > MAX_STRING_CONTENT) {
      return { error: `Content too large (${(content!.length / 1024 / 1024).toFixed(1)}MB, max 5MB)` };
    }
  }

  // Create canvas directory structure
  const id = generateCanvasId();
  mkdirSync(snapshotsDir(id), { recursive: true });

  // Write first snapshot
  const snapshotFile = join(snapshotsDir(id), `1${ext}`);
  if (file_path) {
    copyFileSync(file_path, snapshotFile);
  } else {
    writeFileSync(snapshotFile, content!, "utf-8");
  }

  // Write metadata
  const now = new Date().toISOString();
  const meta: CanvasMeta = {
    id,
    name,
    contentType: content_type,
    currentVersion: 1,
    created: now,
    updated: now,
    versions: [{ version: 1, created: now, ext }],
  };
  writeMeta(id, meta);

  return {
    result: { canvas_id: id, version: 1, name, content_type },
  };
}

export function updateCanvas(args: UpdateCanvasArgs): { error?: string; result?: CanvasResult } {
  const { canvas_id, content, file_path, description } = args;

  // Validate canvas exists
  const idErr = validateCanvasId(canvas_id);
  if (idErr) return { error: idErr };

  // Validate exactly one source
  if (!content && !file_path) return { error: "Provide either content or file_path" };
  if (content && file_path) return { error: "Provide either content or file_path, not both" };

  const meta = readMeta(canvas_id);

  // Determine extension
  let ext: string;
  if (file_path) {
    ext = extname(file_path).toLowerCase() || CONTENT_TYPE_EXT[meta.contentType];
    const fileErr = validateFilePath(file_path);
    if (fileErr) return { error: fileErr };
  } else {
    ext = CONTENT_TYPE_EXT[meta.contentType];
    if (content!.length > MAX_STRING_CONTENT) {
      return { error: `Content too large (${(content!.length / 1024 / 1024).toFixed(1)}MB, max 5MB)` };
    }
  }

  // Write new snapshot
  const newVersion = meta.currentVersion + 1;
  const snapshotFile = join(snapshotsDir(canvas_id), `${newVersion}${ext}`);
  if (file_path) {
    copyFileSync(file_path, snapshotFile);
  } else {
    writeFileSync(snapshotFile, content!, "utf-8");
  }

  // Update metadata
  const now = new Date().toISOString();
  meta.currentVersion = newVersion;
  meta.updated = now;
  meta.versions.push({ version: newVersion, created: now, description, ext });
  writeMeta(canvas_id, meta);

  return {
    result: {
      canvas_id,
      version: newVersion,
      name: meta.name,
      content_type: meta.contentType,
      description,
    },
  };
}

export function readCanvas(
  canvasId: string,
  version?: number,
): { error?: string; result?: CanvasContent } {
  const idErr = validateCanvasId(canvasId);
  if (idErr) return { error: idErr };

  const meta = readMeta(canvasId);
  const targetVersion = version ?? meta.currentVersion;

  const versionEntry = meta.versions.find((v) => v.version === targetVersion);
  if (!versionEntry) return { error: `Version ${targetVersion} not found` };

  const snapshotFile = join(snapshotsDir(canvasId), `${targetVersion}${versionEntry.ext}`);
  if (!existsSync(snapshotFile)) return { error: `Snapshot file missing for version ${targetVersion}` };

  const stat = statSync(snapshotFile);

  // For text-based content, return the content string
  if (meta.contentType === "html" || meta.contentType === "svg") {
    return {
      result: {
        canvas_id: canvasId,
        version: targetVersion,
        name: meta.name,
        content_type: meta.contentType,
        content: readFileSync(snapshotFile, "utf-8"),
      },
    };
  }

  // For binary content (images), return metadata only
  return {
    result: {
      canvas_id: canvasId,
      version: targetVersion,
      name: meta.name,
      content_type: meta.contentType,
      file_size: stat.size,
    },
  };
}

/**
 * Get canvas metadata without reading content.
 */
export function getCanvasMeta(canvasId: string): { error?: string; meta?: CanvasMeta } {
  const idErr = validateCanvasId(canvasId);
  if (idErr) return { error: idErr };
  return { meta: readMeta(canvasId) };
}

/**
 * Resolve the snapshot file path and MIME type for serving.
 */
export function resolveSnapshot(
  canvasId: string,
  version: number,
): { error?: string; filePath?: string; mimeType?: string } {
  const idErr = validateCanvasId(canvasId);
  if (idErr) return { error: idErr };

  const meta = readMeta(canvasId);
  const versionEntry = meta.versions.find((v) => v.version === version);
  if (!versionEntry) return { error: `Version ${version} not found` };

  const snapshotFile = join(snapshotsDir(canvasId), `${version}${versionEntry.ext}`);
  if (!existsSync(snapshotFile)) return { error: `Snapshot file missing` };

  // Determine MIME type
  let mimeType: string;
  if (meta.contentType === "html") {
    mimeType = "text/html; charset=utf-8";
  } else if (meta.contentType === "svg") {
    mimeType = "image/svg+xml";
  } else {
    mimeType = IMAGE_MIME[versionEntry.ext] || "application/octet-stream";
  }

  return { filePath: snapshotFile, mimeType };
}

// ── Internal Helpers ─────────────────────────────────────────────────

function validateFilePath(filePath: string): string | null {
  if (!path.isAbsolute(filePath)) return "file_path must be an absolute path";
  if (filePath.includes("\0")) return "Invalid file path";

  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) return `File not found: ${resolved}`;


  const stat = statSync(resolved);
  if (!stat.isFile()) return "Path is not a regular file";
  if (stat.size > MAX_FILE_SIZE) {
    return `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`;
  }

  return null;
}
