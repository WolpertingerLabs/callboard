import { Router } from "express";
import { sendMessage, getActiveSession, stopSession, respondToPermission, hasPendingRequest, getPendingRequest, type StreamEvent } from "../services/claude.js";
import { isRoutableProvider, type AgentProviderKind } from "../agents/ports/AgentProvider.js";
import { sendRetiredProviderError } from "../utils/route-errors.js";
import { listAcpVendorIds, resolveAcpVendorPreset } from "../agents/adapters/acp/vendors.js";
import type { EffortLevel } from "shared/types/index.js";
import { sessionRegistry } from "../services/session-registry.js";
import { loadImageBuffers } from "../services/image-storage.js";
import { storeMessageImages } from "../services/image-metadata.js";
import { statSync, existsSync, readdirSync, watchFile, unwatchFile, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { getGitInfo, resolveBranch } from "../utils/git.js";
import { chatFileService } from "../services/chat-file-service.js";
import { findSessionLogPath } from "../utils/session-log.js";
import { findChatForStatus } from "../utils/chat-lookup.js";
import { beginSSE, sendSSE, createSSEHandler, startSSEHeartbeat } from "../utils/sse.js";
import { createLogger } from "../utils/logger.js";
import { generateBranchName } from "../services/quick-completion.js";
import { captureWorktreeWorkspace } from "../services/workspace-store.js";
import { listActivities, getWatch, releaseActivity } from "../services/chat-activity.js";
import { listPendingForParent } from "../services/session-callbacks.js";
import type { ChatActivityResponse } from "shared/types/index.js";

const log = createLogger("stream");

// Defense-in-depth allowlist shared by /new/message (initial creation) and
// /:id/message (mid-chat updates). Anything not allowed is silently dropped at
// the route boundary so we never persist garbage to chat metadata. Provider
// values are narrowed with the shared `isRoutableProvider` guard (see
// AgentProvider.ts) rather than a local copy of the routable-kinds set.
const VALID_EFFORTS: ReadonlySet<string> = new Set(["xhigh", "high", "medium", "low", "minimal", "none"]);

export const streamRouter = Router();

// Send first message to create a new chat (no existing chat ID required)
streamRouter.post("/new/message", async (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Create new chat with first message'
  // #swagger.description = 'Starts a new Claude session in the given folder and streams the response via SSE. Optionally creates a git worktree or branch. Returns a chat_created event followed by message_update events. Clients may advertise their wire capabilities with the optional X-Callboard-Protocol / X-Callboard-Caps headers; omitting them is always safe.'
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
            defaultPermissions: { type: "object", description: "Default tool permissions (fileRead, fileWrite, codeExecution, webAccess — each one of allow, deny, or ask)" },
            imageIds: { type: "array", items: { type: "string" }, description: "Previously uploaded image IDs to attach" },
            activePlugins: { type: "array", items: { type: "string" }, description: "Active plugin IDs" },
            maxTurns: { type: "number", description: "Maximum agentic turns before stopping (default: 200)" },
            systemPrompt: { type: "string", description: "Custom system prompt appended to the Claude Code preset system prompt" },
            agentAlias: { type: "string", description: "Agent alias — injects Callboard agent tools MCP server into the session" },
            model: { type: "string", description: "Model for the provider of the chat. OpenRouter: a model slug (e.g. anthropic/claude-opus-4.7) or alias. Claude Code: an Anthropic model alias (opus, sonnet, haiku, opusplan) or full model ID (e.g. claude-sonnet-4-6). Omit to use the global default of the provider." },
            requireExplicitCompletion: { type: "boolean", description: "Require the session to call the objective_complete tool before it is considered done; if the stream ends without it, the session is re-prompted to continue (up to a cap). Persisted for the chat. Default: false." },
            parentChatId: { type: "string", description: "Chat ID of the chat that spawned this one — links the new chat into the cross-engine chat parentage tree. Ignored when the parent has no stored record." },
            chatRole: { type: "string", description: "Free-form role label (max 40 chars) for the tree node of the new chat, e.g. subagent, monitor, engine-switch. Only used with parentChatId." },
            cardId: { type: "string", description: "Deprecated no-op. Cards are derived from the chat lineage tree — a top-level chat is a card automatically and every child joins its root. Accepted (and ignored) so older clients keep working." },
            createCard: { type: "boolean", description: "Deprecated no-op. A top-level chat is a card automatically; use PATCH /api/cards/{rootChatId} with hidden:true to opt a card out of the board. Accepted (and ignored) so older clients keep working." },
            cardCategory: { type: "string", description: "Deprecated no-op (was used with createCard). Use PATCH /api/cards/{rootChatId} to set the category. Accepted and ignored." },
            acpProviderId: { type: "string", description: "Which ACP vendor runs the chat. Required when provider is \'acp\', ignored otherwise. Must name a configured preset (see GET /api/system-info acpProviders)." },
            clientTrackingId: { type: "string", description: "Client-generated temporary session id (must match new-<alphanumeric/_/->, max 80 chars) used as the session key until the real chat id exists, so POST /api/chats/{clientTrackingId}/stop can cancel the run during startup. Ignored when malformed or already in use." },
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
  /* #swagger.responses[200] = { description: "SSE stream opening with a server_info frame, then chat_created, message_update, permission_request, user_question, plan_review, message_complete, and message_error events" } */
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
    acpProviderId,
    effort,
    model,
    requireExplicitCompletion,
    parentChatId,
    chatRole,
    cardId,
    createCard,
    cardCategory,
    clientTrackingId,
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
  let workspaceId: string | undefined;
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
    // Record why the worktree exists while we still know. Nothing reads this
    // yet (see plans/workspace-object.md, Phase 1) and it never throws, so a
    // failure here leaves the chat exactly as it was before.
    workspaceId = captureWorktreeWorkspace(branchResult);
  }

  try {
    const imageMetadata = imageIds?.length ? loadImageBuffers(imageIds) : [];

    // Validate provider at the route boundary rather than relying on
    // resolveProviderKind's warn-and-fallback path. Anything not in the
    // allowlist is silently dropped — same outcome as omitting the field.
    const safeProvider: AgentProviderKind | undefined = isRoutableProvider(provider) ? provider : undefined;

    // `"acp"` is one kind covering many vendors, so it is the only kind whose
    // request is incomplete without a second field. An unknown or missing
    // `acpProviderId` is rejected outright rather than dropped like the other
    // optional knobs: silently falling back to Claude Code would start a chat on
    // a harness the user did not pick, and persisting `provider: "acp"` with no
    // vendor would wedge the chat permanently — the exact failure that kept
    // `"acp"` out of the routable list until this endpoint existed.
    let safeAcpProviderId: string | undefined;
    if (safeProvider === "acp") {
      const requested = typeof acpProviderId === "string" ? acpProviderId.trim() : "";
      if (!resolveAcpVendorPreset(requested)) {
        return res.status(400).json({
          error: requested
            ? `Unknown ACP provider "${requested}". Configured providers: ${listAcpVendorIds().join(", ")}`
            : `acpProviderId is required when provider is "acp". Configured providers: ${listAcpVendorIds().join(", ")}`,
        });
      }
      safeAcpProviderId = requested;
    }

    // Effort forwarded only when paired with a reasoning-capable provider
    // (codex → modelReasoningEffort, cline → Cline `thinking`/`reasoningEffort`,
    // pi → `thinkingLevel`). On a claude-code chat it would be
    // persisted to metadata for nothing and confuse future debugging.
    const effortCapableProvider = safeProvider === "codex" || safeProvider === "cline" || safeProvider === "pi";
    const safeEffort: EffortLevel | undefined =
      effortCapableProvider && typeof effort === "string" && VALID_EFFORTS.has(effort) ? (effort as EffortLevel) : undefined;

    // Per-chat model override — honored for every provider. For claude-code an
    // Anthropic model alias or full ID; for codex/cline/pi that harness's slug.
    // Free-form text by design: the provider validates server-side, matching
    // the global Settings → API field.
    const safeModel: string | undefined = typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;

    // `modelRouting` / `modelRoutingRankId` may still arrive from an older client
    // bundle and are deliberately ignored: model routing was an OpenRouter-only
    // opt-in and the harness is gone. Ignoring beats a 400 for a field nothing
    // can act on either way.

    // `cardId` / `createCard` / `cardCategory` are deprecated no-ops: cards
    // are now derived from the lineage tree, so there is nothing to attach
    // and nothing to create. They stay in the destructuring (and the swagger
    // schema above) so an older client bundle still sending them gets today's
    // behavior rather than a 4xx on a field nothing can act on either way.
    void cardId;
    void createCard;
    void cardCategory;

    // Temp session key the client can address /stop with before chat_created
    // arrives. Namespaced to "new-" so a caller can't claim (and then stop) the
    // registry slot of a real chat id.
    const safeClientTrackingId: string | undefined =
      typeof clientTrackingId === "string" && clientTrackingId.length <= 80 && /^new-[A-Za-z0-9_-]+$/.test(clientTrackingId) ? clientTrackingId : undefined;

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
      ...(safeAcpProviderId && { acpProviderId: safeAcpProviderId }),
      ...(safeEffort && { effort: safeEffort }),
      ...(safeModel && { model: safeModel }),
      ...(safeClientTrackingId && { clientTrackingId: safeClientTrackingId }),
      ...(workspaceId && { workspaceId }),
      // Boolean-validated at the route boundary; anything else is dropped
      // (same outcome as omitting — the default behavior).
      ...(requireExplicitCompletion === true && { requireExplicitCompletion: true }),
      // Parentage-tree linkage — sendMessage skips it silently when the
      // parent has no stored record. This is also what makes the new chat a
      // member of its root's card: membership is lineage, so nothing else
      // is passed for cards.
      ...(typeof parentChatId === "string" &&
        parentChatId && {
          parentChatId,
          ...(typeof chatRole === "string" && chatRole && { chatRole }),
        }),
    });

    // Opens the stream and answers the client's capability handshake with a
    // server_info frame. The returned session isn't consulted yet — every
    // event below still emits unconditionally (see stream-session.ts).
    beginSSE(req, res);

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
          // Mirrors createSSEHandler in utils/sse.ts — background tasks that
          // died with the subprocess, so a killed one can be drawn as killed.
          ...(event.abandonedBackgroundTaskIds?.length && { abandonedBackgroundTaskIds: event.abandonedBackgroundTaskIds }),
        });
        emitter.removeListener("event", onEvent);
        res.end();
      } else if (event.type === "error") {
        log.error(`SSE error — ${event.content}`);
        sendSSE(res, {
          type: "message_error",
          content: event.content,
          // Mirrors createSSEHandler — an error ends the run without a `done`,
          // so this is its only chance to name the shells that died with it.
          ...(event.abandonedBackgroundTaskIds?.length && { abandonedBackgroundTaskIds: event.abandonedBackgroundTaskIds }),
        });
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
  // #swagger.description = 'Sends a user message to an existing chat session and streams the response via SSE. Clients may advertise their wire capabilities with the optional X-Callboard-Protocol / X-Callboard-Caps headers; omitting them is always safe.'
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
            model: { type: "string", description: "Model to persist for this chat. Claude Code chats: an Anthropic model alias (opus, sonnet, haiku, opusplan) or full model ID. Other harnesses: whatever model identifier that harness accepts. Empty string clears the per-chat override and reverts to the global default." },
            effort: { type: "string", enum: ["xhigh", "high", "medium", "low", "minimal", "none"], description: "Reasoning-effort level to persist for this chat. Only honored for harnesses that take one (codex, cline, pi); ignored otherwise. Omit to leave the existing effort untouched; pass empty string to clear the per-chat override." },
            requireExplicitCompletion: { type: "boolean", description: "Override the explicit-completion requirement for this message only. Omit to inherit the persisted setting of the chat." }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "SSE stream opening with a server_info frame, then message_update, permission_request, message_complete, and message_error events" } */
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
    // initialMetadata from disk. Honored for every harness — each stores the
    // identifier its own engine accepts. An empty string clears the override so
    // the chat falls back to the provider's global default (JSON.stringify
    // drops undefined keys).
    if (typeof model === "string") {
      const trimmed = model.trim();
      chatFileService.updateChatMetadata(req.params.id, { model: trimmed.length > 0 ? trimmed : undefined });
    }

    // Same treatment for per-chat reasoning effort, for the harnesses that take
    // one. Empty string clears the override (so the chat falls back to the model
    // default); any other non-allowlisted value is silently dropped.
    //
    // `"openrouter"` was in this list until Phase 4 of the OR removal. It sits
    // ahead of the `sendMessage` call that refuses such a chat, so it was still
    // reachable — writing an effort value onto a chat that can never run again.
    if (typeof effort === "string" && (meta.provider === "codex" || meta.provider === "cline" || meta.provider === "pi")) {
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

    beginSSE(req, res);

    const onEvent = createSSEHandler(res, emitter);
    emitter.on("event", onEvent);

    req.on("close", () => {
      emitter.removeListener("event", onEvent);
    });
  } catch (err: any) {
    // A chat pinned to a removed harness is a client-state condition, not a
    // server fault — see sendRetiredProviderError. Logged at warn for the same
    // reason: nothing here needs fixing.
    if (sendRetiredProviderError(res, err)) {
      log.warn(`POST /${req.params.id}/message refused: ${err.message}`);
      return;
    }
    log.error(`POST /${req.params.id}/message failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint for connecting to an active stream (web or CLI)
streamRouter.get("/:id/stream", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Connect to active stream'
  // #swagger.description = 'SSE endpoint to receive real-time updates from an active web or CLI session. For CLI sessions, watches the JSONL log file for changes. Clients may advertise their wire capabilities with the optional X-Callboard-Protocol / X-Callboard-Caps headers; omitting them is always safe.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "SSE stream opening with a server_info frame, then message_update, message_complete, and message_error events" } */
  const chatId = req.params.id;
  const session = getActiveSession(chatId);

  beginSSE(req, res);

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
            // A background task's completion notice arrives as a queued-command
            // attachment, which carries no `message.content` — without this it
            // would sit unrendered until the agent's next output happened to
            // poke a refetch.
            if (parsed.message?.content || parsed.attachment?.commandMode === "task-notification") {
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

/**
 * What this chat is currently blocked on.
 *
 * Deliberately REST rather than a new SSE event. `createSSEHandler` collapses
 * everything it does not explicitly handle into a bare `message_update` with
 * no payload, so activity data cannot ride on the `tool_use` frame — and a new
 * frame type would need the capability gate that no emit site consults yet.
 * It does not need to: a countdown is client-side arithmetic once the client
 * knows `startedAt` and `expiresAt`, and the bare `message_update` the tool
 * call already emits is a sufficient nudge to refetch. This also makes
 * refresh, reconnect and a second tab work through one code path — the same
 * one `/pending` uses.
 */
streamRouter.get("/:id/activity", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Get in-flight activity'
  // #swagger.description = 'What this chat is currently blocked on: long-running tool calls (a wait countdown, a delegated session), any open condition watch, and the number of spawned children it is awaiting. Used for the live activity dock, and on reconnect after a page refresh.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "Open activities, the condition watch if any, and the awaited-children count" } */
  const chatId = req.params.id;
  res.json({
    activities: listActivities(chatId),
    conditionWatch: getWatch(chatId) ?? null,
    awaitingChildren: listPendingForParent(chatId).length,
  } satisfies ChatActivityResponse);
});

/**
 * End an interruptible activity early on the user's behalf.
 *
 * Only `wait` qualifies. The other kinds are the agent awaiting work it
 * delegated, where returning early would hand the caller an empty result while
 * the delegate kept running — so the registry refuses them and this 404s.
 */
streamRouter.post("/:id/activity/:activityId/release", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'End an activity early'
  // #swagger.description = 'End an interruptible in-flight activity (currently only a wait) before its timer elapses, so the agent resumes immediately. The agent is told it was cut short and by whom. Activities representing delegated work are not interruptible and are refused.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.parameters['activityId'] = { in: 'path', required: true, type: 'string', description: 'Activity ID from GET /:id/activity' } */
  /* #swagger.responses[200] = { description: "{ ok: true, kind } when the activity was released" } */
  /* #swagger.responses[404] = { description: "No such activity, or it is not interruptible" } */
  const outcome = releaseActivity(req.params.id, req.params.activityId, "user");
  if (!outcome.ok) {
    return res.status(404).json({
      error: outcome.reason === "not_interruptible" ? "That activity cannot be ended early — the agent is waiting on work it delegated" : "No such activity",
      reason: outcome.reason,
    });
  }
  log.info(`Activity ${req.params.activityId} on ${req.params.id} ended early by user`);
  res.json({ ok: true, kind: outcome.kind });
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
streamRouter.post("/:id/stop", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Stop execution'
  // #swagger.description = 'Cancel the running session for this chat: aborts the run and terminates the underlying provider request (subprocess / in-flight API call), not just the SSE stream. The run emits a final message_complete with reason "aborted" on its stream as it unwinds. Accepts a chat id or, for a chat still being created, the clientTrackingId passed to /new/message.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID (or a new chat\'s clientTrackingId)' } */
  /* #swagger.responses[200] = { description: "{ stopped: true } when a live web session was cancelled; { stopped: false } when there was nothing to stop (already finished, or a CLI session the server does not control)" } */
  const chatId = req.params.id;
  const stopped = stopSession(chatId);
  // Worth an info line: this is a deliberate user cancellation, and the run's
  // own "ended: aborted" log lands right after it.
  if (stopped) log.info(`Session ${chatId} cancelled by user`);
  else log.debug(`POST /${chatId}/stop — no stoppable web session`);
  res.json({ stopped });
});
