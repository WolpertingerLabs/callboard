/**
 * Cards REST API — the board's read/edit surface over cards-as-metadata.
 *
 * A card IS a lineage root chat: `:id` params are root chat ids, and the
 * card's fields live in that chat's `metadata.card` (see card-fields.ts).
 * There is no create (sending a top-level prompt creates the card) and no
 * delete (deleting the chat deletes the card) — which is why this module is
 * read + patch only.
 *
 * A rollup is recomputed per request, and deliberately so: the board and the
 * sidebar both refetch ~300 ms after a mutation bumps metadataVersion, which
 * is exactly when a response cache would serve stale data. That leaves the
 * cost of a recompute as the thing to hold down, and it is *blocked event
 * loop* — the handler is one synchronous block, so while it runs nothing else
 * in the daemon does. The chat corpus comes from the stat-gated snapshot in
 * chats-snapshot.ts for that reason; the ~8k-record scan it replaced was
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
import type { CardPatch, CardSummary } from "shared";
import { buildCardSummaries } from "../services/card-rollup.js";
import { listChatsSnapshot } from "../services/chats-snapshot.js";
import { patchCardFields, isCardEligible, CardFieldError } from "../services/card-fields.js";
import { CARD_CATEGORY_MAX } from "shared";
import { validateMetadataPatch } from "../services/card-metadata-args.js";
import { chatFileService } from "../services/chat-file-service.js";
import { listRuns } from "../services/job-store.js";
import { walkToRootId } from "../services/chat-lineage.js";
import { clearListCaches } from "../services/list-caches.js";
import { sessionRegistry } from "../services/session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cards");

export const cardsRouter = Router();

/**
 * Roll up the whole board from one snapshot: every chat record (stat-gated
 * read, not a fresh parse of all ~8k files) plus every run that belongs to a
 * lineage root. The rollup itself derives which roots are cards, so there is
 * no card list to pre-filter here.
 */
function summarizeAll(includeHidden = false): CardSummary[] {
  return buildCardSummaries(listChatsSnapshot(), listRuns({ withRoot: true }), undefined, { includeHidden });
}

/**
 * Resolve an `:id` param to the root chat whose card it names. Any chat id in
 * a lineage tree names that tree's card — the same resolution the MCP setters
 * use — because agents and the UI both know member chat ids far more often
 * than root ids. Returns null when the chat does not exist, or when the
 * resolved root does not qualify as a card root (a job-step or triggered
 * chat is never a card).
 */
function resolveCardRootChat(id: string): { rootChatId: string } | null {
  // Chat records are filenames. The old card store guarded route ids before
  // joining them to its directory; keep that boundary now that card ids flow
  // through chatFileService instead, whose generic lookup also serves trusted
  // internal callers and therefore does not impose a route-level policy.
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "." || id === "..") return null;
  const chat = chatFileService.getChat(id);
  if (!chat) return null;
  const rootChatId = walkToRootId(id);
  // The root itself must be a card root — a step chat's stamped rootChatId
  // can name a chat that has since been deleted, in which case getChat below
  // fails and this degrades to "not found", which is the honest answer.
  const rootChat = chatFileService.getChat(rootChatId);
  // walkToRootId may promote an orphan whose parent was deleted. Such a
  // record still carries a dangling parent pointer, so eligibility (manual,
  // non-job chat) — not raw "has no parent field" — is the right guard.
  if (!rootChat || !isCardEligible(rootChat)) return null;
  return { rootChatId };
}

