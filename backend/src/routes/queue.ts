import { Router } from "express";
import { queueFileService, isValidQueueItemId } from "../services/queue-file-service.js";
import { sendMessage } from "../services/claude.js";
import { sendRetiredProviderError } from "../utils/route-errors.js";
import { isValidImageId, loadImageBuffers } from "../services/image-storage.js";
import type { QueueItemImage } from "shared/types/index.js";

export const queueRouter = Router();

/**
 * Every `:id` here names a file under the queue directory, and Express hands
 * the handler a percent-decoded param: `/api/queue/..%2Fvictim` arrives as
 * `../victim`. Draft ids have always been UUIDs, so anything else is refused
 * before a handler can turn it into a path. `QueueFileService` checks again.
 */
queueRouter.param("id", (req, res, next, id) => {
  if (!isValidQueueItemId(id)) {
    res.status(400).json({ error: "Invalid draft id" });
    return;
  }
  next();
});

/** Longest `originalName` kept; it only ever becomes a client-side File name. */
const MAX_IMAGE_NAME_LENGTH = 255;

/**
 * Tidy a client-supplied file name: last path segment, no control characters,
 * capped. Falls back to the image id rather than refusing the save — a draft
 * is worth more than its attachment's name.
 */
function cleanImageName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const name = (raw.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_IMAGE_NAME_LENGTH).trim();
  return name || fallback;
}

/**
 * Read a request's `images` field: `undefined` when absent, `null` when it is
 * not a list of upload ids. Only `id` and `originalName` are kept.
 *
 * Nothing in this router deletes an image file. A draft only *references* the
 * uploads it lists: dropping one from a draft, deleting the draft, or sending
 * it leaves the file where it is, exactly like every other upload (there is no
 * image sweeper; only an explicit `DELETE /api/images/:id` removes one). The
 * alternative — the draft owning and deleting its files — turned every way of
 * getting the list wrong into a lost image: a re-save that raced the composer's
 * restore, a `storeBase64Image` dedup hit that pointed chat history at a
 * draft's file, a traversal-chosen JSON file listing someone else's image. A
 * stray file on disk is the failure this trades them for.
 */
function parseDraftImages(raw: unknown): QueueItemImage[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const images: QueueItemImage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.id !== "string" || !isValidImageId(entry.id)) return null;
    images.push({ id: entry.id, originalName: cleanImageName(entry.originalName, entry.id) });
  }
  return images;
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

  const updated = queueFileService.updateQueueItem(req.params.id, { user_message: user_message.trim(), ...(images && { images }) });
  if (!updated) {
    return res.status(404).json({ error: "Draft not found" });
  }

  const item = queueFileService.getQueueItem(req.params.id);
  res.json(item);
});

// Delete a draft
queueRouter.delete("/:id", (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'Delete draft message'
  // #swagger.description = 'Delete a saved draft message. Its image uploads are left in place.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Draft item ID' } */
  /* #swagger.responses[200] = { description: "Draft deleted" } */
  /* #swagger.responses[404] = { description: "Draft not found" } */
  const deleted = queueFileService.deleteQueueItem(req.params.id);
  if (deleted) {
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Draft not found" });
  }
});

/**
 * Drafts with an execute-now in flight. The draft is deleted only once its
 * send has started, so for the length of that await it still exists; this is
 * what turns a second request for it (a double click, a retry) into a 409
 * rather than a second send.
 */
const executingDrafts = new Set<string>();

// Execute a draft immediately
queueRouter.post("/:id/execute-now", async (req, res) => {
  // #swagger.tags = ['Drafts']
  // #swagger.summary = 'Execute draft now'
  // #swagger.description = 'Immediately execute a draft message, with its images, sending it to Claude. The draft is deleted once the send has started, and kept if it fails. A draft whose images can no longer all be loaded is refused and kept.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Draft item ID' } */
  /* #swagger.responses[200] = { description: "Execution started" } */
  /* #swagger.responses[404] = { description: "Draft not found" } */
  /* #swagger.responses[409] = { description: "One of the draft's images is gone, or the draft is already being sent; the draft is kept" } */
  const queueItem = queueFileService.getQueueItem(req.params.id);

  if (!queueItem) {
    return res.status(404).json({ error: "Draft not found" });
  }

  if (queueItem.status !== "draft") {
    return res.status(400).json({ error: "Item is not a draft" });
  }

  // Same shape the chat send routes build from `imageIds`. All or nothing: a
  // draft that would go out short an image is kept for the user to open.
  const imageIds = (queueItem.images ?? []).map((image) => image.id);
  const imageMetadata = imageIds.length ? loadImageBuffers(imageIds) : [];
  if (imageMetadata.length !== imageIds.length) {
    return res.status(409).json({ error: "Some of this draft's images could not be loaded; open the draft to send it" });
  }

  if (executingDrafts.has(queueItem.id)) {
    return res.status(409).json({ error: "This draft is already being sent" });
  }
  executingDrafts.add(queueItem.id);

  try {
    // Kick off the message but don't wait for completion — the user can
    // navigate to the chat and connect to the active session via /stream.
    const images = imageMetadata.length > 0 ? { imageMetadata } : {};
    await sendMessage(
      queueItem.chat_id
        ? { chatId: queueItem.chat_id, prompt: queueItem.user_message, ...images }
        : {
            folder: queueItem.folder!,
            prompt: queueItem.user_message,
            defaultPermissions: queueItem.defaultPermissions,
            ...images,
          },
    );
    // Only now that the send has started: a send that throws keeps the draft.
    queueFileService.deleteQueueItem(queueItem.id);
    res.json({ success: true, message: "Message execution started" });
  } catch (error: any) {
    // Same 410-not-500 rule as POST /api/chats/:id/message: a draft saved
    // against a chat on a removed harness is the one refusal this route can
    // hit that is not a server fault.
    if (sendRetiredProviderError(res, error)) return;
    res.status(500).json({ error: error.message });
  } finally {
    executingDrafts.delete(queueItem.id);
  }
});
