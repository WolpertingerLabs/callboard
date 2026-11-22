/**
 * Held messages — "Send when idle" (`/api/chats/:id/held`).
 *
 * A message held while the chat is running goes out as a normal message once
 * that run ends; see `held-message-service.ts` (store) and
 * `held-message-dispatcher.ts` (delivery). These routes only hold, list, take
 * back, remove and resume — they never start a turn on an idle chat except
 * through `resume`.
 *
 * Mounted on `/api/chats` with the full `/:id/held…` paths spelled out, like
 * the other chat-scoped routers, so swagger-autogen sees the real paths.
 */
import { Router } from "express";
import type { HeldMessage } from "shared/types/index.js";
import { heldMessageService, isValidHeldChatId, isValidHeldId, type HeldMessageInput } from "../services/held-message-service.js";
import { handleChatIdle } from "../services/session-completion-handler.js";
import { hasTimedOutStart } from "../services/held-message-dispatcher.js";
import { getActiveSession } from "../services/claude.js";
import { sessionRegistry } from "../services/session-registry.js";
import { assertNativeAgentControllable } from "../services/codex-native-agents.js";
import { isRetiredProvider, RETIRED_PROVIDER_LABELS } from "../agents/ports/AgentProvider.js";
import { chatFileService } from "../services/chat-file-service.js";
import { findChatForStatus } from "../utils/chat-lookup.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { parseDraftImages } from "./queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("held-routes");

export const heldRouter = Router();

/** Longest held prompt accepted — generous; it only bounds a JSON file. */
const MAX_TEXT_LENGTH = 1_000_000;

// Every `:id` becomes a file name under DATA_DIR/held, percent-decoded by
// Express (`..%2Fvictim` arrives as `../victim`); refuse anything that is not
// a plain id before a handler sees it. The service checks again.
heldRouter.param("id", (req, res, next, id) => {
  if (!isValidHeldChatId(id)) {
    res.status(400).json({ error: "Invalid chat id" });
    return;
  }
  next();
});
heldRouter.param("hid", (req, res, next, hid) => {
  if (!isValidHeldId(hid)) {
    res.status(400).json({ error: "Invalid held message id" });
    return;
  }
  next();
});

/**
 * Running, or a turn on its way — the only states a message can be held
 * against. A "starting" mark left by a held delivery the dispatcher already
 * timed out does not count: that start may never settle, and a hold queued
 * behind it would wait for a stop that might not come.
 */
function isRunningOrStarting(chatId: string): boolean {
  if (getActiveSession(chatId)) return true;
  return sessionRegistry.isStarting(chatId) && !hasTimedOutStart(chatId);
}

type Parsed = { ok: true; input: HeldMessageInput } | { ok: false; error: string };

/** Validate a hold request body. Synchronous, so the route can check-and-write with no await between. */
function parseHoldBody(body: any): Parsed {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const { text, activePlugins, model, effort, maxTurns } = body;
  if (text !== undefined && typeof text !== "string") return { ok: false, error: "text must be a string" };
  if (typeof text === "string" && text.length > MAX_TEXT_LENGTH) return { ok: false, error: "text is too long" };
  const images = parseDraftImages(body.images);
  if (images === null) return { ok: false, error: "images must be a list of { id, originalName } with upload ids" };
  if (!text && !images?.length) return { ok: false, error: "text or images is required" };
  if (activePlugins !== undefined && (!Array.isArray(activePlugins) || activePlugins.some((p: unknown) => typeof p !== "string"))) {
    return { ok: false, error: "activePlugins must be a list of strings" };
  }
  if (model !== undefined && typeof model !== "string") return { ok: false, error: "model must be a string" };
  if (effort !== undefined && typeof effort !== "string") return { ok: false, error: "effort must be a string" };
  if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)) {
    return { ok: false, error: "maxTurns must be a positive integer" };
  }
  return {
    ok: true,
    input: {
      text: text ?? "",
      ...(images?.length ? { images } : {}),
      ...(activePlugins !== undefined && { activePlugins }),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      ...(maxTurns !== undefined && { maxTurns }),
    },
  };
}

heldRouter.get("/:id/held", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'List held messages'
  // #swagger.description = 'Messages held until this chat\'s current turn ends ("Send when idle"), in delivery order. The same list is returned as heldMessages by GET /chats/:id/activity.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "{ heldMessages: HeldMessage[] }" } */
  res.json({ heldMessages: heldMessageService.list(req.params.id) });
});

