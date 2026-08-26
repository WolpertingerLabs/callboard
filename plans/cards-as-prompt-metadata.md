# Plan: cards-as-prompt-metadata — cards as metadata on the prompt that created them

Status: **Draft — proposed.**

Today a card is a first-class entity: a JSON file in `~/.callboard/data/cards/`, created and deleted through REST and MCP tools, joined by chats and job runs through a denormalized `metadata.cardId` pointer, and rolled up by scan. In practice the system already collapsed most of the way to a simpler model: **every top-level human-started chat gets its own auto-created card** (`createCard` defaults to true on the stream route), children inherit membership at creation, and the card's title is just the chat's prompt preview. The entity layer is overhead on top of a relationship that already exists — "this conversation and everything spawned from it".

This plan removes the entity. A card becomes **metadata associated with the prompt that created it**: a nested `card` object on the root chat's metadata blob. There is nothing to create and nothing to delete — a card exists because a top-level prompt exists, and it disappears when that chat is deleted. Users and agents edit and amend it (title, description, emoji, category, status, lifecycle, cross-reference metadata) through the existing PATCH surface and the card MCP tools. The board becomes a pure projection over the chat corpus, grouped by the parentage tree that the sidebar already renders.

## What exists today (reused, not rebuilt)

- **Card entity + store:** `shared/types/card.ts` (`Card`, `CardPayload`, `CardPatch`, `CardSummary`); `backend/src/services/card-store.ts` — one JSON file per card, atomic writes, read-merge-write `updateCard`.
- **Membership:** chat `metadata.cardId` (`backend/src/services/card-membership.ts`), stamped at creation and inherited via `resolveParentage` in `backend/src/services/chat-lineage.ts`; job runs carry `run.cardId` (`job-store.ts`), propagated through run trees by `assignCardToRunTree`.
- **Rollup:** `backend/src/services/card-rollup.ts` `buildCardSummaries` — already a pure projection: cards carry no member list; membership is discovered by scan. `backend/src/services/card-member-index.ts` is the stat-gated performance cache for that scan (see "Performance" below).
- **REST:** `backend/src/routes/cards.ts` — POST (create), GET (list/detail), PATCH (edit), POST `/bulk-lifecycle`, DELETE (closed cards only).
- **MCP tools:** `backend/src/services/callboard-tools.ts` — `create_card`, `add_chat_to_card`, `list_cards`, `get_card`, `set_card_status`, `set_card_category`, `set_card_metadata`; declarative manifest in `backend/src/services/mcp-tool-registry.ts`.
- **Auto-card + reopen:** `backend/src/routes/stream.ts` (createCard defaults true) and `backend/src/services/claude.ts` (`session_started` auto-creates the card iff the chat is top-level and human-started; a new message on a closed card reopens it).
- **Frontend:** `frontend/src/pages/Board.tsx`, `components/board/*` (CardTile, CardDrawer, NewCardModal, CardPicker, BoardSelectionBar), `pages/ChatList.tsx` promote/add-to-card menus, `api.ts` card functions, `cardsOnly` chat filter, dim-inactive / active-first view options.

## Target model

**A card is the board-facing projection of a lineage tree.** The card's identity is the **root chat's id**. The card's data is a nested object on that chat's metadata:

```jsonc
// root chat's metadata
{
  "title": "...",              // chat title, unchanged
  "card": {
    "title": "...",            // defaults to the chat title / prompt preview
    "description": "…markdown…",
    "emoji": "🗂️",
    "category": "eng",
    "lifecycle": "open",       // | "closed"; "closed" carries closedAt
    "pinned": false,
    "status": "waiting on CI",
    "statusEmoji": "⏳",
    "metadata": { "github-pr": "https://…" },
    "hidden": false            // the opt-out (replaces createCard: false)
  }
}
```

Rules:

