import { Router } from 'express';
import { sendMessage, getActiveSession, stopSession, respondToPermission, hasPendingRequest, type StreamEvent } from '../services/claude.js';

export const streamRouter = Router();

// Send a message and get SSE stream back
streamRouter.post('/:id/message', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const emitter = await sendMessage(req.params.id, prompt);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const onEvent = (event: StreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') {
        emitter.removeListener('event', onEvent);
        res.end();
      }
    };

    emitter.on('event', onEvent);

    req.on('close', () => {
      emitter.removeListener('event', onEvent);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint for connecting to an active stream
streamRouter.get('/:id/stream', (req, res) => {
  const session = getActiveSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'No active stream' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const onEvent = (event: StreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done' || event.type === 'error') {
      session.emitter.removeListener('event', onEvent);
      res.end();
    }
  };

  session.emitter.on('event', onEvent);

  req.on('close', () => {
    session.emitter.removeListener('event', onEvent);
  });
});

// Respond to a pending permission/question/plan request
streamRouter.post('/:id/respond', (req, res) => {
  const { allow, updatedInput, updatedPermissions } = req.body;
  if (!hasPendingRequest(req.params.id)) {
    return res.status(404).json({ error: 'No pending request' });
  }
  const ok = respondToPermission(req.params.id, allow, updatedInput, updatedPermissions);
  res.json({ ok });
});

// Stop execution
streamRouter.post('/:id/stop', (_req, res) => {
  const stopped = stopSession(_req.params.id);
  res.json({ stopped });
});
