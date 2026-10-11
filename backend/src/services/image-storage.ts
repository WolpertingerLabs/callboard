import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import crypto from "crypto";
import type { StoredImage, ImageUploadResult } from "shared/types/index.js";
import { isImageAttachmentType, maxAttachmentBytes, safeFileName } from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";

export type { StoredImage, ImageUploadResult };

const IMAGES_DIR = join(DATA_DIR, "images");

// Ensure images directory exists
mkdirSync(IMAGES_DIR, { recursive: true });

// UUID v4 format: 8-4-4-4-12 hex characters
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidImageId(imageId: string): boolean {
  return UUID_REGEX.test(imageId);
}

/**
 * Stored name of a non-image attachment: `<id>_<name>`. Images are stored as
 * `<id><ext>`; the `_` straight after the id is what tells the two apart on
 * read. The name is kept so the path an agent is handed still says what the
 * file is, and reduced to characters that need no quoting in a shell.
 */
const FILE_NAME_SEPARATOR = "_";
const UUID_LENGTH = 36;

// The name itself is reduced by `safeFileName` in shared/types/attachment.ts,
// which the UI also uses to recognise its own uploads in a transcript.
export { safeFileName };

/** The original-ish name of a non-image attachment's stored file, or null for an image. */
function attachmentNameOf(storedAs: string): string | null {
  return storedAs[UUID_LENGTH] === FILE_NAME_SEPARATOR ? storedAs.slice(UUID_LENGTH + 1) : null;
}

/**
 * Names of the file attachments among `imageIds`, in order, from the stored
 * file names alone: one directory listing, no file read. Images and unknown
 * ids contribute nothing.
 */
export function attachmentNamesOf(imageIds: string[]): string[] {
  return storedFilesOf(imageIds).flatMap((file) => {
    const name = attachmentNameOf(file);
    return name === null ? [] : [name];
  });
}

/** Whether any of `imageIds` is a stored upload. One directory listing, no file read. */
export function anyUploadExists(imageIds: string[]): boolean {
  return storedFilesOf(imageIds).length > 0;
}

/** The stored file of each id that has one, in order. */
function storedFilesOf(imageIds: string[]): string[] {
  try {
    const files = readdirSync(IMAGES_DIR);
    return imageIds.flatMap((id) => {
      const file = typeof id === "string" && isValidImageId(id) ? files.find((f) => f.startsWith(id)) : undefined;
      return file === undefined ? [] : [file];
    });
  } catch {
    return [];
  }
}

/** One stored upload, ready for the prompt. `name` is set only for non-image attachments. */
export interface LoadedUpload {
  id: string;
  buffer: Buffer;
  mimeType: string;
  storagePath: string;
  name?: string;
}

