/**
 * Cards REST API — the read/edit surface over cards-as-metadata, used by the
 * sidebar (archive state, row menu), the space switcher and the Git page.
 *
 * A card IS a lineage root chat: `:id` params are root chat ids, and the
 * card's fields live in that chat's `metadata.card` (see card-fields.ts).
 * There is no create (sending a top-level prompt creates the card) and no
 * delete (deleting the chat deletes the card) — which is why this module is
 * read + patch only.
 *
 * A rollup is recomputed per request, and deliberately so: the Git page and
 * the sidebar both refetch ~300 ms after a mutation bumps metadataVersion, which
 * is exactly when a response cache would serve stale data. That leaves the
 * cost of a recompute as the thing to hold down, and it is *blocked event
 * loop* — the handler is one synchronous block, so while it runs nothing else
 * in the daemon does. The chat corpus comes from the stat-gated snapshot in
 * chats-snapshot.ts for that reason; the ~8k-record scan it replaced was
 * measured at up to 1.9 s of frozen daemon per request.
 *
 * The sibling listing (`GET /api/chats`) took the other route out of the same
 * problem — a short TTL plus a fingerprint of the
 * state that moves without a request. That does not transfer here: the state
 * this route reads *is* the chat corpus, so validating an entry would cost the
 * same scan the entry exists to avoid.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { CardPatch, CardSummary } from "shared";
import { createPinnedMemberLookup } from "../services/card-archive-unpin.js";
import { cardSpaceScope, createCardContext } from "../services/card-context.js";
import { moveChatsToSpace, SpaceMoveError } from "../services/space-service.js";
import { getSpace } from "../services/space-store.js";
import { patchCardFields, clearCardFieldsOn, CardFieldError } from "../services/card-fields.js";
import { CARD_CATEGORY_MAX } from "shared";
import { validateMetadataPatch } from "../services/card-metadata-args.js";
import { chatFileService } from "../services/chat-file-service.js";
import { listChatsSnapshot } from "../services/chats-snapshot.js";
import { listRuns } from "../services/job-store.js";
import { clearListCaches } from "../services/list-caches.js";
import { sessionRegistry } from "../services/session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cards");

export const cardsRouter = Router();

/**
 * Roll up every card from one snapshot: every chat record (stat-gated
 * read, not a fresh parse of all ~8k files) plus every run that belongs to a
 * lineage root. The rollup itself derives which roots are cards, so there is
 * no card list to pre-filter here.
 */
function summarizeAll(includeHidden = false, context = createCardContext(), rootId?: string | ReadonlySet<string>): CardSummary[] {
  return context.summaries(listRuns({ withRoot: true }), includeHidden, rootId);
}

cardsRouter.get("/", (req: Request, res: Response) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'List all cards (lineage roots) with live rollups'
  // #swagger.description = 'Every non-triggered top-level chat is a card; its fields live on that chat\'s metadata. Hidden cards are omitted unless includeHidden=true.'
  /* #swagger.parameters['includeHidden'] = { in: 'query', type: 'string', description: 'Include hidden cards (metadata.card.hidden). Default false. The sidebar wants them: its archived dim has to agree with GET /api/chats?cardLifecycle=unarchived, which counts a hidden card as archived, and a card the client cannot see reads as no card at all, and therefore as not archived.' } */
  /* #swagger.parameters['space'] = { in: 'query', type: 'string', description: 'Only cards in this space (a space id), or all. Every card carries spaceId. Omitted = all.' } */
  /* #swagger.parameters['lifecycle'] = { in: 'query', type: 'string', description: 'Only cards in this lifecycle: open or closed. Selected before member projection, so asking for open cards never pays for the archive, which on a long-lived install outnumbers them by hundreds to one. Omitted = both.' } */
  const lifecycle = req.query.lifecycle;
  if (lifecycle !== undefined && lifecycle !== "open" && lifecycle !== "closed") {
    return res.status(400).json({ error: "lifecycle must be 'open' or 'closed'" });
  }
  try {
    const space = typeof req.query.space === "string" && req.query.space ? req.query.space.slice(0, 128) : "all";
    const cards = createCardContext().summaries(listRuns({ withRoot: true }), req.query.includeHidden === "true", undefined, lifecycle, cardSpaceScope(space));
    // Pinned first, then most recent activity.
    cards.sort((a, b) => (a.pinned === b.pinned ? b.lastActivityAt.localeCompare(a.lastActivityAt) : a.pinned ? -1 : 1));
    res.json({ cards });
  } catch (err: any) {
    log.error(`Error listing cards: ${err}`);
    res.status(500).json({ error: "Failed to list cards", details: err.message });
  }
});

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
 * keeps seeing a closed card the cards API says is open.
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

