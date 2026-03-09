import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import type { QueueItem, DefaultPermissions } from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";

export type { QueueItem };

const queueDir = join(DATA_DIR, "queue");

// Ensure queue directory exists
if (!existsSync(queueDir)) {
  mkdirSync(queueDir, { recursive: true });
}

export class QueueFileService {
  // Get all draft items
  getAllQueueItems(chatId?: string): QueueItem[] {
    try {
      const files = readdirSync(queueDir).filter((file) => file.endsWith(".json"));
      const items: QueueItem[] = [];

      for (const file of files) {
        try {
          const content = readFileSync(join(queueDir, file), "utf8");
          const item: QueueItem = JSON.parse(content);

          // Only include drafts
          if (item.status !== "draft") continue;
          if (chatId && item.chat_id !== chatId) continue;

          items.push(item);
        } catch (error) {
          console.error(`Error reading queue file ${file}:`, error);
        }
      }

      // Sort by created_at (newest first)
      return items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } catch (error) {
      console.error("Error reading queue directory:", error);
      return [];
    }
  }

  // Get a specific queue item
  getQueueItem(id: string): QueueItem | null {
    const filepath = join(queueDir, `${id}.json`);

    if (!existsSync(filepath)) {
      return null;
    }

    try {
      const content = readFileSync(filepath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      console.error(`Error reading queue item ${id}:`, error);
      return null;
    }
  }

  // Create a new draft item
  createQueueItem(chatId: string | null, userMessage: string, folder?: string, defaultPermissions?: DefaultPermissions): QueueItem {
    const id = randomUUID();
    const now = new Date().toISOString();

    const item: QueueItem = {
      id,
      chat_id: chatId,
      user_message: userMessage,
      status: "draft",
      created_at: now,
      ...(folder && { folder }),
      ...(defaultPermissions && { defaultPermissions }),
    };

    this.saveQueueItem(item);
    return item;
  }

  // Update a queue item
  updateQueueItem(id: string, updates: Partial<QueueItem>): boolean {
    const item = this.getQueueItem(id);
    if (!item) {
      return false;
    }

    const updatedItem = { ...item, ...updates };
    this.saveQueueItem(updatedItem);
    return true;
  }

  // Delete a queue item
  deleteQueueItem(id: string): boolean {
    const filepath = join(queueDir, `${id}.json`);

    if (!existsSync(filepath)) {
      return false;
    }

    try {
      unlinkSync(filepath);
      return true;
    } catch (error) {
      console.error(`Error deleting queue item ${id}:`, error);
      return false;
    }
  }

  // Save queue item to file
  private saveQueueItem(item: QueueItem): void {
    const filepath = join(queueDir, `${item.id}.json`);
    writeFileSync(filepath, JSON.stringify(item, null, 2));
  }
}

// Export singleton instance
export const queueFileService = new QueueFileService();
