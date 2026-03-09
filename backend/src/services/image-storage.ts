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

function isValidImageId(imageId: string): boolean {
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
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Load image buffers for a list of image IDs.
   * Returns an array of { buffer, mimeType } for successfully loaded images.
   * Logs errors for individual failures without throwing.
   */
  static loadImageBuffers(imageIds: string[]): { buffer: Buffer; mimeType: string }[] {
    const results: { buffer: Buffer; mimeType: string }[] = [];
    for (const imageId of imageIds) {
      try {
        const result = ImageStorageService.getImage(imageId);
        if (result) {
          results.push({
            buffer: result.buffer,
            mimeType: result.image.mimeType,
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

/** Convenience re-export of ImageStorageService.loadImageBuffers for direct import. */
export const loadImageBuffers = ImageStorageService.loadImageBuffers.bind(ImageStorageService);