heldRouter.post("/:id/held", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Hold a message until the turn ends'
  // #swagger.description = 'Holds a message on a running chat; the daemon sends it as a normal message (its own turn, with its attachments and settings) once the current turn ends, whether or not any client is connected. Several held messages go out in order, one turn each. Only accepted while the chat has a live web run (or one starting): on an idle chat this answers 409 not_running and the client should send normally instead. Stopping the run pauses held messages; a daemon restart pauses them too. A message that cannot start when its turn comes (branch drift, a missing attachment, any send refusal) is kept as failed with the reason. Refused for native subagents and chats on a retired harness.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The message. May be empty when images is non-empty" },
            images: { type: "array", items: { type: "object", properties: { id: { type: "string" }, originalName: { type: "string" } } }, description: "Uploaded attachments (ids from POST /images/upload), as on drafts" },
            activePlugins: { type: "array", items: { type: "string" }, description: "Active plugin IDs for the turn, as on POST /chats/:id/message" },
            model: { type: "string", description: "Model to persist when the message is sent, as on POST /chats/:id/message" },
            effort: { type: "string", description: "Reasoning effort to persist when the message is sent, as on POST /chats/:id/message" },
            maxTurns: { type: "number", description: "Maximum agentic turns for the turn" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[201] = { description: "{ heldMessage, heldMessages } — the new item and the chat's whole list" } */
  /* #swagger.responses[400] = { description: "Invalid body (no text and no images, bad image ids, bad settings)" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  /* #swagger.responses[409] = { description: "{ code: \"not_running\" } when the chat is idle — send normally instead; or native_child_read_only" } */
  /* #swagger.responses[410] = { description: "The chat ran on a retired harness" } */
  const chatId = req.params.id;
  const parsed = parseHoldBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    assertNativeAgentControllable(chatId);
  } catch (error) {
    return res.status(409).json({ error: "native_child_read_only", message: (error as Error).message });
  }
  const chat = chatFileService.getChat(chatId) ?? findChatForStatus(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  const provider = parseChatMetadata(chat.metadata).provider;
  if (isRetiredProvider(provider)) {
    return res.status(410).json({
      error: `This chat ran on ${RETIRED_PROVIDER_LABELS[provider]}, which has been removed. It cannot be resumed.`,
      code: "retired_provider",
    });
  }

  // Check and write in one synchronous stretch: a run that ends between them
  // would emit its stop before the item exists, and the item would wait for a
  // stop that never comes. With no await here, the stop is handled either
  // before this check (→ not_running, the client sends normally) or after the
  // write (→ the dispatcher delivers it).
  if (!isRunningOrStarting(chatId)) {
    return res.status(409).json({ error: "The chat is not running; send the message normally.", code: "not_running" });
  }
  const heldMessage = heldMessageService.add(chatId, parsed.input);
  log.info(`Held message ${heldMessage.id} on ${chatId} until its turn ends`);
  res.status(201).json({ heldMessage, heldMessages: heldMessageService.list(chatId) });
});

heldRouter.post("/:id/held/resume", async (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Resume held messages'
  // #swagger.description = 'Re-queues every paused or failed held message. If the chat is idle, the first one is sent now; otherwise they go out when the current turn ends.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.responses[200] = { description: "{ resumed, started, heldMessages } — how many items were re-queued, whether a turn was started now, and the list after" } */
  const chatId = req.params.id;
  const resumed = heldMessageService.resume(chatId);
  // Through the completion handler, not the dispatcher directly: under its
  // per-chat guard, and followed by completion callbacks — so a callback that
  // became ready while a resumed delivery was being refused is still sent,
  // rather than waiting for some unrelated session to stop. Refuses a running
  // or starting chat itself.
  const started = await handleChatIdle(chatId);
  res.json({ resumed, started, heldMessages: heldMessageService.list(chatId) });
});

/** The 404 / 409 for a take or remove that did not happen. */
function refuse(res: import("express").Response, reason: "not_found" | "delivering") {
  if (reason === "delivering") return res.status(409).json({ error: "This message is being sent right now.", code: "delivering" });
  return res.status(404).json({ error: "Held message not found — it may already have been sent.", code: "not_found" });
}

heldRouter.post("/:id/held/:hid/take", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Take a held message back'
  // #swagger.description = 'Removes a held message and returns it, so the client can edit it or send it now. Atomic with delivery: refused while the message is being sent (409), and 404 once it has been.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.parameters['hid'] = { in: 'path', required: true, type: 'string', description: 'Held message ID' } */
  /* #swagger.responses[200] = { description: "{ heldMessage } — the removed item" } */
  /* #swagger.responses[404] = { description: "No such held message (already sent or removed)" } */
  /* #swagger.responses[409] = { description: "{ code: \"delivering\" } — it is being sent right now" } */
  const result = heldMessageService.take(req.params.id, req.params.hid);
  if (!result.ok) return refuse(res, result.reason);
  const heldMessage: HeldMessage = result.item;
  res.json({ heldMessage });
});

heldRouter.delete("/:id/held/:hid", (req, res) => {
  // #swagger.tags = ['Stream']
  // #swagger.summary = 'Remove a held message'
  // #swagger.description = 'Removes a held message without sending it. Refused while it is being sent (409).'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.parameters['hid'] = { in: 'path', required: true, type: 'string', description: 'Held message ID' } */
  /* #swagger.responses[200] = { description: "{ heldMessages } — the list after" } */
  /* #swagger.responses[404] = { description: "No such held message" } */
  /* #swagger.responses[409] = { description: "{ code: \"delivering\" } — it is being sent right now" } */
  const result = heldMessageService.remove(req.params.id, req.params.hid);
  if (!result.ok) return refuse(res, result.reason);
  res.json({ heldMessages: heldMessageService.list(req.params.id) });
});
