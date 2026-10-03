import { chatFileService } from "./chat-file-service.js";
import type { StoredImage } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("image-metadata");

/**
 * Generate a unique message ID for storing image metadata.
 */
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2)}`;
}

/**
 * Store full image objects associated with an upload in chat metadata.
 * Used when uploading images directly to a chat (image routes).
 */
export async function updateChatWithImages(chatId: string, images: StoredImage[]): Promise<void> {
  const chat = chatFileService.getChat(chatId);

  if (!chat) {
    log.warn(`Chat ${chatId} not found in database, skipping metadata update`);
    return;
  }

  // A bare JSON.parse on purpose: this writes the whole blob back, so metadata
  // that will not parse must throw here rather than read as `{}` and be replaced.
  const metadata = JSON.parse(chat.metadata || "{}");
  const messageId = generateMessageId();

  if (!metadata.images) {
    metadata.images = {};
  }

  metadata.images[messageId] = images;

  chatFileService.updateChat(chatId, {
    metadata: JSON.stringify(metadata),
  });
}
