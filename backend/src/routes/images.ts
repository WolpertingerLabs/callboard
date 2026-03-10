import { Router } from "express";
import multer from "multer";
import { ImageStorageService, type StoredImage } from "../services/image-storage.js";
import { chatFileService } from "../services/chat-file-service.js";
import { updateChatWithImages } from "../services/image-metadata.js";

export const imagesRouter = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 10, // Max 10 files per request
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`));
    }
  },
});

/**
 * Upload images for a chat
 * POST /api/chats/:chatId/images
 */
imagesRouter.post("/:chatId/images", upload.array("images", 10), async (req, res) => {
  // #swagger.tags = ['Images']
  // #swagger.summary = 'Upload images for a chat'
  // #swagger.description = 'Upload up to 10 images (max 10MB each) for a chat. Accepts PNG, JPEG, GIF, and WebP. Uses multipart/form-data with field name "images".'
  /* #swagger.parameters['chatId'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            images: { type: "array", items: { type: "string", format: "binary" } }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Upload results with image metadata and any errors" } */
  /* #swagger.responses[400] = { description: "No images provided" } */
  const { chatId } = req.params;
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No images provided" });
  }

  try {
    const uploadResults: StoredImage[] = [];
    const errors: string[] = [];

    // Process each uploaded file
    for (const file of files) {
      const result = await ImageStorageService.storeImage(file.buffer, file.originalname, file.mimetype);

      if (result.success && result.image) {
        uploadResults.push(result.image);
      } else {
        errors.push(result.error || "Unknown error");
      }
    }

    // Store image metadata in chat metadata
    if (uploadResults.length > 0) {
      await updateChatWithImages(chatId, uploadResults);
    }

    res.json({
      success: true,
      images: uploadResults,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Image upload error:", error);
    res.status(500).json({
      error: "Failed to upload images",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Upload images without associating them to a chat (e.g. for new chat creation).
 * POST /api/images/upload
 */
imagesRouter.post("/upload", upload.array("images", 10), async (req, res) => {
  // #swagger.tags = ['Images']
  // #swagger.summary = 'Upload images (no chat required)'
  // #swagger.description = 'Upload up to 10 images (max 10MB each) without associating them to a chat. Returns image IDs that can be passed to /new/message. Accepts PNG, JPEG, GIF, and WebP via multipart/form-data with field name "images".'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            images: { type: "array", items: { type: "string", format: "binary" } }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Upload results with image metadata and any errors" } */
  /* #swagger.responses[400] = { description: "No images provided" } */
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No images provided" });
  }

  try {
    const uploadResults: StoredImage[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const result = await ImageStorageService.storeImage(file.buffer, file.originalname, file.mimetype);

      if (result.success && result.image) {
        uploadResults.push(result.image);
      } else {
        errors.push(result.error || "Unknown error");
      }
    }

    res.json({
      success: true,
      images: uploadResults,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Image upload error:", error);
    res.status(500).json({
      error: "Failed to upload images",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Get an image by ID
 * GET /api/images/:imageId
 */
imagesRouter.get("/:imageId", (req, res) => {
  // #swagger.tags = ['Images']
  // #swagger.summary = 'Get an image by ID'
  // #swagger.description = 'Retrieve an image file by its ID. Returns the raw image binary with appropriate Content-Type. Supports ETag-based caching.'
  /* #swagger.parameters['imageId'] = { in: 'path', required: true, type: 'string', description: 'Image ID' } */
  /* #swagger.responses[200] = { description: "Image binary" } */
  /* #swagger.responses[304] = { description: "Not modified (client has cached version)" } */
  /* #swagger.responses[404] = { description: "Image not found" } */
  const { imageId } = req.params;

  try {
    const result = ImageStorageService.getImage(imageId);

    if (!result) {
      return res.status(404).json({ error: "Image not found" });
    }

    const { buffer, image } = result;

    // Set appropriate headers
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "public, max-age=31536000"); // 1 year cache
    res.setHeader("ETag", `"${image.sha256}"`);

    // Check if client has cached version
    const clientETag = req.headers["if-none-match"];
    if (clientETag === `"${image.sha256}"`) {
      return res.status(304).end();
    }

    res.end(buffer);
  } catch (error) {
    console.error("Image retrieval error:", error);
    res.status(500).json({ error: "Failed to retrieve image" });
  }
});

/**
 * Delete an image by ID
 * DELETE /api/images/:imageId
 */
imagesRouter.delete("/:imageId", async (req, res) => {
  // #swagger.tags = ['Images']
  // #swagger.summary = 'Delete an image'
  // #swagger.description = 'Delete an image by ID from filesystem and remove references from all chat metadata.'
  /* #swagger.parameters['imageId'] = { in: 'path', required: true, type: 'string', description: 'Image ID' } */
  /* #swagger.responses[200] = { description: "Image deleted" } */
  /* #swagger.responses[404] = { description: "Image not found" } */
  const { imageId } = req.params;

  try {
    // Remove from file system
    const deleted = ImageStorageService.deleteImage(imageId);

    if (!deleted) {
      return res.status(404).json({ error: "Image not found" });
    }

    // Remove from all chat metadata (this is a simple approach)
    // In production, you'd want to track which chat owns which image
    await removeImageFromAllChats(imageId);

    res.json({ success: true });
  } catch (error) {
    console.error("Image deletion error:", error);
    res.status(500).json({ error: "Failed to delete image" });
  }
});

/**
 * Get all images for a chat
 * GET /api/chats/:chatId/images
 */
imagesRouter.get("/:chatId/images", (req, res) => {
  // #swagger.tags = ['Images']
  // #swagger.summary = 'Get all images for a chat'
  // #swagger.description = 'Returns all images associated with a chat, flattened from all message image records.'
  /* #swagger.parameters['chatId'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "Array of image metadata" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const { chatId } = req.params;

  try {
    const chat = chatFileService.getChat(chatId);

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    const metadata = JSON.parse(chat.metadata || "{}");
    const images = metadata.images || {};

    // Flatten all images from all messages
    const allImages: StoredImage[] = [];
    for (const messageImages of Object.values(images)) {
      if (Array.isArray(messageImages)) {
        allImages.push(...messageImages);
      }
    }

    res.json({ images: allImages });
  } catch (error) {
    console.error("Get chat images error:", error);
    res.status(500).json({ error: "Failed to retrieve chat images" });
  }
});

/**
 * Remove an image from all chat metadata
 */
async function removeImageFromAllChats(imageId: string): Promise<void> {
  const chats = chatFileService.getAllChats();

  for (const chat of chats) {
    const metadata = JSON.parse(chat.metadata || "{}");

    if (metadata.images) {
      let updated = false;

      // Remove the image from all messages
      for (const [messageId, messageImages] of Object.entries(metadata.images)) {
        if (Array.isArray(messageImages)) {
          const filtered = messageImages.filter((img: StoredImage) => img.id !== imageId);
          if (filtered.length !== messageImages.length) {
            if (filtered.length === 0) {
              delete metadata.images[messageId];
            } else {
              metadata.images[messageId] = filtered;
            }
            updated = true;
          }
        }
      }

      if (updated) {
        chatFileService.updateChat(chat.id, {
          metadata: JSON.stringify(metadata),
        });
      }
    }
  }
}
