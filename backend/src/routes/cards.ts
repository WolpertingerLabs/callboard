/**
 * Cards REST API — CRUD for cards (tickets) plus per-card rollups for the
 * /board view.
 *
 * A rollup is recomputed per request, and deliberately so: the board and the
 * sidebar both refetch ~300 ms after a mutation bumps metadataVersion, which
 * is exactly when a response cache would serve stale data. That leaves the
 * cost of a recompute as the thing to hold down, and it is *blocked event
 * loop* — the handler is one synchronous block, so while it runs nothing else
 * in the daemon does. Membership comes from the stat-gated index in
 * card-member-index.ts for that reason; the ~8k-record scan it replaced was
 * measured at up to 1.9 s of frozen daemon per request.
 *
 * The sibling listings (`GET /api/chats`, `GET /api/chats/folders`) took the
 * other route out of the same problem — a short TTL plus a fingerprint of the
 * state that moves without a request. That does not transfer here: the state
 * this route reads *is* the chat corpus, so validating an entry would cost the
 * same scan the entry exists to avoid.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { Card, CardPatch, CardSummary } from "shared";
import { listCards, getCard, createCard, updateCard, deleteCard, CardValidationError, CARD_CATEGORY_MAX } from "../services/card-store.js";
import { buildCardSummaries } from "../services/card-rollup.js";
import { listCardMemberChats } from "../services/card-member-index.js";
import { validateMetadataPatch } from "../services/card-metadata-args.js";
import { findChat } from "../utils/chat-lookup.js";
import { setChatCardMembership, unassignAllChatsFromCard } from "../services/card-membership.js";
import { listRuns } from "../services/job-store.js";
import { clearListCaches } from "../services/list-caches.js";
import { sessionRegistry } from "../services/session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cards");

export const cardsRouter = Router();

function summarize(cards: Card[]): CardSummary[] {
  // Only card-bearing chats and runs matter to a rollup; filtering both here
  // (not slicing the newest N) keeps a long-dormant member from silently
  // dropping out. The chats come from the stat-gated index rather than a fresh
  // read of all ~8k records: the same set for a fifth of the blocked event
  // loop, which on this route is the cost that matters (see the module header
  // of card-member-index.ts).
  return buildCardSummaries(cards, listCardMemberChats(), listRuns({ assignedToCard: true }));
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
  const { title, description, emoji, category, chatId } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  if (category !== undefined && typeof category !== "string") {
    return res.status(400).json({ error: "category must be a string" });
  }
  // Reject rather than let the store truncate: a silently clipped label would
  // group the card somewhere the caller never asked for. Matches the MCP
  // tool's zod .max().
  if (typeof category === "string" && category.trim().length > CARD_CATEGORY_MAX) {
    return res.status(400).json({ error: `category exceeds ${CARD_CATEGORY_MAX} characters` });
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
      ...(typeof category === "string" && category.trim() && { category }),
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

/**
 * Upper bound on one bulk lifecycle batch. Every id is a synchronous
 * read-merge-write against its own file on the event loop thread, so an
 * uncapped list is an unbounded stall for every other request.
 */
export const BULK_LIFECYCLE_MAX = 200;

/**
 * Bulk close/reopen for the board's multi-select.
 *
 * POST, not `PATCH /bulk`, and deliberately so: Express matches in
 * registration order, so a `patch("/bulk")` sitting below `patch("/:id")`
 * resolves to the single-card handler with `id="bulk"`, fails CARD_ID_RE in
 * card-store, and answers 404 "Card not found" — a routing bug wearing a data
 * bug's clothes. There is no `post("/:id")`, so this path cannot be shadowed
 * no matter where it is registered or how the file is later reordered.
 *
 * Partial success is a 200 with a populated `failed[]`, not an error status:
 * a missing id in the middle of a batch must not strand the rest, and the
 * client still needs `updated` to merge into its state.
 */