cardsRouter.get("/", (_req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'List all cards (lineage roots) with live rollups'
  // #swagger.description = 'Every non-triggered top-level chat is a card; its fields live on that chat\'s metadata. Hidden cards are omitted.'
  try {
    const cards = summarizeAll();
    // Pinned first, then most recent activity.
    cards.sort((a, b) => (a.pinned === b.pinned ? b.lastActivityAt.localeCompare(a.lastActivityAt) : a.pinned ? -1 : 1));
    res.json({ cards });
  } catch (err: any) {
    log.error(`Error listing cards: ${err}`);
    res.status(500).json({ error: "Failed to list cards", details: err.message });
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
 * resolves to the single-card handler with `id="bulk"` and answers 404
 * "Card not found" — a routing bug wearing a data bug's clothes. There is no
 * `post("/:id")`, so this path cannot be shadowed no matter where it is
 * registered or how the file is later reordered.
 *
 * Partial success is a 200 with a populated `failed[]`, not an error status:
 * a missing id in the middle of a batch must not strand the rest, and the
 * client still needs `updated` to merge into its state.
 */
cardsRouter.post("/bulk-lifecycle", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Close or reopen many cards in one call; per-id failures are reported, not fatal'
  // #swagger.description = 'ids are root chat ids. Per-id failures are reported in failed[], not fatal.'
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
    // Resolve every root BEFORE writing any, so a typo in the middle of the
    // batch cannot half-apply: resolution is pure, writes are not.
    const resolved: { id: string; rootChatId: string }[] = [];
    const failed: { id: string; error: string }[] = [];
    const seenRoots = new Set<string>();
    for (const id of ids as string[]) {
      const root = resolveCardRootChat(id);
      if (!root) {
        failed.push({ id, error: "Card not found" });
        continue;
      }
      // Two member ids of one tree name the same card — dedupe rather than
      // double-write the lifecycle flip (which would also double-notify).
      if (seenRoots.has(root.rootChatId)) continue;
      seenRoots.add(root.rootChatId);
      resolved.push({ id, rootChatId: root.rootChatId });
    }

    const successfulRootIds = new Set<string>();
    for (const { id, rootChatId } of resolved) {
      try {
        patchCardFields(rootChatId, { lifecycle });
        successfulRootIds.add(rootChatId);
      } catch (err: any) {
        log.error(`Error updating card ${rootChatId} in bulk lifecycle: ${err}`);
        failed.push({ id, error: err?.message ?? "Failed to update card" });
      }
    }

    const updated = summarizeAll(true).filter((c) => successfulRootIds.has(c.id));
    if (updated.length > 0) {
      // Once for the batch, same reason as the single-card patch: a lifecycle
      // flip moves which chats the sidebar's cards-only filter admits.
      clearListCaches();
      // Also once for the batch, not once per card. The board refetches its
      // whole card list on any metadata bump (300ms debounce), so N
      // notifications would be N SSE frames driving one identical refetch.
      sessionRegistry.notifyMetadata(updated[0].id, { cardEvent: "updated" });
    }
    res.json({ updated, failed });
  } catch (err: any) {
    log.error(`Error in bulk lifecycle update: ${err}`);
    res.status(500).json({ error: "Failed to update cards", details: err.message });
  }
});

cardsRouter.get("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Get a card with live rollup'
  // #swagger.description = 'id is the card\'s root chat id; any member chat id of the tree resolves to the same card.'
  /* #swagger.responses[404] = { description: "Card not found" } */
  try {
    const root = resolveCardRootChat(req.params.id);
    if (!root) return res.status(404).json({ error: "Card not found" });
    // Hidden is a board-listing concern, not deletion. A direct id remains
    // readable/editable so callers can inspect or unhide an opted-out card.
    const card = summarizeAll(true).find((c) => c.id === root.rootChatId);
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json({ card });
  } catch (err: any) {
    log.error(`Error getting card ${req.params.id}: ${err}`);
    res.status(500).json({ error: "Failed to get card", details: err.message });
  }
});

const PATCHABLE_FIELDS = ["title", "description", "emoji", "pinned", "status", "statusEmoji", "category", "lifecycle", "metadata", "hidden"] as const;

cardsRouter.patch("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Update a card (title, description, pin, narrative status, lifecycle, hidden, metadata)'
  // #swagger.description = 'id is the card\'s root chat id (any member chat id resolves to the same card). The patch merges into the root chat\'s metadata.card as a view-only write (no updated_at bump).'
  /* #swagger.responses[404] = { description: "Card not found" } */
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const field of PATCHABLE_FIELDS) {
    if (field in body) patch[field] = body[field];
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
  if (patch.hidden !== undefined && patch.hidden !== null && typeof patch.hidden !== "boolean") {
    return res.status(400).json({ error: "hidden must be a boolean or null" });
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
    const root = resolveCardRootChat(req.params.id);
    if (!root) return res.status(404).json({ error: "Card not found" });
    const card = patchCardFields(root.rootChatId, patch as CardPatch);
    if (!card) return res.status(404).json({ error: "Card not found" });
    // A lifecycle flip changes which chats the sidebar's cards-only filter
    // admits, and that list is cached by query string — drop it so the next
    // poll reflects the close/reopen instead of serving the old membership.
    if (patch.lifecycle !== undefined || patch.hidden !== undefined) clearListCaches();
    sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" });
    // includeHidden keeps the CardResponse shape stable when this very patch
    // opts the card out of the list. Returning raw Card fields here would drop
    // rollup/member fields from an endpoint typed as CardSummary.
    const summary = summarizeAll(true).find((c) => c.id === card.id);
    if (!summary) throw new Error(`Updated card "${card.id}" was missing from the chat snapshot`);
    res.json({ card: summary });
  } catch (err: any) {
    if (err instanceof CardFieldError) return res.status(400).json({ error: err.message });
    if (/title/i.test(err.message ?? "")) return res.status(400).json({ error: err.message });
    log.error(`Error updating card: ${err}`);
    res.status(500).json({ error: "Failed to update card", details: err.message });
  }
});