- **Which chats are cards:** a chat is a card iff it is the **highest existing lineage root** (`existingRootIdOf(chat) === chat.id`) AND not `triggered` AND not a job step chat (`metadata.jobRunId`). Ordinarily that means no `parentChatId`/`forkedFrom`; after an ancestor is deleted, the highest surviving descendant is promoted even though its stored parent pointer dangles. This is exactly the set that gets an auto-card today, so board membership is unchanged for users.
- **Nothing is stamped at creation.** The `card` object is *absent* until someone sets a field; an absent object reads as all-defaults (open, unpinned, title = chat title). A prompt creating a card writes nothing.
- **Membership is derived, never stored.** Member chats = every chat in the root's surviving parentage tree (`buildLineageIndex`/`existingRootIdOf`). Member runs = job runs spawned from chats in that tree (runs keep a `rootChatId`, replacing `cardId` — see Jobs below).
- **Deletion is chat deletion.** Deleting the root chat deletes the card; descendants that survive (if any) become their own roots and thus their own cards. No `unassignAllChatsFromCard`, no closed-only guard, no orphan sweep.
- **Creation is prompt-sending.** There is no create surface anywhere. A user "creates a card" by starting a chat.

## What is removed

| Surface | Removal |
| --- | --- |
| `POST /api/cards` | Gone. Board's "New card" button goes with it (see Frontend). |
| `DELETE /api/cards/:id` | Gone — deleting the chat is the delete. |
| `card-store.ts` | Gone entirely: no `createCard`, `deleteCard`, per-card files, `CARD_ID_RE` path guard. |
| `card-membership.ts` | Gone: `setChatCardMembership`, `getChatCardId`, `unassignAllChatsFromCard`, `writeViewMeta`'s membership role. Card-field writes go through a new `card-fields.ts` (below) instead. |
| MCP `create_card` | Gone. |
| MCP `add_chat_to_card` | Gone — membership is lineage; there is nothing to join. |
| `assignChatToCard` REST + CardPicker + ChatList "promote to card" / "add to card" menus | Gone (membership again). |
| Auto-card block in `claude.ts` `session_started` (~line 2102) + its orphan-cleanup `deleteCardRecord` | Gone — nothing to create; the `createCard`/`cardCategory`/`cardId` stream params become documented no-ops (older bundles still send them). |
| `run.cardId`, `assignCardToRunTree`, `spawn_job`'s `card_id` input | Replaced by derivation from the spawning chat's root (below). |
| `NewCardModal` | Deleted component. |

## What is kept (re-pointed)

- **`GET /api/cards` and `GET /api/cards/:id`** stay as the board's read API, returning `CardSummary` rollups as today — but built from a lineage snapshot, with `card.id` = root chat id. The frontend board needs no structural change beyond the removed create/delete affordances.
- **`PATCH /api/cards/:id`** stays, with `:id` = root chat id. It becomes a thin wrapper: validate the `CardPatch`, merge it into the root chat's `metadata.card` (view-only write — no `updated_at` bump, same discipline as today's `writeViewMeta`), invalidate list caches, `notifyMetadata(rootChatId, { cardEvent })`. `POST /bulk-lifecycle` stays the same wrapper over many roots. A shared `backend/src/services/card-fields.ts` owns the merge + limits (title/status/category/metadata caps move here from card-store) so REST and MCP tools share one implementation.
- **MCP tools `list_cards`, `get_card`** stay (read the projection).
- **MCP tools `set_card_status`, `set_card_category`, `set_card_metadata`** stay, resolving the target as the calling chat's **lineage root** instead of `getChatCardId` — `walkToRootId(chatId)` already exists. The "this chat is not on a card — create_card first" error branch disappears: every top-level chat has a card, and for a child chat the root always exists (or the walk degrades to self, which then *is* a top-level chat).
- **One new MCP tool `update_card`** (or fold into the setters — see Open questions) for title / description / emoji, so agents can amend the card the way the user's CardDrawer can. This is the "edited and amended by chats / agents" half of the goal.
- **Reopen-on-new-message** stays in `claude.ts`: when a chat's lineage root has `card.lifecycle === "closed"` and a new message arrives anywhere in the tree, flip it open. Same behavior, read from the new location.
- **`cardsOnly` chat filter, dim-inactive, active-first sorting** stay; they read the root's `card` object through the same lineage index instead of `metadata.cardId` + card files.
- **Board UI (sections, categories, multi-select, closed strip, CardTile, CardDrawer)** stays. The drawer's Delete action becomes "Delete chat" (with the chat's own confirm flow) or is simply dropped from the drawer and left where chat deletion already lives — see Open questions.

