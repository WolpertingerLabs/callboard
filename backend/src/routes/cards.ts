/**
 * Cards REST API — CRUD for cards (tickets) plus per-card rollups for the
 * /board view. Rollups scan all chats + runs per request, the same cost the
 * uncached chat list and folder summaries already pay. No TTL cache on
 * purpose: the frontend refetches ~300ms after a mutation bumps
 * metadataVersion, exactly when a cache would serve stale data.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { Card, CardPatch, CardSummary } from "shared";
import { listCards, getCard, createCard, updateCard } from "../services/card-store.js";
import { buildCardSummaries } from "../services/card-rollup.js";
import { chatFileService } from "../services/chat-file-service.js";
import { findChat } from "../utils/chat-lookup.js";
import { setChatCardMembership } from "../services/card-membership.js";
import { listRuns } from "../services/job-store.js";
import { sessionRegistry } from "../services/session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cards");

export const cardsRouter = Router();

function summarize(cards: Card[]): CardSummary[] {
  // Only card-bearing runs matter to a rollup; filtering here (not slicing the
  // newest N) keeps a long-dormant member run from silently dropping out.
  return buildCardSummaries(cards, chatFileService.getAllChats(), listRuns({ assignedToCard: true }));
}

cardsRouter.get("/", (_req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'List all cards with live rollups'
  try {
    const cards = summarize(listCards());
    // Pinned first, then most recent activity.
    cards.sort((a, b) => (a.pinned === b.pinned ? b.lastActivityAt.localeCompare(a.lastActivityAt) : a.pinned ? -1 : 1));
    res.json({ cards });
  } catch (err: any) {
    log.error(`Error listing cards: ${err}`);
    res.status(500).json({ error: "Failed to list cards", details: err.message });
  }
});

cardsRouter.post("/", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Create a card, optionally assigning an existing chat'
  /* #swagger.responses[201] = { description: "Created card with rollup" } */
  const { title, description, emoji, chatId } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  try {
    // Resolve the founding chat before creating the card so a bad chatId
    // can't leave an orphan card behind. findChat also covers chats that
    // only exist as filesystem sessions (no file-storage record yet).
    if (typeof chatId === "string" && chatId && !findChat(chatId, false)) {
      return res.status(404).json({ error: "Chat not found" });
    }

    const card = createCard({
      title,
      ...(typeof description === "string" && { description }),
      ...(typeof emoji === "string" && emoji && { emoji }),
    });

    // View-only assignment: doesn't bump the chat's updated_at, clears the
    // chat-list cache, handles filesystem-only chats.
    if (typeof chatId === "string" && chatId) setChatCardMembership(chatId, card.id);

    sessionRegistry.notifyMetadata(card.id, { cardEvent: "created" });
    res.status(201).json({ card: summarize([card])[0] });
  } catch (err: any) {
    log.error(`Error creating card: ${err}`);
    res.status(500).json({ error: "Failed to create card", details: err.message });
  }
});

cardsRouter.get("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Get a card with live rollup'
  /* #swagger.responses[404] = { description: "Card not found" } */
  const card = getCard(req.params.id);
  if (!card) return res.status(404).json({ error: "Card not found" });
  res.json({ card: summarize([card])[0] });
});

const PATCHABLE_FIELDS = ["title", "description", "emoji", "pinned", "status", "statusEmoji", "lifecycle", "metadata"] as const;

cardsRouter.patch("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Update a card (title, description, pin, narrative status, lifecycle, metadata)'
  /* #swagger.responses[404] = { description: "Card not found" } */
  const body = req.body ?? {};
  const patch: CardPatch = {};
  for (const field of PATCHABLE_FIELDS) {
    if (field in body) (patch as Record<string, unknown>)[field] = body[field];
  }
  // Validate types up front so a malformed body is a 400, not a 500 from a
  // downstream `.trim()` on null etc.
  if (patch.title !== undefined && typeof patch.title !== "string") {
    return res.status(400).json({ error: "title must be a string" });
  }
  if (patch.description !== undefined && typeof patch.description !== "string") {
    return res.status(400).json({ error: "description must be a string" });
  }
  if (patch.emoji !== undefined && typeof patch.emoji !== "string") {
    return res.status(400).json({ error: "emoji must be a string" });
  }
  if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") {
    return res.status(400).json({ error: "pinned must be a boolean" });
  }
  if (patch.status !== undefined && patch.status !== null && typeof patch.status !== "string") {
    return res.status(400).json({ error: "status must be a string or null" });
  }
  if (patch.statusEmoji !== undefined && patch.statusEmoji !== null && typeof patch.statusEmoji !== "string") {
    return res.status(400).json({ error: "statusEmoji must be a string or null" });
  }
  if (patch.lifecycle !== undefined && patch.lifecycle !== "open" && patch.lifecycle !== "closed") {
    return res.status(400).json({ error: "lifecycle must be 'open' or 'closed'" });
  }
  if (patch.metadata !== undefined) {
    // Merge-patch object: string values set keys, null values remove them.
    if (typeof patch.metadata !== "object" || patch.metadata === null || Array.isArray(patch.metadata)) {
      return res.status(400).json({ error: "metadata must be an object of string (or null-to-remove) values" });
    }
    for (const value of Object.values(patch.metadata)) {
      if (value !== null && typeof value !== "string") {
        return res.status(400).json({ error: "metadata values must be strings or null" });
      }
    }
  }
  try {
    const card = updateCard(req.params.id, patch);
    if (!card) return res.status(404).json({ error: "Card not found" });
    sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" });
    res.json({ card: summarize([card])[0] });
  } catch (err: any) {
    // Store-level validation failures (blank title, metadata limits) are 400s.
    if (/title|metadata/i.test(err.message ?? "")) return res.status(400).json({ error: err.message });
    log.error(`Error updating card: ${err}`);
    res.status(500).json({ error: "Failed to update card", details: err.message });
  }
});