cardsRouter.post("/bulk-lifecycle", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Close or reopen many cards in one call; per-id failures are reported, not fatal'
  /* #swagger.responses[200] = { description: "Updated card summaries plus per-id failures" } */
  const { ids, lifecycle } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id: unknown) => typeof id !== "string")) {
    return res.status(400).json({ error: "ids must be a non-empty array of strings" });
  }
  if (ids.length > BULK_LIFECYCLE_MAX) {
    return res.status(400).json({ error: `ids is limited to ${BULK_LIFECYCLE_MAX} entries` });
  }
  if (lifecycle !== "open" && lifecycle !== "closed") {
    return res.status(400).json({ error: "lifecycle must be 'open' or 'closed'" });
  }
  try {
    const updated: Card[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids as string[]) {
      try {
        const card = updateCard(id, { lifecycle });
        if (card) updated.push(card);
        else failed.push({ id, error: "Card not found" });
      } catch (err: any) {
        log.error(`Error updating card ${id} in bulk lifecycle: ${err}`);
        failed.push({ id, error: err?.message ?? "Failed to update card" });
      }
    }
    if (updated.length > 0) {
      // Once for the batch, same reason as the single-card patch: a lifecycle
      // flip moves which chats the sidebar's cards-only filter admits.
      clearListCaches();
      // Also once for the batch, not once per card. The board refetches its
      // whole card list on any metadata bump (300ms debounce), so N
      // notifications would be N SSE frames driving one identical refetch.
      sessionRegistry.notifyMetadata(updated[0].id, { cardEvent: "updated" });
    }
    res.json({ updated: summarize(updated), failed });
  } catch (err: any) {
    log.error(`Error in bulk lifecycle update: ${err}`);
    res.status(500).json({ error: "Failed to update cards", details: err.message });
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

const PATCHABLE_FIELDS = ["title", "description", "emoji", "pinned", "status", "statusEmoji", "category", "lifecycle", "metadata"] as const;

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
  if (patch.category !== undefined && patch.category !== null && typeof patch.category !== "string") {
    return res.status(400).json({ error: "category must be a string or null" });
  }
  if (typeof patch.category === "string" && patch.category.trim().length > CARD_CATEGORY_MAX) {
    return res.status(400).json({ error: `category exceeds ${CARD_CATEGORY_MAX} characters` });
  }
  if (patch.lifecycle !== undefined && patch.lifecycle !== "open" && patch.lifecycle !== "closed") {
    return res.status(400).json({ error: "lifecycle must be 'open' or 'closed'" });
  }
  if (patch.metadata !== undefined) {
    const metadataError = validateMetadataPatch(patch.metadata);
    if (metadataError) return res.status(400).json({ error: metadataError });
  }
  try {
    const card = updateCard(req.params.id, patch);
    if (!card) return res.status(404).json({ error: "Card not found" });
    // A lifecycle flip changes which chats the sidebar's cards-only filter
    // admits, and that list is cached by query string — drop it so the next
    // poll reflects the close/reopen instead of serving the old membership.
    if (patch.lifecycle !== undefined) clearListCaches();
    sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" });
    res.json({ card: summarize([card])[0] });
  } catch (err: any) {
    if (err instanceof CardValidationError) return res.status(400).json({ error: err.message });
    if (/title/i.test(err.message ?? "")) return res.status(400).json({ error: err.message });
    log.error(`Error updating card: ${err}`);
    res.status(500).json({ error: "Failed to update card", details: err.message });
  }
});

cardsRouter.delete("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Permanently delete a CLOSED card; member chats are unassigned, not deleted'
  /* #swagger.responses[404] = { description: "Card not found" } */
  /* #swagger.responses[409] = { description: "Card is still open — close it first" } */
  const card = getCard(req.params.id);
  if (!card) return res.status(404).json({ error: "Card not found" });
  if (card.lifecycle !== "closed") {
    return res.status(409).json({ error: "Only closed cards can be deleted — close the card first" });
  }
  try {
    // Remove the card file FIRST: if the unlink fails we still have a
    // consistent board (card present, members intact) rather than a card whose
    // chats were already detached. Job runs keep their historical `cardId` —
    // rollups only ever project runs onto cards that still exist, so a stale
    // run reference is inert, unlike a chat's (which feeds default-card
    // resolution in the MCP tools).
    if (!deleteCard(card.id)) {
      return res.status(500).json({ error: "Failed to delete card" });
    }
    unassignAllChatsFromCard(card.id);
    sessionRegistry.notifyMetadata(card.id, { cardEvent: "deleted" });
    res.json({ success: true });
  } catch (err: any) {
    log.error(`Error deleting card: ${err}`);
    res.status(500).json({ error: "Failed to delete card", details: err.message });
  }
});