## Jobs

Job runs currently carry `run.cardId`, stamped at spawn (`spawnJobRun(opts.cardId)`), propagated across run trees by `assignCardToRunTree` when the `job` step tool attaches one, and projected onto cards by the rollup. Under the new model:

- `spawnJobRun` resolves the **spawning chat's lineage root** and stamps `run.rootChatId` instead. A run spawned outside any card (a run with no chat context, e.g. straight from the jobs page) has none — matching today, where it only had a `cardId` if a card was explicitly attached.
- `assignCardToRunTree` and `spawn_job`'s `card_id` param are removed; the "job" step tool's attach-a-card branch goes with them. A child job run inherits its parent run's `rootChatId` through the existing run-tree parent links.
- The rollup projects runs onto the card whose root chat id equals `run.rootChatId`.

Migration must rewrite existing `run.cardId` values through the cardId→rootChatId map (below).

## Performance

The board rollup (`GET /api/cards`) is a synchronous, event-loop-blocking handler that runs every 15 s per open tab plus every metadata bump; the whole reason `card-member-index.ts` exists is that a naive full scan of ~8k chat files cost 1.9 s of frozen daemon. The new model makes the scan *bigger* in one way (all chats, not just card-bearing ones) and smaller in another (no card files to read at all). The mitigation is to reuse the existing pattern:

- Extend the stat-gated index (`card-member-index.ts`) into a **lineage snapshot cache**: keyed by the mtime fingerprint of the chats dir, holding per-file parsed records plus parent pointers, so a rollup only re-parses files that changed since the last `stat` pass. `buildLineageIndex` (in `chat-lineage.ts`) is already O(n) with memoized path compression; feeding it from the snapshot instead of `getAllChats()` gives the board and `GET /api/chats` a shared, incrementally-parsed corpus.
- Keep the rollup pure (deps injected, as today) so tests stay fast — `card-rollup.test.ts` ports over largely intact.

This is the largest single piece of new engineering in the plan and should be built first, behind the current read shape, before any removals land.

## Frontend

- **Board.tsx:** drop `NewCardModal`, the "New card" button, and `removeCard`/`deleteCard` usage. The empty state's "Create one, or promote a chat" copy becomes "Start a chat to create a card" (with a link to the composer). The drawer keeps all editing surfaces (title, description, emoji, category, status, metadata, pin, close/reopen, bulk lifecycle).
- **CardDrawer:** `onDelete` is replaced by "open the root chat" (the drawer's member list already links there; deletion lives in the chat's existing UI). Everything else is unchanged — it already works entirely through `onPatch(CardPatch)`.
- **ChatList.tsx / ChatListItem:** remove the "Promote to card", "Add to card", and "Remove from card" menu items and `CardPicker`; remove `createCard`/`assignChatToCard` from `api.ts`. Keep card-based dimming/sorting and the ⋮ menu's "Close card" convenience (if present) — it just PATCHes the root chat now.
- **Chat.tsx / NewChatPanel:** stop sending `cardId`/`createCard`/`cardCategory` (they were already mostly not sent); no behavior change either way since the server no-ops them.
- **api.ts:** remove `createCard`, `deleteCard`, `assignChatToCard`; keep `listCards`, `getCard`, `updateCard`, `bulkSetCardLifecycle` — same signatures, ids are now root chat ids.

## Migration

One-time, at daemon startup, idempotent (a `.cards-as-metadata-migrated` marker in the data dir):

