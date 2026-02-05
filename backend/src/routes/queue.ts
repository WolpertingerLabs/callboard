import { Router } from 'express';
import { queueFileService } from '../services/queue-file-service.js';

export const queueRouter = Router();

// Get all queued messages
queueRouter.get('/', (req, res) => {
  const { status, chat_id } = req.query;

  try {
    const queueItems = queueFileService.getAllQueueItems(
      status as string | undefined,
      chat_id as string | undefined
    );
    res.json(queueItems);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule a new message
queueRouter.post('/', (req, res) => {
  const { chat_id, user_message, scheduled_time, folder, defaultPermissions } = req.body;

  if (!user_message || !scheduled_time) {
    return res.status(400).json({
      error: 'user_message and scheduled_time are required'
    });
  }

  // For new chats, chat_id can be null but folder is required
  if (!chat_id && !folder) {
    return res.status(400).json({
      error: 'Either chat_id or folder is required'
    });
  }

  try {
    const queueItem = queueFileService.createQueueItem(chat_id || null, user_message, scheduled_time, folder, defaultPermissions);
    res.status(201).json(queueItem);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific queue item
queueRouter.get('/:id', (req, res) => {
  const queueItem = queueFileService.getQueueItem(req.params.id);
  if (!queueItem) {
    return res.status(404).json({ error: 'Queue item not found' });
  }
  res.json(queueItem);
});

// Cancel/delete a queue item
queueRouter.delete('/:id', (req, res) => {
  const queueItem = queueFileService.getQueueItem(req.params.id);

  if (!queueItem || queueItem.status !== 'pending') {
    return res.status(404).json({ error: 'Queue item not found or not pending' });
  }

  const deleted = queueFileService.deleteQueueItem(req.params.id);
  if (deleted) {
    res.json({ ok: true });
  } else {
    res.status(500).json({ error: 'Failed to delete queue item' });
  }
});

// Execute a queue item immediately
queueRouter.post('/:id/execute-now', async (req, res) => {
  const queueItem = queueFileService.getQueueItem(req.params.id);

  if (!queueItem) {
    return res.status(404).json({ error: 'Queue item not found' });
  }

  if (queueItem.status !== 'pending') {
    return res.status(400).json({ error: 'Queue item is not pending' });
  }

  try {
    // Update status to running
    queueFileService.updateQueueItem(req.params.id, { status: 'running' });

    let apiUrl: string;
    let requestBody: any;

    if (queueItem.chat_id) {
      // Existing chat - use regular message endpoint
      apiUrl = `http://localhost:${process.env.PORT || 8000}/api/chats/${queueItem.chat_id}/message`;
      requestBody = { prompt: queueItem.user_message };
    } else {
      // New chat - use new message endpoint
      if (!queueItem.folder) {
        throw new Error('Queue item missing required folder for new chat');
      }
      apiUrl = `http://localhost:${process.env.PORT || 8000}/api/chats/new/message`;
      requestBody = {
        folder: queueItem.folder,
        prompt: queueItem.user_message,
        defaultPermissions: queueItem.defaultPermissions
      };
    }

    // Execute the message by making internal API call
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': req.headers.cookie || ''
      },
      body: JSON.stringify(requestBody)
    });

    if (response.ok) {
      // Delete the queue item when completed successfully
      queueFileService.deleteQueueItem(req.params.id);
      res.json({ success: true, message: 'Message executed successfully' });
    } else {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  } catch (error: any) {
    queueFileService.updateQueueItem(req.params.id, {
      status: 'failed',
      error_message: error.message,
      retry_count: queueItem.retry_count + 1
    });
    res.status(500).json({ error: error.message });
  }
});

// Get upcoming messages (due in next hour)
queueRouter.get('/upcoming/next-hour', (req, res) => {
  try {
    const upcomingMessages = queueFileService.getUpcomingMessages();
    res.json(upcomingMessages);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});