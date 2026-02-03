import { v4 as uuid } from 'uuid';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = join(__dirname, '..', '..', 'data', 'images');

// Ensure images directory exists
mkdirSync(IMAGES_DIR, { recursive: true });

export interface StoredImage {
  id: string;
  filename: string;
  originalName: string;
  storedAs: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  storagePath: string;
}

export interface ImageUploadResult {
  success: boolean;
  image?: StoredImage;
  error?: string;
}

const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp'
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export class ImageStorageService {
  /**
   * Store an uploaded image file
   */
  static async storeImage(
    buffer: Buffer,
    originalName: string,
    mimeType: string
  ): Promise<ImageUploadResult> {
    try {
      // Validate file type
      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return {
          success: false,
          error: `Invalid file type: ${mimeType}. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
        };
      }

      // Validate file size
      if (buffer.length > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`
        };
      }

      // Generate SHA256 hash for deduplication
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      // Generate unique filename
      const id = uuid();
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
        storagePath
      };

      return {
        success: true,
        image
      };

    } catch (error) {
      return {
        success: false,
        error: `Failed to store image: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Retrieve an image by ID
   */
  static getImage(imageId: string): { buffer: Buffer; image: StoredImage } | null {
    try {
      // Find the image file - for now we'll scan the directory
      // In a production app, you'd want to store metadata in a database
      console.log(`[DEBUG] getImage called with imageId: ${imageId}`);
      console.log(`[DEBUG] Looking in directory: ${IMAGES_DIR}`);
      const files = readdirSync(IMAGES_DIR);
      console.log(`[DEBUG] All files in directory:`, files);
      const imageFile = files.find((f: string) => f.startsWith(imageId));
      console.log(`[DEBUG] Found matching file:`, imageFile);

      if (!imageFile) {
        console.log(`[DEBUG] No file found starting with ${imageId}`);
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
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        uploadedAt: stats.birthtime.toISOString(),
        storagePath: imagePath
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
   * Get file extension from MIME type
   */
  private static getExtensionFromMimeType(mimeType: string): string {
    const mapping: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp'
    };
    return mapping[mimeType] || '.bin';
  }

  /**
   * Get MIME type from file extension
   */
  private static getMimeTypeFromExtension(ext: string): string {
    const mapping: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    return mapping[ext.toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Get images directory path
   */
  static getImagesDir(): string {
    return IMAGES_DIR;
  }
}