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
import { patchCardFields, isCardEligible, clearCardFieldsOn, CardFieldError } from "../services/card-fields.js";
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
/**
 * Drop a `metadata.card` object left on a member chat that this request just
 * redirected to its root.
 *
 * The redirect is why it matters: `PATCH /api/cards/<memberId>` patches the
 * root and answers with the root's summary, while the member's own
 * `metadata.card.lifecycle: "closed"` stays on disk untouched. Measured before
 * this fix — `PATCH child -> 200, returned lifecycle: open, child's own
 * card.lifecycle STILL: closed`. That stale copy is unreachable through any
 * card edit, so nothing ever clears it, and every reader of that chat record
 * keeps seeing a closed card the board says is open.
 *
 * Best-effort by design: the card write has already succeeded and the response
 * is correct without this, so a failure here is logged rather than turned into
 * an error the client must handle.
 */
function clearRedirectedMemberCard(requestedId: string, rootChatId: string): void {
  if (requestedId === rootChatId) return;
  try {
    if (clearCardFieldsOn(requestedId)) {
      log.info(`Cleared stranded card fields from member chat ${requestedId} (card lives on root ${rootChatId})`);
    }
  } catch (err: any) {
    log.error(`Could not clear stranded card fields from member chat ${requestedId}: ${err?.message ?? err}`);
  }
}

cardsRouter.post("/bulk-lifecycle", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Close or reopen many cards in one call; per-id failures are reported, not fatal'
  // #swagger.description = 'ids are root chat ids. Per-id failures are reported in failed[], not fatal.'
  /* #swagger.responses[200] = { description: "Updated card summaries plus per-id failures" } */
  const { ids, lifecycle } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id: unknown) => typeof id !== "string")) {
    return res.status(400).json({ error: "ids must be a non-empty array of strings" });
  }
  if (lifecycle !== "open" && lifecycle !== "closed") {
    return res.status(400).json({ error: "lifecycle must be 'open' or 'closed'" });
  }
  try {
    // Resolve every root BEFORE writing any, so a typo in the middle of the
    // batch cannot half-apply: resolution is pure, writes are not.
    //
    // Two structures, because dedupe and reporting are different questions.
    // `writeOrder` is the flip-once list; `rootByRequestedId` remembers what
    // every requested id resolved to, including the ones deduped away. The
    // previous version `continue`d on a duplicate root, so that id appeared in
    // neither `updated[]` nor `failed[]` — and Board.tsx merges by
    // `updatedById.get(c.id) ?? c`, so the tile silently kept its old
    // lifecycle and the card visibly did not reopen. Measured with 10 real
    // closed ids: requested 10, updated 9, failed 0. Since #394 removed the id
    // cap, "Select all" over 804 cards makes it routine.
    const writeOrder: { id: string; rootChatId: string }[] = [];
    const rootByRequestedId = new Map<string, string>();
    const failed: { id: string; error: string }[] = [];
    const seenRoots = new Set<string>();
    for (const id of ids as string[]) {
      const root = resolveCardRootChat(id);
      if (!root) {
        failed.push({ id, error: "Card not found" });
        continue;
      }
      rootByRequestedId.set(id, root.rootChatId);
      // Two member ids of one tree name the same card — flip it once rather
      // than double-write (which would also double-notify). Reporting still
      // covers both ids, via rootByRequestedId below.
      if (seenRoots.has(root.rootChatId)) continue;
      seenRoots.add(root.rootChatId);
      writeOrder.push({ id, rootChatId: root.rootChatId });
    }

    const successfulRootIds = new Set<string>();
    const failedRootIds = new Map<string, string>();
    for (const { id, rootChatId } of writeOrder) {
      try {
        patchCardFields(rootChatId, { lifecycle });
        successfulRootIds.add(rootChatId);
      } catch (err: any) {
        log.error(`Error updating card ${rootChatId} in bulk lifecycle: ${err}`);
        failedRootIds.set(rootChatId, err?.message ?? "Failed to update card");
        failed.push({ id, error: err?.message ?? "Failed to update card" });
      }
    }

    // Every requested id is now accounted for exactly once: a deduped id is
    // reported with the summary of the root it named, and an id whose root's
    // write threw is reported as failed even though a different id did the
    // failing write. `updated.length + failed.length === ids.length` for any
    // batch of distinct ids — the invariant Board.tsx's merge depends on.
    const summaryByRootId = new Map(summarizeAll(true).map((c) => [c.id, c]));
    const updated: CardSummary[] = [];
    for (const [id, rootChatId] of rootByRequestedId) {
      if (failedRootIds.has(rootChatId)) {
        if (!failed.some((f) => f.id === id)) failed.push({ id, error: failedRootIds.get(rootChatId)! });
        continue;
      }
      const summary = summaryByRootId.get(rootChatId);
      if (!summary) {
        // The root vanished between the write and the rollup (deleted
        // concurrently). Reporting it as failed keeps the accounting total and
        // leaves the id selected for a retry, which is the honest state.
        failed.push({ id, error: "Card not found" });
        continue;
      }
      updated.push(summary);
      clearRedirectedMemberCard(id, rootChatId);
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
    clearRedirectedMemberCard(req.params.id, root.rootChatId);
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
