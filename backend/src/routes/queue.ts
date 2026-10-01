import { Router } from "express";
import { queueFileService } from "../services/queue-file-service.js";
import { sendMessage } from "../services/claude.js";
import { sendRetiredProviderError } from "../utils/route-errors.js";
import { ImageStorageService, isValidImageId } from "../services/image-storage.js";
import type { QueueItemImage } from "shared/types/index.js";

export const queueRouter = Router();

/**
 * Read a request's `images` field: `undefined` when absent, `null` when it is
 * not a list of upload ids. Only `id` and `originalName` are kept.
 */
function parseDraftImages(raw: unknown): QueueItemImage[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const images: QueueItemImage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.id !== "string" || !isValidImageId(entry.id)) return null;
    images.push({ id: entry.id, originalName: typeof entry.originalName === "string" ? entry.originalName : entry.id });
  }
  return images;
}

/** A draft's images are its own — they were uploaded for it and nothing else references them. */
function deleteDraftImages(images: QueueItemImage[] | undefined, keep: QueueItemImage[] = []): void {
  const kept = new Set(keep.map((image) => image.id));
  for (const image of images ?? []) {
    if (!kept.has(image.id)) ImageStorageService.deleteImage(image.id);
  }
}

// Get all draft messages
queueRouter.get("/", (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'List draft messages'
  // #swagger.description = 'Returns all saved draft messages, optionally filtered by chat ID.'
  /* #swagger.parameters['chat_id'] = { in: 'query', type: 'string', description: 'Filter by chat ID' } */
  /* #swagger.responses[200] = { description: "Array of draft items" } */
  const { chat_id } = req.query;

  try {
    const items = queueFileService.getAllQueueItems(chat_id as string | undefined);
    res.json(items);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new draft
queueRouter.post("/", (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'Create a draft message'
  // #swagger.description = 'Save a message as a draft for later execution. Either chat_id (existing chat) or folder (new chat) must be provided.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["user_message"],
          properties: {
            chat_id: { type: "string", description: "Existing chat ID (null for new chat)" },
            user_message: { type: "string", description: "The message to save" },
            folder: { type: "string", description: "Project folder for new chats" },
            defaultPermissions: { type: "object", description: "Default permissions for new chats" },
            images: { type: "array", items: { type: "object", properties: { id: { type: "string" }, originalName: { type: "string" } } }, description: "Images from POST /api/images/upload to attach" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[201] = { description: "Draft created" } */
  /* #swagger.responses[400] = { description: "Missing required fields" } */
  const { chat_id, user_message, folder, defaultPermissions } = req.body;
  const images = parseDraftImages(req.body.images);

  if (!user_message) {
    return res.status(400).json({
      error: "user_message is required",
    });
  }

  // For new chats, chat_id can be null but folder is required
  if (!chat_id && !folder) {
    return res.status(400).json({
      error: "Either chat_id or folder is required",
    });
  }

  if (images === null) {
    return res.status(400).json({ error: "images must be a list of { id, originalName } from the image upload route" });
  }

  try {
    const item = queueFileService.createQueueItem(chat_id || null, user_message, folder, defaultPermissions, images);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific draft
queueRouter.get("/:id", (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'Get draft message'
  // #swagger.description = 'Retrieve a specific draft message by ID.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Draft item ID' } */
  /* #swagger.responses[200] = { description: "Draft item details" } */
  /* #swagger.responses[404] = { description: "Draft not found" } */
  const item = queueFileService.getQueueItem(req.params.id);
  if (!item) {
    return res.status(404).json({ error: "Draft not found" });
  }
  res.json(item);
});

// Update a draft
queueRouter.put("/:id", (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'Update a draft message'
  // #swagger.description = 'Update the message content of an existing draft. Sending images replaces the draft\'s images; omitting it leaves them as they are.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Draft item ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["user_message"],
          properties: {
            user_message: { type: "string", description: "The updated message" },
            images: { type: "array", items: { type: "object", properties: { id: { type: "string" }, originalName: { type: "string" } } }, description: "Replacement images; omit to keep the current ones" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Draft updated" } */
  /* #swagger.responses[400] = { description: "Missing required fields" } */
  /* #swagger.responses[404] = { description: "Draft not found" } */
  const { user_message } = req.body;
  const images = parseDraftImages(req.body.images);

  if (!user_message || !user_message.trim()) {
    return res.status(400).json({ error: "user_message is required" });
  }

  if (images === null) {
    return res.status(400).json({ error: "images must be a list of { id, originalName } from the image upload route" });
  }

  const previous = queueFileService.getQueueItem(req.params.id);
  const updated = queueFileService.updateQueueItem(req.params.id, { user_message: user_message.trim(), ...(images && { images }) });
  if (!updated) {
    return res.status(404).json({ error: "Draft not found" });
  }
  if (images) deleteDraftImages(previous?.images, images);

  const item = queueFileService.getQueueItem(req.params.id);
  res.json(item);
});

// Delete a draft
queueRouter.delete("/:id", (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'Delete draft message'
  // #swagger.description = 'Delete a saved draft message, and the images attached to it.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Draft item ID' } */
  /* #swagger.responses[200] = { description: "Draft deleted" } */
  /* #swagger.responses[404] = { description: "Draft not found" } */
  const item = queueFileService.getQueueItem(req.params.id);
  const deleted = queueFileService.deleteQueueItem(req.params.id);
  if (deleted) {
    deleteDraftImages(item?.images);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Draft not found" });
  }
});

// Execute a draft immediately
queueRouter.post("/:id/execute-now", async (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'Execute draft now'
  // #swagger.description = 'Immediately execute a draft message, sending it to Claude. The draft is deleted on success.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Draft item ID' } */
  /* #swagger.responses[200] = { description: "Execution started" } */
  /* #swagger.responses[404] = { description: "Draft not found" } */
  const queueItem = queueFileService.getQueueItem(req.params.id);

  if (!queueItem) {
    return res.status(404).json({ error: "Draft not found" });
  }

  if (queueItem.status !== "draft") {
    return res.status(400).json({ error: "Item is not a draft" });
  }

  try {
    // Delete the draft before executing
    queueFileService.deleteQueueItem(req.params.id);

    // Kick off the message but don't wait for completion — the user can
    // navigate to the chat and connect to the active session via /stream.
    await sendMessage(
      queueItem.chat_id
        ? { chatId: queueItem.chat_id, prompt: queueItem.user_message }
        : {
            folder: queueItem.folder!,
            prompt: queueItem.user_message,
            defaultPermissions: queueItem.defaultPermissions,
          },
    );

    res.json({ success: true, message: "Message execution started" });
  } catch (error: any) {
    // Same 410-not-500 rule as POST /api/chats/:id/message: a draft saved
    // against a chat on a removed harness is the one refusal this route can
    // hit that is not a server fault.
    if (sendRetiredProviderError(res, error)) return;
    res.status(500).json({ error: error.message });
  }
});
