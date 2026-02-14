import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { v4 as uuid } from "uuid";
import type { Chat } from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-file");

export type { Chat };

const chatsDir = join(DATA_DIR, "chats");

// Ensure chats directory exists
if (!existsSync(chatsDir)) {
  mkdirSync(chatsDir, { recursive: true });
}

export class ChatFileService {
  // Get all chat files
  getAllChats(limit?: number, offset?: number): Chat[] {
    try {
      const files = readdirSync(chatsDir).filter((file) => file.endsWith(".json"));
      const chats: Chat[] = [];

      for (const file of files) {
        try {
          const content = readFileSync(join(chatsDir, file), "utf8");
          const chat: Chat = JSON.parse(content);
          chats.push(chat);
        } catch (error) {
          log.error(`Error reading chat file ${file}: ${error}`);
        }
      }

      // Sort by updated_at desc (newest first)
      chats.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      // Apply pagination
      const start = offset || 0;
      const end = limit ? start + limit : undefined;
      return chats.slice(start, end);
    } catch (error) {
      log.error(`Error reading chats directory: ${error}`);
      return [];
    }
  }

  // Get a specific chat by ID
  getChat(id: string): Chat | null {
    // Try to find by session_id first (filename)
    const sessionFilepath = join(chatsDir, `${id}.json`);
    if (existsSync(sessionFilepath)) {
      try {
        const content = readFileSync(sessionFilepath, "utf8");
        return JSON.parse(content);
      } catch (error) {
        log.error(`Error reading chat file for session ${id}: ${error}`);
      }
    }

    // If not found by session_id, search all files for matching chat id
    try {
      const files = readdirSync(chatsDir).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        try {
          const content = readFileSync(join(chatsDir, file), "utf8");
          const chat: Chat = JSON.parse(content);
          if (chat.id === id) {
            return chat;
          }
        } catch (error) {
          log.error(`Error reading chat file ${file}: ${error}`);
        }
      }
    } catch (error) {
      log.error(`Error searching for chat: ${error}`);
    }

    return null;
  }

  // Create a new chat (requires session_id)
  createChat(folder: string, sessionId: string, metadata: string = "{}"): Chat {
    log.debug(`createChat — folder=${folder}, sessionId=${sessionId}`);
    const id = uuid();
    const now = new Date().toISOString();

    const chat: Chat = {
      id,
      folder,
      session_id: sessionId,
      session_log_path: null,
      metadata,
      created_at: now,
      updated_at: now,
    };

    this.saveChat(chat);
    return chat;
  }

  // Update an existing chat (returns false if chat not found)
  updateChat(id: string, updates: Partial<Chat>): boolean {
    log.debug(`updateChat — id=${id}`);
    const chat = this.getChat(id);
    if (!chat) {
      return false;
    }

    const oldSessionId = chat.session_id;
    const updatedChat = {
      ...chat,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    // If session_id changed, we need to rename the file
    if (updates.session_id && updates.session_id !== oldSessionId) {
      this.deleteChat(oldSessionId);
    }

    this.saveChat(updatedChat);
    return true;
  }

  // Create or update a chat - useful when chat might only exist in filesystem
  upsertChat(id: string, folder: string, sessionId: string, updates: Partial<Chat>): Chat {
    log.debug(`upsertChat — id=${id}, folder=${folder}, sessionId=${sessionId}`);
    const existingChat = this.getChat(id);

    if (existingChat) {
      // Update existing
      const oldSessionId = existingChat.session_id;
      const updatedChat = {
        ...existingChat,
        ...updates,
        session_id: sessionId || existingChat.session_id,
        updated_at: new Date().toISOString(),
      };

      // If session_id changed, we need to rename the file
      if (sessionId && sessionId !== oldSessionId) {
        this.deleteChat(oldSessionId);
      }

      this.saveChat(updatedChat);
      return updatedChat;
    } else {
      // Create new
      const now = new Date().toISOString();
      const newChat: Chat = {
        id,
        folder,
        session_id: sessionId,
        session_log_path: null,
        metadata: updates.metadata || "{}",
        created_at: now,
        updated_at: now,
      };

      this.saveChat(newChat);
      return newChat;
    }
  }

  // Delete a chat
  deleteChat(sessionId: string): boolean {
    log.debug(`deleteChat — sessionId=${sessionId}`);
    const filepath = join(chatsDir, `${sessionId}.json`);

    if (!existsSync(filepath)) {
      return false;
    }

    try {
      unlinkSync(filepath);
      return true;
    } catch (error) {
      log.error(`Error deleting chat file ${sessionId}: ${error}`);
      return false;
    }
  }

  // Save chat to file (uses session_id as filename)
  private saveChat(chat: Chat): void {
    const filepath = join(chatsDir, `${chat.session_id}.json`);
    writeFileSync(filepath, JSON.stringify(chat, null, 2));
  }
}

// Export singleton instance
export const chatFileService = new ChatFileService();
