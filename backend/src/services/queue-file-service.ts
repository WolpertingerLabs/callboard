import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const queueDir = join(__dirname, '..', '..', 'data', 'queue');

// Ensure queue directory exists
if (!existsSync(queueDir)) {
  mkdirSync(queueDir, { recursive: true });
}

export interface QueueItem {
  id: string;
  chat_id: string;
  user_message: string;
  scheduled_time: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
  retry_count: number;
  error_message: string | null;
}

export class QueueFileService {

  // Get all queue items
  getAllQueueItems(status?: string, chatId?: string): QueueItem[] {
    try {
      const files = readdirSync(queueDir).filter(file => file.endsWith('.json'));
      const items: QueueItem[] = [];

      for (const file of files) {
        try {
          const content = readFileSync(join(queueDir, file), 'utf8');
          const item: QueueItem = JSON.parse(content);

          // Apply filters
          if (status && item.status !== status) continue;
          if (chatId && item.chat_id !== chatId) continue;

          items.push(item);
        } catch (error) {
          console.error(`Error reading queue file ${file}:`, error);
        }
      }

      // Sort by scheduled_time
      return items.sort((a, b) => new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime());
    } catch (error) {
      console.error('Error reading queue directory:', error);
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
      const content = readFileSync(filepath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`Error reading queue item ${id}:`, error);
      return null;
    }
  }

  // Create a new queue item
  createQueueItem(chatId: string, userMessage: string, scheduledTime: string): QueueItem {
    const id = uuid();
    const now = new Date().toISOString();

    const item: QueueItem = {
      id,
      chat_id: chatId,
      user_message: userMessage,
      scheduled_time: scheduledTime,
      status: 'pending',
      created_at: now,
      retry_count: 0,
      error_message: null
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

  // Delete a queue item (when completed successfully)
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

  // Get due messages (for the processor)
  getDueMessages(limit: number = 10): QueueItem[] {
    const now = new Date().toISOString();
    const allItems = this.getAllQueueItems('pending');

    return allItems
      .filter(item => item.scheduled_time <= now)
      .slice(0, limit);
  }

  // Get upcoming messages (due in next hour)
  getUpcomingMessages(): QueueItem[] {
    const now = new Date().toISOString();
    const nextHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    return this.getAllQueueItems('pending')
      .filter(item => item.scheduled_time >= now && item.scheduled_time <= nextHour);
  }
}

// Export singleton instance
export const queueFileService = new QueueFileService();