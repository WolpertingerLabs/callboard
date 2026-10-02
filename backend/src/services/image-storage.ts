import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import crypto from "crypto";
import type { StoredImage, ImageUploadResult } from "shared/types/index.js";
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

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export class ImageStorageService {
  /**
   * Store an uploaded image file
   */
  static async storeImage(buffer: Buffer, originalName: string, mimeType: string): Promise<ImageUploadResult> {
    try {
      // Validate file type
      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return {
          success: false,
          error: `Invalid file type: ${mimeType}. Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
        };
      }

      // Validate file size
      if (buffer.length > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`,
        };
      }

      // Generate SHA256 hash for deduplication
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

      // Generate unique filename
      const id = randomUUID();
      const ext = extname(originalName) || this.getExtensionFromMimeType(mimeType);
      const storedAs = `${id}${ext}`;
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
      const image: StoredImage = {
        id: imageId,
        filename: imageFile,
        originalName: imageFile,
        storedAs: imageFile,
        mimeType: this.getMimeTypeFromExtension(extname(imageFile)),
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
   * Load image buffers for a list of image IDs.
   * Returns an array of { buffer, mimeType, storagePath } for successfully loaded images.
   * Logs errors for individual failures without throwing.
   */
  static loadImageBuffers(imageIds: string[]): { buffer: Buffer; mimeType: string; storagePath: string }[] {
    const results: { buffer: Buffer; mimeType: string; storagePath: string }[] = [];
    for (const imageId of imageIds) {
      try {
        const result = ImageStorageService.getImage(imageId);
        if (result) {
          results.push({
            buffer: result.buffer,
            mimeType: result.image.mimeType,
            storagePath: result.image.storagePath || join(IMAGES_DIR, result.image.storedAs || result.image.filename),
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
      try {
        indexImage(crypto.createHash("sha256").update(readFileSync(join(IMAGES_DIR, file))).digest("hex"), file);
      } catch {}
    }
  }
  return hashIndex;
}

/** The first indexed file with these bytes that is still on disk. */
function findImageByHash(sha256: string): string | undefined {
  const files = (hashIndex ?? buildHashIndex()).get(sha256) ?? [];
  for (const file of [...files]) {
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