1. Load all card files; load all chat records; build a lineage index.
2. For each card: resolve its **root member chat** — the member whose `existingRootIdOf` is itself and is oldest; ties/absent-parent cases degrade to the oldest member. Memberless cards (created from the Board modal with no chat, or whose chats were all deleted) are **archived, not migrated**: move the file to `cards-archive/` untouched and log it. The user can read them there; nothing silently evaporates.
3. Merge the card's non-default fields into that root chat's `metadata.card` (only writing fields that differ from the defaults, keeping the absent-means-default invariant). Record `cardId → rootChatId` in the map.
4. Strip `cardId` from every member chat's metadata (write `null` once for the string-check readers during a rolling window, or delete the key outright — see rollout).
5. Rewrite every job run's `cardId` → `rootChatId` through the map; runs pointing at archived/memberless cards get none.
6. Delete `metadata.cardId` handling everywhere; write the marker.

Cross-tree memberships (chats deliberately grouped onto one card from *different* lineages via `add_chat_to_card`) collapse to the root's tree; the other chats fall back to being their own cards. This is a real, deliberate data-model loss — flagged in Open questions rather than papered over.

## Docs and agent-facing copy

- README: "Cards and the board" section and the MCP tools bullet ("Agents can create cards, join them…" → "every conversation is a card; agents can list, read, and amend them").
- Tool descriptions in `callboard-tools.ts` and the manifest in `mcp-tool-registry.ts` — including `spawn_job`'s `card_id` input description.
- Swagger annotations in `routes/cards.ts`.
- `shared/types/card.ts`: `Card` becomes the wire/projection type only (no `CardPayload`); document that `id` is the root chat id.

## Tests

Ported/rewritten: `card-rollup.test.ts` (lineage-driven), `card-member-index.test.ts` (snapshot cache), `callboard-tools.card.test.ts` (setters resolve via lineage root; no create/join), `claude.reopen-card.test.ts` (same behavior, new location), `job-runner.card.test.ts` (rootChatId stamping + inheritance), `chats.cards-only.test.ts` (filter reads root's card), route tests for PATCH/bulk over chat metadata, plus a migration test (cards→chat metadata, memberless archive, run rewrite).

Deleted outright: `card-store.test.ts` (store gone), `cards.delete.test.ts`, `create` halves of `cards.bulk-lifecycle.test.ts`/`cards.metadata.test.ts`, `claude.auto-card.test.ts`, `stream.auto-card.test.ts` (auto-card gone — the "top-level chat is a card" rule is asserted in the rollup tests instead).

## Sequencing

1. **PR 1 — read-side derivation + migration.** Lineage snapshot cache; rollup/board/`cardsOnly` filter read from chat metadata; migration runs at startup; card files still written where old code paths create them, and both shapes are read (old `metadata.cardId` still honored). Board and tools behave identically on migrated data.
2. **PR 2 — remove the write surfaces.** Delete card-store, POST/DELETE routes, create_card/add_chat_to_card tools, auto-card block, membership module, assignCardToRunTree, frontend create/promote/picker affordances. Old stream params become no-ops.
3. **PR 3 — polish.** Agent-editable title/description (`update_card` tool or equivalent), README/swagger copy, empty-state copy, test cleanup, `plans/RENDER.md` if it lists this doc.

## Open questions

1. **Cross-tree grouping.** Accept the loss (recommended — it is the point of the simplification), or preserve existing cross-links as a frozen read-only `card.linkedChatIds` the rollup honors but nothing writes? Preserving it keeps the rollup impure forever; dropping it strands a handful of deliberately-grouped chats.
2. **Board visibility default.** Today `createCard: false` opts a chat out of the board. New `card.hidden` flag (drawer toggle "Hide from board") vs. showing every root chat unconditionally. Recommend the flag — the API-client opt-out needs a replacement, and "hide" composes with close.
3. **Agent edit surface shape.** One `update_card` tool (title/description/emoji in one patch) vs. keeping the three setters and adding field-specific ones. Recommend `update_card` mirroring `CardPatch` — fewer tools, one schema, matches the user's PATCH.
4. **Card deletion UX.** Drop the drawer's delete entirely (chat deletion is the delete) vs. relabel it "Delete chat" with the chat's confirm modal. Recommend relabel — the drawer is where a user looking to remove a card will look.
