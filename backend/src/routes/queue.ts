import { Router } from "express";
import { queueFileService } from "../services/queue-file-service.js";
import { sendMessage } from "../services/claude.js";

export const queueRouter = Router();

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
            defaultPermissions: { type: "object", description: "Default permissions for new chats" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[201] = { description: "Draft created" } */
  /* #swagger.responses[400] = { description: "Missing required fields" } */
  const { chat_id, user_message, folder, defaultPermissions } = req.body;

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

  try {
    const item = queueFileService.createQueueItem(chat_id || null, user_message, folder, defaultPermissions);
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
  // #swagger.description = 'Update the message content of an existing draft.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Draft item ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["user_message"],
          properties: {
            user_message: { type: "string", description: "The updated message" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Draft updated" } */
  /* #swagger.responses[400] = { description: "Missing required fields" } */
  /* #swagger.responses[404] = { description: "Draft not found" } */
  const { user_message } = req.body;

  if (!user_message || !user_message.trim()) {
    return res.status(400).json({ error: "user_message is required" });
  }

  const updated = queueFileService.updateQueueItem(req.params.id, { user_message: user_message.trim() });
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
  // #swagger.description = 'Delete a saved draft message.'
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
    res.status(500).json({ error: error.message });
  }
});
