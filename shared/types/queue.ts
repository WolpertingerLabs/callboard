import type { DefaultPermissions } from "./permissions.js";

/**
 * An image attached to a draft: an id from `POST /api/images/upload`, plus the
 * name the user's file had, so a restored attachment re-sends under the same
 * name an immediate send would have used.
 */
export interface QueueItemImage {
  id: string;
  originalName: string;
}

export interface QueueItem {
  id: string;
  chat_id: string | null;
  user_message: string;
  status: "draft";
  created_at: string;
  // New chat fields - only used when chat_id is null
  folder?: string;
  defaultPermissions?: DefaultPermissions;
  /**
   * Images attached when the draft was saved. Absent on drafts saved before
   * drafts kept images, and on drafts saved without any — both mean "none".
   * The draft references these; it does not own them. Nothing deletes an
   * image file because a draft dropped it, was deleted, or was sent.
   */
  images?: QueueItemImage[];
}
