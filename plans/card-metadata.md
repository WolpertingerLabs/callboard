# Plan: card-metadata — arbitrary key→value metadata on cards

Status: **Approved for implementation.**

Cards (tickets) need a place to hang arbitrary cross-references: a GitHub PR URL, a Trello card link, a Linear ticket ID, a Slack conversation link, a Devin conversation ID, etc. Today the only free-form field is the markdown `description`, which agents and users end up abusing for structured links. This plan adds a first-class `metadata` map — arbitrary string keys to string values — editable by both the user (frontend CardDrawer) and agents (a new MCP tool), with per-key merge semantics so concurrent writers don't clobber each other.

Example:

```json
{
  "id": "card-abc123",
  "title": "Ship card metadata",
  "metadata": {
    "github-pr": "https://github.com/org/repo/pull/42",
    "linear": "ENG-1337",
    "slack": "https://org.slack.com/archives/C0123/p16999",
    "devin-session": "devin-session-8f2c"
  }
}
```

## What exists today (reused, not rebuilt)

- **Card model:** `shared/types/card.ts` — `Card` (lines 10-25), `CardPayload`, `CardPatch` (35-43, with `null`-clears-field convention for `status`/`statusEmoji`), `CardSummary`.
- **Persistence:** `backend/src/services/card-store.ts` — one JSON file per card at `~/.callboard/data/cards/{cardId}.json`, atomic writes, read-merge-write `updateCard` (line 104). No schema versioning; new optional fields are handled by TS optionality (house style — `status`/`statusEmoji` were added this way).
- **REST:** `backend/src/routes/cards.ts` — `PATCH /:id` (line 89) with a hand-rolled `PATCHABLE_FIELDS` allowlist (line 87) and explicit per-field `typeof` validation branches (no zod on the REST side). Mutations call `sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" })`; the frontend refetches on metadata-version bump.
- **MCP tools:** `backend/src/services/callboard-tools.ts` "Cards (tickets)" section (lines 427-562) using `defineTool(name, description, zodShape, handler)` from `backend/src/agents/ports/tools.ts:66`; parallel declarative catalog entries in `backend/src/services/mcp-tool-registry.ts` (~108-168). Handlers resolve the calling chat's card via `getChatCardId(getChatId())`.
- **Frontend:** `frontend/src/components/board/CardDrawer.tsx` is the field-edit surface (receives `onPatch(patch: CardPatch)`); `InlineEdit.tsx` is the reusable click-to-edit control; `frontend/src/api.ts` `updateCard` (line 256); `Board.tsx` refetches via `useMetadataVersion()`.
- **Merge-partial-keys precedent:** `backend/src/services/card-membership.ts` `writeViewMeta` (read → merge keys → write) on the chat metadata blob.

## Data model

Add to `shared/types/card.ts`:

- `Card.metadata?: Record<string, string>` — absent or `{}`-pruned-to-absent for cards with no entries. Pre-existing on-disk cards simply lack the field; all consumers must treat it as possibly-undefined (`card.metadata ?? {}`). No migration needed.
- `CardPatch.metadata?: Record<string, string | null>` — **per-key merge semantics**, not whole-object replace: each key in the patch is set to its value; a `null` value deletes the key; keys absent from the patch are untouched. This mirrors the `status: null` clearing convention and keeps concurrent user/agent edits from clobbering unrelated keys.

Limits (constants in `card-store.ts` alongside `CARD_TITLE_MAX`):

- `CARD_METADATA_KEY_MAX = 64` — key length; keys are trimmed, must be non-empty after trim.
- `CARD_METADATA_VALUE_MAX = 2048` — value length (long enough for any URL).
- `CARD_METADATA_MAX_ENTRIES = 50` — entries per card after applying a patch.

## Store layer

In `backend/src/services/card-store.ts` `updateCard`:

- Add a `metadata` branch mirroring the `status` null-clearing logic (lines 116-119): start from `card.metadata ?? {}`, apply set/delete per key, drop the field entirely when the result is empty (delete-key-to-clear on-disk semantics, matching house style — never persist `metadata: {}` or `null` values).
- Enforce the limits above here (single source of truth); throw a typed validation error the route can map to 400.

## REST API

In `backend/src/routes/cards.ts`:

