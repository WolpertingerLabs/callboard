import { Router } from "express";
import { sendMessage, getActiveSession, stopSession, respondToPermission, hasPendingRequest, getPendingRequest, type StreamEvent } from "../services/claude.js";
import { loadImageBuffers } from "../services/image-storage.js";
import { storeMessageImages } from "../services/image-metadata.js";
import { statSync, existsSync, readdirSync, watchFile, unwatchFile, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { ensureWorktree, switchBranch } from "../utils/git.js";
import { findSessionLogPath } from "../utils/session-log.js";
import { findChatForStatus } from "../utils/chat-lookup.js";
import { writeSSEHeaders, sendSSE, createSSEHandler } from "../utils/sse.js";

export const streamRouter = Router();

// Send first message to create a new chat (no existing chat ID required)
streamRouter.post("/new/message", async (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Create new chat with first message'
  // #swagger.description = 'Starts a new Claude session in the given folder and streams the response via SSE. Optionally creates a git worktree or branch. Returns a chat_created event followed by message_update events.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["folder", "prompt"],
          properties: {
            folder: { type: "string", description: "Absolute path to the project folder" },
            prompt: { type: "string", description: "The user message to send" },
            defaultPermissions: { type: "object", description: "Default tool permissions" },
            imageIds: { type: "array", items: { type: "string" }, description: "Previously uploaded image IDs to attach" },
            activePlugins: { type: "array", items: { type: "string" }, description: "Active plugin IDs" },
            branchConfig: {
              type: "object",
              properties: {
                baseBranch: { type: "string" },
                newBranch: { type: "string" },
                useWorktree: { type: "boolean" }
              }
            }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "SSE stream with chat_created, message_update, permission_request, user_question, plan_review, message_complete, and message_error events" } */
  /* #swagger.responses[400] = { description: "Missing required fields or invalid folder" } */
  const { folder, prompt, defaultPermissions, imageIds, activePlugins, branchConfig } = req.body;
  if (!folder) return res.status(400).json({ error: "folder is required" });
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // Check if folder exists
  if (!existsSync(folder)) {
    return res.status(400).json({ error: "folder does not exist" });
  }

  // Resolve effective folder based on branch configuration
  let effectiveFolder = folder;
  if (branchConfig) {
    const { baseBranch, newBranch, useWorktree } = branchConfig;
    const targetBranch = newBranch || baseBranch;

    if (targetBranch && useWorktree) {
      try {
        effectiveFolder = ensureWorktree(folder, targetBranch, !!newBranch, baseBranch);
      } catch (err: any) {
        return res.status(500).json({ error: `Failed to create worktree: ${err.message}` });
      }
    } else if (newBranch) {
      try {
        switchBranch(folder, newBranch, true, baseBranch);
      } catch (err: any) {
        return res.status(500).json({ error: `Failed to create branch: ${err.message}` });
      }
    } else if (baseBranch) {
      try {
        switchBranch(folder, baseBranch, false);
      } catch (err: any) {
        return res.status(500).json({ error: `Failed to switch branch: ${err.message}` });
      }
    }
  }

  try {
    const imageMetadata = imageIds?.length ? loadImageBuffers(imageIds) : [];

    const emitter = await sendMessage({
      prompt,
      folder: effectiveFolder,
      defaultPermissions,
      imageMetadata: imageMetadata.length > 0 ? imageMetadata : undefined,
      activePlugins,
    });

    writeSSEHeaders(res);

    // Custom handler for new chat — needs to intercept chat_created event
    const onEvent = (event: StreamEvent) => {
      if (event.type === "chat_created") {
        sendSSE(res, { type: "chat_created", chatId: event.chatId, chat: event.chat });
        return;
      }

      if (event.type === "done") {
        sendSSE(res, { type: "message_complete", ...(event.reason && { reason: event.reason }) });
        emitter.removeListener("event", onEvent);
        res.end();
      } else if (event.type === "error") {
        sendSSE(res, { type: "message_error", content: event.content });
        emitter.removeListener("event", onEvent);
        res.end();
      } else if (event.type === "permission_request" || event.type === "user_question" || event.type === "plan_review") {
        sendSSE(res, event as unknown as Record<string, unknown>);
      } else if (event.type === "compacting") {
        sendSSE(res, { type: "compacting" });
      } else {
        sendSSE(res, { type: "message_update" });
      }
    };

    emitter.on("event", onEvent);

    req.on("close", () => {
      emitter.removeListener("event", onEvent);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message and get SSE stream back
streamRouter.post("/:id/message", async (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Send message to existing chat'
  // #swagger.description = 'Sends a user message to an existing chat session and streams the response via SSE.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "The user message to send" },
            imageIds: { type: "array", items: { type: "string" }, description: "Previously uploaded image IDs to attach" },
            activePlugins: { type: "array", items: { type: "string" }, description: "Active plugin IDs" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "SSE stream with message_update, permission_request, message_complete, and message_error events" } */
  /* #swagger.responses[400] = { description: "Missing prompt" } */
  const { prompt, imageIds, activePlugins } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const imageMetadata = imageIds?.length ? loadImageBuffers(imageIds) : [];

    if (imageIds?.length) {
      await storeMessageImages(req.params.id, imageIds);
    }

    const emitter = await sendMessage({
      chatId: req.params.id,
      prompt,
      imageMetadata: imageMetadata.length > 0 ? imageMetadata : undefined,
      activePlugins,
    });

    writeSSEHeaders(res);

    const onEvent = createSSEHandler(res, emitter);
    emitter.on("event", onEvent);

    req.on("close", () => {
      emitter.removeListener("event", onEvent);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint for connecting to an active stream (web or CLI)
streamRouter.get("/:id/stream", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Connect to active stream'
  // #swagger.description = 'SSE endpoint to receive real-time updates from an active web or CLI session. For CLI sessions, watches the JSONL log file for changes.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "SSE stream with message_update, message_complete, and message_error events" } */
  const chatId = req.params.id;
  const session = getActiveSession(chatId);

  writeSSEHeaders(res);

  // If there's an active web session, connect to it
  if (session) {
    const onEvent = createSSEHandler(res, session.emitter);
    session.emitter.on("event", onEvent);

    req.on("close", () => {
      session.emitter.removeListener("event", onEvent);
    });
    return;
  }

  // No web session - check if we can watch CLI session
  const chat = findChatForStatus(chatId);
  if (!chat?.session_id) {
    sendSSE(res, { type: "error", content: "No active session found" });
    res.end();
    return;
  }

  const logPath = findSessionLogPath(chat.session_id);
  if (!logPath || !existsSync(logPath)) {
    sendSSE(res, { type: "error", content: "Session log not found" });
    res.end();
    return;
  }

  // Check if CLI session is already complete before starting file watcher.
  // Read the tail of the file and look for stop_reason or summary — if found,
  // the session finished before we connected, so return immediately.
  let lastPosition = 0;
  try {
    const fileStats = statSync(logPath);
    lastPosition = fileStats.size;

    // Read up to last 4KB to check for completion markers
    const tailSize = Math.min(4096, fileStats.size);
    const tailBuffer = Buffer.alloc(tailSize);
    const fd = openSync(logPath, "r");
    readSync(fd, tailBuffer, 0, tailSize, fileStats.size - tailSize);
    closeSync(fd);

    const tailContent = tailBuffer.toString("utf-8");
    const tailLines = tailContent.split("\n");
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "summary" || parsed.message?.stop_reason) {
          sendSSE(res, { type: "message_complete" });
          res.end();
          return;
        }
      } catch {}
    }
  } catch {}

  // Track last activity time for inactivity timeout
  let lastActivityTime = Date.now();
  const CLI_INACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes

  const watchHandler = () => {
    try {
      const newStats = statSync(logPath);
      if (newStats.size > lastPosition) {
        lastActivityTime = Date.now();
        const buffer = Buffer.alloc(newStats.size - lastPosition);
        const fd = openSync(logPath, "r");
        readSync(fd, buffer, 0, buffer.length, lastPosition);
        closeSync(fd);

        const newContent = buffer.toString("utf-8");
        const lines = newContent.split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              sendSSE(res, { type: "message_update" });
            }
            // Detect conversation compaction (context window auto-summary)
            if (parsed.type === "system" && parsed.subtype === "compact_boundary") {
              sendSSE(res, { type: "compacting" });
            }
            if (parsed.type === "summary" || parsed.message?.stop_reason) {
              sendSSE(res, { type: "message_complete" });
              // Session is done — clean up and close
              unwatchFile(logPath, watchHandler);
              clearInterval(subagentScanInterval);
              clearInterval(inactivityCheckInterval);
              res.end();
              return;
            }
          } catch (err) {
            console.warn("[CLI Monitor] Failed to parse log line:", err instanceof Error ? err.message : "Unknown error", "Line:", line.slice(0, 100));
          }
        }
        lastPosition = newStats.size;
      }
    } catch (err) {
      console.warn("[CLI Monitor] File watch error:", err instanceof Error ? err.message : "Unknown error");
    }
  };

  watchFile(logPath, { interval: 1000 }, watchHandler);

  // Watch for subagent files (created dynamically as Task tools are spawned)
  const subagentsDir = logPath.replace(".jsonl", "") + "/subagents";
  const watchedSubagentSizes = new Map<string, number>();

  const subagentScanInterval = setInterval(() => {
    try {
      if (!existsSync(subagentsDir)) return;

      for (const file of readdirSync(subagentsDir)) {
        if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue;
        const filePath = join(subagentsDir, file);

        try {
          const stats = statSync(filePath);
          const prevSize = watchedSubagentSizes.get(filePath) ?? 0;

          if (stats.size > prevSize) {
            lastActivityTime = Date.now();
            watchedSubagentSizes.set(filePath, stats.size);
            // Signal the client to refetch messages (which now includes subagent data)
            sendSSE(res, { type: "message_update" });
          }
        } catch {}
      }
    } catch {}
  }, 1000);

  // Inactivity timeout: if no new data for CLI_INACTIVITY_TIMEOUT_MS, assume session is done
  const inactivityCheckInterval = setInterval(() => {
    if (Date.now() - lastActivityTime > CLI_INACTIVITY_TIMEOUT_MS) {
      sendSSE(res, { type: "message_complete" });
      unwatchFile(logPath, watchHandler);
      clearInterval(subagentScanInterval);
      clearInterval(inactivityCheckInterval);
      res.end();
    }
  }, 5000);

  req.on("close", () => {
    unwatchFile(logPath, watchHandler);
    clearInterval(subagentScanInterval);
    clearInterval(inactivityCheckInterval);
  });
});

// Check for a pending request (for page refresh reconnection)
streamRouter.get("/:id/pending", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Get pending request'
  // #swagger.description = 'Check if there is a pending permission, question, or plan review request for this chat. Used for reconnection after page refresh.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "Pending request or null" } */
  const pending = getPendingRequest(req.params.id);
  if (!pending) return res.json({ pending: null });
  res.json({
    pending: {
      type: pending.eventType,
      ...pending.eventData,
    },
  });
});

// Respond to a pending permission/question/plan request
streamRouter.post("/:id/respond", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Respond to pending request'
  // #swagger.description = 'Respond to a pending permission, user question, or plan review request.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            allow: { type: "boolean", description: "Whether to allow the permission" },
            updatedInput: { type: "string", description: "Updated input for the tool (optional)" },
            updatedPermissions: { type: "object", description: "Updated permissions (optional)" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Response accepted" } */
  /* #swagger.responses[404] = { description: "No pending request" } */
  const { allow, updatedInput, updatedPermissions } = req.body;
  if (!hasPendingRequest(req.params.id)) {
    return res.status(404).json({ error: "No pending request" });
  }
  const result = respondToPermission(req.params.id, allow, updatedInput, updatedPermissions);
  res.json({ ok: result.ok, toolName: result.toolName });
});

// Check session status - active in web, CLI, or inactive
streamRouter.get("/:id/status", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Check session status'
  // #swagger.description = 'Returns whether the session is active in web, CLI (recently modified JSONL), or inactive. CLI sessions are considered active if modified within the last 5 minutes.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "Session status with active flag, type (web/cli/inactive/none), lastActivity, and fileSize" } */
  const chatId = req.params.id;

  // Check if session is active in web
  const webSession = getActiveSession(chatId);
  if (webSession) {
    return res.json({
      active: true,
      type: "web",
      hasPending: hasPendingRequest(chatId),
    });
  }

  // Check if session exists and get its log path
  const chat = findChatForStatus(chatId);
  if (!chat || !chat.session_id) {
    return res.json({ active: false, type: "none" });
  }

  // Check CLI activity by examining .jsonl file modification time
  const logPath = findSessionLogPath(chat.session_id);
  if (!logPath || !existsSync(logPath)) {
    return res.json({ active: false, type: "none" });
  }

  try {
    const stats = statSync(logPath);
    const lastModified = stats.mtime.getTime();
    const now = Date.now();
    const recentThreshold = now - 120_000; // 2 minutes

    const isRecentlyActive = lastModified > recentThreshold;

    res.json({
      active: isRecentlyActive,
      type: isRecentlyActive ? "cli" : "inactive",
      lastActivity: stats.mtime.toISOString(),
      fileSize: stats.size,
    });
  } catch {
    res.json({ active: false, type: "none" });
  }
});

// Stop execution
streamRouter.post("/:id/stop", (_req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Stop execution'
  // #swagger.description = 'Abort the currently running Claude session for this chat.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "Whether the session was stopped" } */
  const stopped = stopSession(_req.params.id);
  res.json({ stopped });
});