export class ImageStorageService {
  /**
   * Store an uploaded file. Images become image content blocks when sent; any
   * other type is stored under its name and attached to the prompt as text
   * (see shared/types/attachment.ts).
   */
  static async storeImage(buffer: Buffer, originalName: string, mimeType: string): Promise<ImageUploadResult> {
    try {
      const maxBytes = maxAttachmentBytes(mimeType);
      if (buffer.length > maxBytes) {
        return {
          success: false,
          error: `${originalName} exceeds the ${maxBytes / 1024 / 1024}MB limit`,
        };
      }

      // Generate SHA256 hash for deduplication
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

      // Generate unique filename
      const id = randomUUID();
      const storedAs = isImageAttachmentType(mimeType)
        ? `${id}${extname(originalName) || this.getExtensionFromMimeType(mimeType)}`
        : `${id}${FILE_NAME_SEPARATOR}${safeFileName(originalName)}`;
      const storagePath = join(IMAGES_DIR, storedAs);

      // Check for existing file with same hash (optional deduplication)
      // For now, we'll store each upload separately for simplicity

      // Write file to disk
      writeFileSync(storagePath, buffer);
      indexImage(sha256, storedAs);

      const image: StoredImage = {
        id,
        filename: storedAs,
        originalName,
        storedAs,
        mimeType,
        size: buffer.length,
        sha256,
        uploadedAt: new Date().toISOString(),
        storagePath,
      };

      return {
        success: true,
        image,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to store image: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Retrieve an image by ID
   */
  static getImage(imageId: string): { buffer: Buffer; image: StoredImage } | null {
    try {
      // Validate image ID is a proper UUID to prevent directory traversal
      if (!isValidImageId(imageId)) {
        return null;
      }

      const files = readdirSync(IMAGES_DIR);
      const imageFile = files.find((f: string) => f.startsWith(imageId));

      if (!imageFile) {
        return null;
      }

      const imagePath = join(IMAGES_DIR, imageFile);
      if (!existsSync(imagePath)) return null;

      const buffer = readFileSync(imagePath);
      const stats = statSync(imagePath);

      // Reconstruct image metadata (in production, store this in DB)
      const attachmentName = attachmentNameOf(imageFile);
      const image: StoredImage = {
        id: imageId,
        filename: imageFile,
        originalName: attachmentName ?? imageFile,
        storedAs: imageFile,
        // A file attachment never reads back as an image, whatever its
        // extension: it was not one of the image types when it was uploaded.
        mimeType: attachmentName === null ? this.getMimeTypeFromExtension(extname(imageFile)) : this.getFileMimeTypeFromExtension(extname(imageFile)),
        size: stats.size,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        uploadedAt: stats.birthtime.toISOString(),
        storagePath: imagePath,
      };

      return { buffer, image };
    } catch {
      return null;
    }
  }

  /**
   * Delete an image by ID
   */
  static deleteImage(imageId: string): boolean {
    try {
      // Validate image ID is a proper UUID to prevent directory traversal
      if (!isValidImageId(imageId)) {
        return false;
      }

      const files = readdirSync(IMAGES_DIR);
      const imageFile = files.find((f: string) => f.startsWith(imageId));

      if (!imageFile) return false;

      const imagePath = join(IMAGES_DIR, imageFile);
      if (existsSync(imagePath)) {
        unlinkSync(imagePath);
        unindexImage(imageFile);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Load stored uploads — images and file attachments alike — for a list of IDs.
   * Logs errors for individual failures without throwing.
   */
  static loadImageBuffers(imageIds: string[]): LoadedUpload[] {
    const results: LoadedUpload[] = [];
    for (const imageId of imageIds) {
      try {
        const result = ImageStorageService.getImage(imageId);
        if (result) {
          const name = attachmentNameOf(result.image.filename);
          results.push({
            id: imageId,
            buffer: result.buffer,
            mimeType: result.image.mimeType,
            storagePath: result.image.storagePath || join(IMAGES_DIR, result.image.storedAs || result.image.filename),
            ...(name !== null && { name }),
          });
        }
      } catch (error) {
        console.error(`Failed to load image ${imageId}:`, error);
      }
    }
    return results;
  }

  /**
   * Get file extension from MIME type
   */
  private static getExtensionFromMimeType(mimeType: string): string {
    const mapping: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
    };
    return mapping[mimeType] || ".bin";
  }

  /**
   * Get MIME type from file extension
   */
  private static getMimeTypeFromExtension(ext: string): string {
    const mapping: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    return mapping[ext.toLowerCase()] || "application/octet-stream";
  }

  /**
   * MIME type of a non-image attachment, for the prompt's description of it
   * and the GET route's Content-Type. Never an image type, and never a type a
   * browser renders or executes: `.html`, `.svg`, `.js`, `.css` and the like
   * are plain text, so an upload cannot pass for a same-origin page, script
   * or stylesheet. (The route also sends nosniff, a sandbox CSP and an
   * attachment disposition.)
   */
  private static getFileMimeTypeFromExtension(ext: string): string {
    const mapping: Record<string, string> = {
      ".txt": "text/plain",
      ".log": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".tsv": "text/tab-separated-values",
      ".json": "application/json",
      ".yaml": "application/yaml",
      ".yml": "application/yaml",
      ".toml": "application/toml",
      ".xml": "text/plain",
      ".html": "text/plain",
      ".htm": "text/plain",
      ".svg": "text/plain",
      ".js": "text/plain",
      ".mjs": "text/plain",
      ".ts": "text/plain",
      ".tsx": "text/plain",
      ".jsx": "text/plain",
      ".py": "text/x-python",
      ".sh": "application/x-sh",
      ".css": "text/plain",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    return mapping[ext.toLowerCase()] || "application/octet-stream";
  }
}

// sha256 → files in IMAGES_DIR with those bytes, in readdir order (then write
// order). Built on the first storeBase64Image call — one read+hash of every
// file — and kept current by every write and delete in this module, so later
// lookups are O(1) instead of a rescan of the whole directory.
let hashIndex: Map<string, string[]> | null = null;
const fileHashes = new Map<string, string>();

function indexImage(sha256: string, file: string): void {
  if (!hashIndex) return; // Picked up by the build, whenever it happens.
  const files = hashIndex.get(sha256) ?? [];
  if (!files.includes(file)) files.push(file);
  hashIndex.set(sha256, files);
  fileHashes.set(file, sha256);
}

function unindexImage(file: string): void {
  const sha256 = fileHashes.get(file);
  if (!hashIndex || sha256 === undefined) return;
  fileHashes.delete(file);
  const files = hashIndex.get(sha256)?.filter((f) => f !== file) ?? [];
  if (files.length) hashIndex.set(sha256, files);
  else hashIndex.delete(sha256);
}

function buildHashIndex(): Map<string, string[]> {
  hashIndex = new Map();
  fileHashes.clear();
  if (existsSync(IMAGES_DIR)) {
    for (const file of readdirSync(IMAGES_DIR)) {
      // findImageByHash skips file attachments, so there is no point reading
      // and hashing them (up to 25 MB each). Ones stored later are still
      // indexed by storeImage, and skipped on lookup.
      if (attachmentNameOf(file) !== null) continue;
      try {
        indexImage(crypto.createHash("sha256").update(readFileSync(join(IMAGES_DIR, file))).digest("hex"), file);
      } catch {}
    }
  }
  return hashIndex;
}

/**
 * The first indexed image with these bytes that is still on disk. File
 * attachments are skipped: an id found here goes into a transcript as an image.
 */
function findImageByHash(sha256: string): string | undefined {
  const files = (hashIndex ?? buildHashIndex()).get(sha256) ?? [];
  for (const file of [...files]) {
    if (attachmentNameOf(file) !== null) continue;
    if (existsSync(join(IMAGES_DIR, file))) return file;
    unindexImage(file); // Removed behind our back.
  }
  return undefined;
}

/**
 * Store an image from base64 data (e.g. extracted from session log).
 * Uses SHA256 dedup: if an image with the same hash already exists on disk,
 * returns the existing ID without writing a new file.
 */
export function storeBase64Image(base64Data: string, mimeType: string): string | null {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    const existing = findImageByHash(sha256);
    if (existing) return existing.split(".")[0];

    // Not found — store it
    const id = randomUUID();
    const ext = ImageStorageService["getExtensionFromMimeType"](mimeType);
    const storedAs = `${id}${ext}`;
    mkdirSync(IMAGES_DIR, { recursive: true });
    writeFileSync(join(IMAGES_DIR, storedAs), buffer);
    indexImage(sha256, storedAs);
    return id;
  } catch {
    return null;
  }
}

/** Convenience re-export of ImageStorageService.loadImageBuffers for direct import. */
export const loadImageBuffers = ImageStorageService.loadImageBuffers.bind(ImageStorageService);