- Add `"metadata"` to `PATCHABLE_FIELDS` and a validation branch in `PATCH /:id`: value must be a plain object; every key a string within limits; every value a string within limits or `null`. Return 400 with a specific message on violation. Existing `notifyMetadata(...cardEvent: "updated")` broadcast covers live updates — no new event plumbing.
- `GET /` and `GET /:id` need no changes if they return the full card object; verify `metadata` flows through `CardSummary` rollup construction in `backend/src/services/card-rollup.ts` (add the field passthrough if summaries are built field-by-field).

## MCP tool

New tool `set_card_metadata` in `backend/src/services/callboard-tools.ts` (Cards section), following the `set_card_status` pattern (line 516):

- Args (zod): `card_id` (optional string — defaults to the calling chat's card via `getChatCardId(getChatId())`, error if neither), `set` (optional `z.record(z.string().max(2048))` — keys to set/overwrite), `remove` (optional `z.array(z.string())` — keys to delete). At least one of `set`/`remove` required.
- Handler: translate to a `CardPatch.metadata` map (`remove` keys → `null`), call `updateCard`, then `sessionRegistry.notifyMetadata(card.id, { cardEvent: "updated" })`. Return the card's resulting metadata map as JSON text.
- Description must state the intended use: cross-referencing external systems (PR URLs, ticket IDs, conversation links) and that keys are arbitrary.
- Register the tool in `backend/src/services/mcp-tool-registry.ts` (name, `qualifiedName: "mcp__callboard-tools__set_card_metadata"`, description, parameters, `serverName: "callboard-tools"`, `category: "platform"`).
- Verify `get_card` / `list_cards` handlers include `metadata` in their responses (add the field if those handlers pick fields explicitly rather than serializing the whole card).

## Frontend

In `frontend/src/components/board/CardDrawer.tsx`, add a **Metadata** section (between description and the lifecycle actions):

- Render each entry as a row: key label + value. Values matching `/^https?:\/\//` render as a clickable link (`target="_blank" rel="noreferrer"`), otherwise plain text.
- Value click-to-edit via the existing `InlineEdit` control → `onPatch({ metadata: { [key]: newValue } })`. Empty-string save deletes the key (send `null`).
- A per-row remove button (✕) → `onPatch({ metadata: { [key]: null } })`.
- An "Add field" affordance: key input + value input, on confirm `onPatch({ metadata: { [key]: value } })`. Reject empty/duplicate keys client-side with an inline hint.
- All colors/spacing via existing CSS variables per the theming rules in `.claude/CLAUDE.md` (no hardcoded colors); add new `--` variables to both `:root` and `[data-theme="light"]` in `frontend/src/index.css` only if genuinely needed.
- No new fetch plumbing: `api.ts updateCard` already sends arbitrary `CardPatch`; `Board.tsx`'s `patchCard` and metadata-version refetch handle propagation. Update the `CardPatch` usage sites for the widened type if TS complains.
- Optionally show a compact indicator (e.g. link-count chip) on `CardTile.tsx` when a card has metadata — keep minimal, skip if it crowds the tile.

## Testing

- **Store (vitest):** merge semantics (set new key, overwrite, `null` deletes, untouched keys preserved), empty-map pruning, limit enforcement (key/value length, max entries), undefined-metadata legacy cards read fine.
- **Route (vitest):** PATCH accepts valid maps, 400s on non-object metadata, non-string keys/values, over-limit input; `null` deletion round-trips.
- **MCP:** handler-level test for `set`/`remove` translation and the no-card error path, following whatever pattern existing `callboard-tools` tests use (if none exist, cover the logic at the store/route layer and keep the handler thin).
- Run `npm run lint` and the existing vitest suite; frontend verified manually via dev server.

## Implementation phases

**Phase 1 — Model + store** — **landed** (b735b3c)
**Goal:** `metadata` persists with per-key merge semantics and enforced limits.
1. Add `metadata` to `Card` and `CardPatch` in `shared/types/card.ts` with doc comments stating merge/`null`-delete semantics.
2. Add limit constants and the `updateCard` metadata branch (merge, delete, prune-empty, validate) in `card-store.ts`.
3. Vitest coverage for the store behavior above.

**Phase 2 — REST + MCP surface** — **landed** (d9cd905)
**Goal:** users' HTTP clients and agents can both mutate metadata.
1. `PATCHABLE_FIELDS` + validation branch in `routes/cards.ts`; route tests.
2. Verify `metadata` flows through card rollups/summaries (`card-rollup.ts`) and the `get_card`/`list_cards` MCP responses.
3. Implement `set_card_metadata` in `callboard-tools.ts` + catalog entry in `mcp-tool-registry.ts`.

**Phase 3 — Frontend editor**
**Goal:** users can view, add, edit, and remove metadata entries in the CardDrawer.
1. Metadata section in `CardDrawer.tsx` (rows, link rendering, InlineEdit values, remove buttons, add-field affordance) using theme variables only. — **landed** (0a3cf9a)
2. Widened `CardPatch` typing through `api.ts` / `Board.tsx` as needed. — **landed** (no code changes needed; `api.ts updateCard` and `Board.tsx patchCard` pass `CardPatch` through whole, so the widened type flowed with a clean typecheck)
3. Manual verification against the dev server (add/edit/remove as user; `set_card_metadata` from an agent chat; confirm live refetch updates the drawer). — **landed**

   Driven against a dev server on current HEAD (isolated `~/.callboard-dev` data dir), not a stale tree — 827 vitest tests, matching HEAD.

   **`set_card_metadata` from real agent chats (MCP, not unit-level).** Three Claude sessions spawned via `POST /api/chats/new/message`, tool calls and results read back from their transcripts:
   - Chat on a card, **no `card_id`** → resolved via `getChatCardId(getChatId())` to the owning card and returned `{"success":true,"cardId":"card-9a7a88a8-…"}`. Chat→card fallback confirmed.
   - **`set` + `remove` in one call** → `linear` overwritten, `slack` added, `scratch` deleted, `github-pr` untouched. Per-key merge confirmed across two sequential agent calls.
   - Chat **not** on a card, no `card_id` → `"This chat is not on a card — pass card_id explicitly or create_card first"`.
   - Unknown `card_id` → `"Card \"card-does-not-exist-xyz\" not found"`.
   - 100-char key → `updateCard` throw mapped to `"metadata key \"kkkk…\" exceeds 64 characters"`. `CardValidationError`→error mapping confirmed.
   - Not reachable from a real chat: the `"Chat context not available"` branch fires only when `getChatId` is undefined, which cannot occur in a spawned session — it stays covered by inspection only.

   **`notifyMetadata` broadcast → live refetch.** With the drawer open and untouched, an agent chat called `set_card_metadata`; the new row appeared in the drawer ~5.5s later with **0 page reloads**.

   **Browser pass (Playwright, current HEAD)** — covers the paths cc0597b changed:
   - Rejected add (card at the 50-entry cap) → server 400, **add editor stays open with the typed key and value intact**. This is the new `onPatch: Promise<boolean>` contract; previously the input was discarded.
   - Blank and whitespace-only values → Add disabled with a `"Value can't be blank."` hint.
   - Duplicate key → Add disabled with an `"already exists — edit it above."` hint.
   - `__proto__` key → server 400 `"\"__proto__\" is not a valid metadata key"`, editor stays open with input preserved.
   - Happy path add → 200, editor closes, URL value renders as an `_blank` link; remove button → 200, row gone.

## Design decisions & rejected alternatives

- **Per-key merge PATCH, not whole-object replace.** Replace semantics would let a stale frontend drawer wipe keys an agent just wrote. Merge + `null`-delete matches the existing `status: null` convention and `writeViewMeta` precedent. Rejected: ETag/If-Match concurrency — overkill for this store.
- **Flat `Record<string, string>`, not typed link objects.** The request is explicitly arbitrary key→value; a `{type, url, label}` schema would need enum churn for every new external system. URL detection is a render-time concern.
- **No dedicated `metadata` sub-route (`PATCH /:id/metadata`).** The existing single PATCH + allowlist idiom covers it; a sub-route would duplicate validation and broadcast plumbing.
- **One MCP tool with `set`+`remove`, not separate set/remove tools.** Fewer tools in the catalog, one atomic update, symmetric with the patch shape.
- **No schema migration.** Optional-field-only change; consistent with how `status`/`statusEmoji` shipped.
