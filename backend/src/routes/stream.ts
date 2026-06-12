import { Router } from "express";
import { sendMessage, getActiveSession, stopSession, respondToPermission, hasPendingRequest, getPendingRequest, type StreamEvent } from "../services/claude.js";
import type { AgentProviderKind } from "../agents/ports/AgentProvider.js";
import type { EffortLevel } from "../agents/adapters/openrouter/optionsAdapter.js";
import { sessionRegistry } from "../services/session-registry.js";
import { loadImageBuffers } from "../services/image-storage.js";
import { storeMessageImages } from "../services/image-metadata.js";
import { statSync, existsSync, readdirSync, watchFile, unwatchFile, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { getGitInfo, resolveBranch } from "../utils/git.js";
import { chatFileService } from "../services/chat-file-service.js";
import { findSessionLogPath } from "../utils/session-log.js";
import { findChatForStatus } from "../utils/chat-lookup.js";
import { writeSSEHeaders, sendSSE, createSSEHandler, startSSEHeartbeat } from "../utils/sse.js";
import { createLogger } from "../utils/logger.js";
import { generateBranchName } from "../services/quick-completion.js";

const log = createLogger("stream");

// Defense-in-depth allowlists shared by /new/message (initial creation) and
// /:id/message (mid-chat updates). Anything not in these sets is silently
// dropped at the route boundary so we never persist garbage to chat metadata.
const VALID_PROVIDERS: ReadonlySet<AgentProviderKind> = new Set(["claude-code", "openrouter"]);
const VALID_EFFORTS: ReadonlySet<string> = new Set(["xhigh", "high", "medium", "low", "minimal", "none"]);

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
            defaultPermissions: { type: "object", description: "Default tool permissions (fileRead, fileWrite, codeExecution, webAccess — each 'allow', 'deny', or 'ask')" },
            imageIds: { type: "array", items: { type: "string" }, description: "Previously uploaded image IDs to attach" },
            activePlugins: { type: "array", items: { type: "string" }, description: "Active plugin IDs" },
            maxTurns: { type: "number", description: "Maximum agentic turns before stopping (default: 200)" },
            systemPrompt: { type: "string", description: "Custom system prompt appended to Claude Code's preset system prompt" },
            agentAlias: { type: "string", description: "Agent alias — injects Callboard agent tools MCP server into the session" },
            model: { type: "string", description: "Model for the chat's provider. OpenRouter: a model slug (e.g. 'anthropic/claude-opus-4.7') or alias. Claude Code: an Anthropic model alias ('opus', 'sonnet', 'haiku', 'opusplan') or full model ID (e.g. 'claude-sonnet-4-6'). Omit to use the provider's global default." },
            requireExplicitCompletion: { type: "boolean", description: "Require the session to call the objective_complete tool before it is considered done; if the stream ends without it, the session is re-prompted to continue (up to a cap). Persisted for the chat. Default: false." },
            branchConfig: {
              type: "object",
              properties: {
                baseBranch: { type: "string", description: "Base branch to start from" },
                newBranch: { type: "string", description: "New branch name to create" },
                useWorktree: { type: "boolean", description: "Create a git worktree instead of switching branches in-place" },
                autoCreateBranch: { type: "boolean", description: "Auto-generate a branch name from the prompt" },
                forceBranchChange: { type: "boolean", description: "Skip uncommitted changes check when switching branches" }
              }
            }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "SSE stream with chat_created, message_update, permission_request, user_question, plan_review, message_complete, and message_error events" } */
  /* #swagger.responses[400] = { description: "Missing required fields or invalid folder" } */
  /* #swagger.responses[409] = { description: "Uncommitted changes block branch switch. Set forceBranchChange to override." } */
  const {
    folder,
    prompt,
    defaultPermissions,
    imageIds,
    activePlugins,
    branchConfig,
    maxTurns,
    systemPrompt,
    agentAlias,
    provider,
    effort,
    model,
    requireExplicitCompletion,
  } = req.body;
  log.debug(
    `POST /new/message — folder=${folder}, promptLen=${prompt?.length || 0}, images=${imageIds?.length || 0}, plugins=${activePlugins?.length || 0}, branchConfig=${JSON.stringify(branchConfig || null)}`,
  );
  if (!folder) return res.status(400).json({ error: "folder is required" });
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // Check if folder exists
  if (!existsSync(folder)) {
    return res.status(400).json({ error: "folder does not exist" });
  }

  // Resolve effective folder based on branch configuration
  let effectiveFolder = folder;
  if (branchConfig) {
    let { newBranch } = branchConfig;
    const { baseBranch, useWorktree, autoCreateBranch } = branchConfig;

    // Auto-generate branch name from the prompt if requested
    if (autoCreateBranch && !newBranch) {
      try {
        const generated = await generateBranchName(prompt);
        if (generated) {
          newBranch = generated;
          log.debug(`Auto-generated branch name: ${newBranch}`);
        } else {
          log.warn("Auto-generate branch name returned null, proceeding without new branch");
        }
      } catch (err: any) {
        log.warn(`Auto-generate branch name failed: ${err.message}, proceeding without new branch`);
      }
    }

    const branchResult = resolveBranch({
      folder,
      baseBranch,
      newBranch,
      useWorktree,
      forceBranchChange: branchConfig.forceBranchChange,
    });

    if (!branchResult.ok) {
      log.warn(`Blocked branch switch: ${branchResult.message}`);
      return res.status(409).json(branchResult);
    }

    effectiveFolder = branchResult.folder;
  }

  try {
    const imageMetadata = imageIds?.length ? loadImageBuffers(imageIds) : [];

    // Validate provider at the route boundary rather than relying on
    // resolveProviderKind's warn-and-fallback path. Anything not in the
    // allowlist is silently dropped — same outcome as omitting the field.
    const safeProvider: AgentProviderKind | undefined =
      typeof provider === "string" && VALID_PROVIDERS.has(provider as AgentProviderKind) ? (provider as AgentProviderKind) : undefined;

    // Effort forwarded only when paired with the openrouter provider — on a
    // claude-code chat it would be persisted to metadata for nothing and
    // confuse future debugging.
    const safeEffort: EffortLevel | undefined =
      safeProvider === "openrouter" && typeof effort === "string" && VALID_EFFORTS.has(effort) ? (effort as EffortLevel) : undefined;

    // Per-chat model override — honored for both providers. For openrouter it's
    // an OR slug/alias; for claude-code an Anthropic model alias or full ID.
    // Free-form text by design: the provider validates server-side, matching
    // the global Settings → API field.
    const safeModel: string | undefined = typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;

    const emitter = await sendMessage({
      prompt,
      folder: effectiveFolder,
      defaultPermissions,
      imageMetadata: imageMetadata.length > 0 ? imageMetadata : undefined,
      activePlugins,
      maxTurns,
      systemPrompt,
      agentAlias,
      ...(safeProvider && { provider: safeProvider }),
      ...(safeEffort && { effort: safeEffort }),
      ...(safeModel && { model: safeModel }),
      // Boolean-validated at the route boundary; anything else is dropped
      // (same outcome as omitting — the default behavior).
      ...(requireExplicitCompletion === true && { requireExplicitCompletion: true }),
    });

    writeSSEHeaders(res);

    // Custom handler for new chat — needs to intercept chat_created event
    const onEvent = (event: StreamEvent) => {
      if (event.type === "chat_created") {
        log.debug(`SSE chat_created — chatId=${event.chatId}`);
        // Store image metadata now that we have the chatId
        if (imageIds?.length && event.chatId) {
          storeMessageImages(event.chatId, imageIds).catch((err) => log.warn(`Failed to store message images: ${err.message}`));
        }
        sendSSE(res, { type: "chat_created", chatId: event.chatId, chat: event.chat });
        return;
      }

      if (event.type === "done") {
        log.debug(`SSE done — reason=${event.reason || "normal"}, costUsd=${event.costUsd ?? "n/a"}`);
        sendSSE(res, {
          type: "message_complete",
          ...(event.reason && { reason: event.reason }),
          ...(typeof event.costUsd === "number" && { costUsd: event.costUsd }),
          ...(typeof event.maxBudgetUsd === "number" && { maxBudgetUsd: event.maxBudgetUsd }),
          ...(typeof event.objectiveComplete === "boolean" && { objectiveComplete: event.objectiveComplete }),
        });
        emitter.removeListener("event", onEvent);
        res.end();
      } else if (event.type === "error") {
        log.error(`SSE error — ${event.content}`);
        sendSSE(res, { type: "message_error", content: event.content });
        emitter.removeListener("event", onEvent);
        res.end();
      } else if (event.type === "permission_request" || event.type === "user_question" || event.type === "plan_review") {
        sendSSE(res, event as unknown as Record<string, unknown>);
      } else if (event.type === "compacting") {
        sendSSE(res, { type: "compacting" });
      } else if (event.type === "cleared") {
        sendSSE(res, { type: "cleared" });
      } else if (event.type === "budget") {
        // Mid-run spend beacon (OpenRouter per-turn cost) — forwarded with
        // its payload, mirroring createSSEHandler in utils/sse.ts.
        sendSSE(res, {
          type: "budget",
          ...(typeof event.costUsd === "number" && { costUsd: event.costUsd }),
          ...(typeof event.maxBudgetUsd === "number" && { maxBudgetUsd: event.maxBudgetUsd }),
        });
      } else {
        sendSSE(res, { type: "message_update" });
      }
    };

    emitter.on("event", onEvent);

    req.on("close", () => {
      emitter.removeListener("event", onEvent);
    });
  } catch (err: any) {
    log.error(`POST /new/message failed: ${err.message}`);
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
            activePlugins: { type: "array", items: { type: "string" }, description: "Active plugin IDs" },
            maxTurns: { type: "number", description: "Maximum agentic turns before stopping (default: 200)" },
            acknowledgeBranchDrift: { type: "boolean", description: "Acknowledge and proceed despite branch drift (branch changed since last message)" },
            model: { type: "string", description: "Model to persist for this chat. OpenRouter chats: a model slug or alias. Claude Code chats: an Anthropic model alias ('opus', 'sonnet', 'haiku', 'opusplan') or full model ID. Empty string clears the per-chat override and reverts to the global default." },
            effort: { type: "string", enum: ["xhigh", "high", "medium", "low", "minimal", "none"], description: "OpenRouter reasoning-effort level to persist for this chat. Only honored when the chat's provider is 'openrouter'; ignored otherwise. Omit to leave the existing effort untouched; pass empty string to clear the per-chat override." },
            requireExplicitCompletion: { type: "boolean", description: "Override the chat's explicit-completion requirement for this message only. Omit to inherit the chat's persisted setting." }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "SSE stream with message_update, permission_request, message_complete, and message_error events" } */
  /* #swagger.responses[400] = { description: "Missing prompt" } */
  const { prompt, imageIds, activePlugins, maxTurns, acknowledgeBranchDrift, model, effort, requireExplicitCompletion } = req.body;
  log.debug(`POST /${req.params.id}/message — chatId=${req.params.id}, promptLen=${prompt?.length || 0}, images=${imageIds?.length || 0}`);
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // ── Branch drift guard ──────────────────────────────────────
  // If the git branch changed since the last message in this chat,
  // block unless the client explicitly acknowledges.
  const chatRecord = chatFileService.getChat(req.params.id);
  if (chatRecord) {
    const meta = JSON.parse(chatRecord.metadata || "{}");
    const currentGitInfo = getGitInfo(chatRecord.folder);
    const currentBranch = currentGitInfo.branch;

    if (meta.lastBranch && currentBranch && meta.lastBranch !== currentBranch && !acknowledgeBranchDrift) {
      log.warn(`Branch drift detected for chat ${req.params.id}: "${meta.lastBranch}" → "${currentBranch}"`);
      return res.status(409).json({
        error: "branch_drift",
        message: `The branch has changed from "${meta.lastBranch}" to "${currentBranch}" since your last message. Do you want to continue on "${currentBranch}"?`,
        lastBranch: meta.lastBranch,
        currentBranch,
      });
    }

    // Update lastBranch to current (after check passes)
    if (currentBranch) {
      chatFileService.updateChatMetadata(req.params.id, { lastBranch: currentBranch });
    }

    // Persist a per-chat model override before sendMessage re-reads
    // initialMetadata from disk. Honored for both providers — OR chats store
    // a slug/alias, claude-code chats an Anthropic model alias or full ID.
    // An empty string clears the override so the chat falls back to the
    // provider's global default (JSON.stringify drops undefined keys).
    if (typeof model === "string") {
      const trimmed = model.trim();
      chatFileService.updateChatMetadata(req.params.id, { model: trimmed.length > 0 ? trimmed : undefined });
    }

    // Same treatment for per-chat reasoning effort. Empty string clears the
    // override (so the chat falls back to the model default); any other
    // non-allowlisted value is silently dropped.
    if (typeof effort === "string" && meta.provider === "openrouter") {
      const trimmed = effort.trim();
      if (trimmed.length === 0) {
        chatFileService.updateChatMetadata(req.params.id, { effort: undefined });
      } else if (VALID_EFFORTS.has(trimmed)) {
        chatFileService.updateChatMetadata(req.params.id, { effort: trimmed });
      }
    }
  }
  // ── End branch drift guard ──────────────────────────────────

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
      maxTurns,
      // Per-message override; omitted (undefined) inherits the chat's
      // persisted requireExplicitCompletion setting.
      ...(typeof requireExplicitCompletion === "boolean" && { requireExplicitCompletion }),
    });

    writeSSEHeaders(res);

    const onEvent = createSSEHandler(res, emitter);
    emitter.on("event", onEvent);

    req.on("close", () => {
      emitter.removeListener("event", onEvent);
    });
  } catch (err: any) {
    log.error(`POST /${req.params.id}/message failed: ${err.message}`);
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
    const stopHeartbeat = startSSEHeartbeat(res);
    const onEvent = createSSEHandler(res, session.emitter);
    session.emitter.on("event", onEvent);

    req.on("close", () => {
      stopHeartbeat();
      session.emitter.removeListener("event", onEvent);
    });
    return;
  }

  // No web session - check if we can watch CLI session
  const chat = findChatForStatus(chatId);
  if (!chat?.session_id) {
    sendSSE(res, { type: "message_error", content: "No active session found" });
    res.end();
    return;
  }

  const logPath = findSessionLogPath(chat.session_id);
  if (!logPath || !existsSync(logPath)) {
    sendSSE(res, { type: "message_error", content: "Session log not found" });
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

  // Start the file watcher immediately, then define the handler below.
  // Re-stat the file to capture any bytes written between the initial stat
  // and now — prevents missing log lines in that gap.
  try {
    const freshStats = statSync(logPath);
    lastPosition = freshStats.size;
  } catch {}

  const stopHeartbeat = startSSEHeartbeat(res);

  // Track last activity time for inactivity timeout
  let lastActivityTime = Date.now();
  const CLI_INACTIVITY_TIMEOUT_MS = 300_000; // 5 minutes

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
              stopHeartbeat();
              unwatchFile(logPath, watchHandler);
              clearInterval(subagentScanInterval);
              clearInterval(inactivityCheckInterval);
              res.end();
              return;
            }
          } catch (err) {
            log.warn(`[CLI Monitor] Failed to parse log line: ${err instanceof Error ? err.message : "Unknown error"} Line: ${line.slice(0, 100)}`);
          }
        }
        lastPosition = newStats.size;
      }
    } catch (err) {
      log.warn(`[CLI Monitor] File watch error: ${err instanceof Error ? err.message : "Unknown error"}`);
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
      stopHeartbeat();
      unwatchFile(logPath, watchHandler);
      clearInterval(subagentScanInterval);
      clearInterval(inactivityCheckInterval);
      res.end();
    }
  }, 5000);

  req.on("close", () => {
    stopHeartbeat();
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

// Check session status - reads from the centralized session registry
streamRouter.get("/:id/status", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Check session status'
  // #swagger.description = 'Returns whether the session is active (web or CLI) by consulting the centralized session registry.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "Session status with active flag, type (web/cli/inactive), and hasPending" } */
  const chatId = req.params.id;

  const session = sessionRegistry.get(chatId);
  if (session) {
    return res.json({
      active: true,
      type: session.type,
      hasPending: hasPendingRequest(chatId),
    });
  }

  res.json({ active: false, type: "inactive" });
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