cardsRouter.get("/:id", (req, res) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Get a card with live rollup'
  // #swagger.description = 'id is the card\'s root chat id; any member chat id of the tree resolves to the same card.'
  /* #swagger.responses[404] = { description: "Card not found" } */
  try {
    const context = createCardContext();
    const root = context.resolve(req.params.id);
    if (!root) return res.status(404).json({ error: "Card not found" });
    // Hidden is a listing concern, not deletion. A direct id remains
    // readable/editable so callers can inspect or unhide an opted-out card.
    const card = summarizeAll(true, context, root.rootChatId).find((c) => c.id === root.rootChatId);
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json({ card });
  } catch (err: any) {
    log.error(`Error getting card ${req.params.id}: ${err}`);
    res.status(500).json({ error: "Failed to get card", details: err.message });
  }
});

const PATCHABLE_FIELDS = ["title", "description", "emoji", "pinned", "status", "statusEmoji", "category", "lifecycle", "metadata", "hidden"] as const;

cardsRouter.patch("/:id", (req, res) => {
  // #swagger.tags = ['Cards']
  // #swagger.summary = 'Update a card (title, description, pin, narrative status, lifecycle, hidden, metadata)'
  // #swagger.description = 'id is the card\'s root chat id (any member chat id resolves to the same card). The patch merges into the root chat\'s metadata.card as a view-only write (no updated_at bump). Archiving the card — lifecycle "closed" or hidden true — also clears metadata.pinned on the chats in its tree unless agent settings set unpinChatsOnArchive to false; unarchiving never restores a pin.'
  /* #swagger.responses[404] = { description: "Card not found" } */
  const body = req.body ?? {};
  if (body.spaceId !== undefined && typeof body.spaceId !== "string") {
    return res.status(400).json({ error: "spaceId must be a string" });
  }
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
    // One shared read: a second corpus pass for the pins would cost as much as
    // the first.
    const stored = listChatsSnapshot();
    const context = createCardContext(stored);
    const root = context.resolve(req.params.id);
    if (!root) return res.status(404).json({ error: "Card not found" });
    // Moving a card moves its whole tree — a tree never spans two spaces.
    // Ordered so a refused request changes nothing: the target space is
    // checked up front, the card fields (which validate as they write) go
    // next, and the move — which can then only fail on I/O — goes last.
    if (typeof body.spaceId === "string") {
      const target = getSpace(body.spaceId);
      if (!target) return res.status(400).json({ error: `Space "${body.spaceId}" not found` });
      if (target.archived) return res.status(400).json({ error: `Space "${target.name}" is archived — unarchive it before moving chats into it` });
    }
    const card = Object.keys(patch).length
      ? patchCardFields(root.rootChatId, patch as CardPatch, { pinnedMembers: createPinnedMemberLookup(stored) })
      : { id: root.rootChatId };
    if (card && typeof body.spaceId === "string") {
      const moved = moveChatsToSpace([root.rootChatId], body.spaceId);
      const failure = moved.failed[0];
      if (failure) return res.status(failure.error === "Chat not found" ? 404 : 500).json({ error: failure.error });
      const movedRoot = chatFileService.getChat(root.rootChatId);
      if (movedRoot) context.replaceRoot(movedRoot);
    }
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (!context.isNativeTarget(req.params.id)) clearRedirectedMemberCard(req.params.id, root.rootChatId);
    // A lifecycle flip changes which chats the sidebar's cards-only filter
    // admits, and that list is cached by query string — drop it so the next
    // poll reflects the close/reopen instead of serving the old membership.
    if (patch.lifecycle !== undefined || patch.hidden !== undefined) clearListCaches();
    sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" });
    // includeHidden keeps the CardResponse shape stable when this very patch
    // opts the card out of the list. Returning raw Card fields here would drop
    // rollup/member fields from an endpoint typed as CardSummary.
    const rootChat = chatFileService.getChat(card.id);
    if (rootChat) context.replaceRoot(rootChat);
    const summary = summarizeAll(true, context, card.id).find((c) => c.id === card.id);
    if (!summary) throw new Error(`Updated card "${card.id}" was missing from the chat snapshot`);
    res.json({ card: summary });
  } catch (err: any) {
    if (err instanceof CardFieldError || err instanceof SpaceMoveError) return res.status(400).json({ error: err.message });
    if (/title/i.test(err.message ?? "")) return res.status(400).json({ error: err.message });
    log.error(`Error updating card: ${err}`);
    res.status(500).json({ error: "Failed to update card", details: err.message });
  }
});
