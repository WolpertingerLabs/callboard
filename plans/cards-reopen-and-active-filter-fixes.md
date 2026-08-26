# Fixes for the cards-as-metadata refactor (#392)

Four defects found reviewing #392 / #393 / #394 against the real 8,319-record data
dir. Every number below was measured, not estimated.

## Context: how the data dir actually looks

```
total chats           8319
lineage roots         8113
  triggered            7308   (not cards)
  card-eligible         805   (these ARE the board)
    lifecycle open        1
    lifecycle closed    804
```

804 of 805 cards are closed, all stamped `closedAt` within the same millisecond
range (`2026-08-26T16:36:50.8xx`) — one bulk close over the whole board. So the
board shows one card and the sidebar's Active bucket holds one chat. That is the
state the user is looking at, and it makes defects 2–4 all present at once.

## Defect 1 — migration stranded card data on non-root chats

`card-migration.ts` picks the chat to write `metadata.card` onto like this:

```ts
const rootMembers = members.filter((m) => existingRootIdOf(m.id) === m.id && isCardEligible(m));
const candidates = rootMembers.length > 0 ? rootMembers : members;
const root = candidates.reduce((oldest, m) => (m.created_at < oldest.created_at ? m : oldest));
```

When no member is a lineage root, it degrades to `members` and writes the card
onto a chat that is **not** a root. `card-rollup.ts` only ever projects a card
from a chat where `existingRootIdOf(chat.id) === chat.id`, so those fields are
written somewhere nothing reads. The data is not lost on disk — it is invisible,
which is worse, because the user's title/status/description silently do not
appear.

Live example on this data dir — chat `0fd7760f-f4bc-4fba-a679-7d9624fe3866`
(parent `f0dc91de-…`) carries:

```json
{"title":"Refactor: cards as metadata on root chats (simplify-cards-logic)",
 "status":"Starting Phase 1: Foundation (card-fields.ts, lineage, types)",
 "lifecycle":"closed"}
```

`GET /api/cards` does not contain a card with that id, and the root's card shows
a different title and no status. Verified: `child appears as a card in GET
/cards: false`.

**Fix.** Resolve the true destination with `existingRootIdOf(member.id)` and
write there, merging rather than overwriting when the root already has fields.
Never write card fields to a chat that is not a root. The migration marker has
already run on real installs, so this needs a **repair pass**: find chats whose
`metadata.card` sits on a non-root, merge those fields into their actual root
(root's own values win on conflict), and clear the stranded copy. Idempotent, and
logged per card.

## Defect 2 — reopen silently no-ops on a member chat id

Two bugs compounding, and together they are the reported "reopen is not working".

**(a) A stranded/member card object is never cleared.** `resolveCardRootChat`
redirects any member id to its tree's root, so `PATCH /api/cards/<memberId>`
patches the *root* and returns the root's summary. The member's own
`metadata.card.lifecycle: "closed"` stays on disk untouched. Measured:

```
PATCH child -> code 200, returned card id: f0dc91de-… lifecycle: open
child's own card.lifecycle STILL: closed
```

Anything reading that chat's own record still sees "closed". Combined with
defect 1 this is exactly a card that will not reopen no matter how many times
the user clicks it.

**(b) Deduped ids vanish from the bulk response.** In
`cards.ts` `POST /bulk-lifecycle`:

```ts
if (seenRoots.has(root.rootChatId)) continue;   // <-- reported in neither array
```

An id deduped here appears in neither `updated[]` nor `failed[]`. `Board.tsx`
merges by `updatedById.get(c.id) ?? c`, so the tile keeps its old lifecycle and
the card visibly does not reopen. Measured with 10 real closed ids: `requested
10, updated 9, failed 0` — one id silently absent. Since #394 removed the ID
cap, "Select all" over 804 cards makes this a routine occurrence.

**Fix.** Dedupe by root while still reporting every requested id: map each
requested id to its resolved root's summary in `updated[]`, so N ids in ⇒ N ids
accounted for. Add a test asserting `updated.length + failed.length ===
ids.length` for a batch containing two member ids of one tree.

## Defect 3 — no way to filter the chat list by active/inactive

This is the user's explicit "we absolutely need to be able to do that". After
#392 the sidebar has three card-related view options and **none of them is a
filter on lifecycle**:

- `cardsOnly` — open cards only, all-or-nothing. No way to ask for the inverse.
- `dimCardless` — fades rows, never hides them.
- `sortByCardActive` — Active/Inactive headers, but `sectionByActive` returns
  `null` when either bucket is empty, so the headers disappear precisely when the
  board is lopsided. Measured per 20-row page over the real non-triggered chats:
  page 0 `active=1 inactive=19` (shown), pages 1–4 `active=0` → **sections
  suppressed, no headers at all**.

So with 804/805 cards closed the user gets: one card on the board, no headers in
the sidebar, and a `cardsOnly` toggle that collapses the list from 8,319 chats to
**1**. There is no "show me the inactive ones" and no "show me both, labelled".

**Fix.** Add a real lifecycle filter to `ChatViewOptions` —
`cardLifecycle: "all" | "active" | "inactive"` — resolved server-side in
`GET /api/chats` alongside the existing `cardsOnly` logic (which it should
subsume: `cardsOnly` becomes `cardLifecycle === "active"`, kept as a
back-compatible alias so persisted prefs and older bundles keep working).
Surface it in `ChatFilterModal` as a three-way control, persist it, and count it
in `activeViewOptionCount`. Keep `dimCardless`/`sortByCardActive` as the
render-only modifiers they are.

## Defect 4 — `GET /api/cards` blocks the event loop for ~1.6–2.0 s

The route's own header says the cost to hold down is blocked event loop, and the
stat-gated snapshot did its job — but the rollup after it did not:

```
snapshot 26ms   listRuns 3ms   rollup 1585ms   total 1614ms   cards=805
```

Isolated to `previewOf`:

```
real deps          2004 ms
previewOf stubbed    45 ms   (previewOf calls: 1014)
real deps warm     1613 ms   <-- still slow after the cache is warm
```

`ROLLUP_DEPS.previewOf` reads session logs off disk, and **misses are
deliberately not cached** ("so they can resolve on a later rollup"). 1,014 chats
have no title and no resolvable preview, so every rollup re-walks every session
provider for all of them, forever. The board polls every 15 s per open tab and
refetches on every metadata change; each of those freezes the daemon for ~1.6 s.

**Fix.** Negative-cache the misses with a bound — cache "no preview" keyed by
session id, invalidated by the log file's `(mtimeNs, size)` the same way
`chats-snapshot.ts` gates its entries, so a preview that legitimately appears
later is still picked up without re-walking 1,014 dead lookups per request.

## Verification expected

- `npm run lint` and the full vitest suite clean. Baseline has two pre-existing
  failures in `backend/src/utils/package-paths.test.ts` (missing generated
  `swagger.json`) — unrelated, leave them, do not paper over them.
- New tests: stranded-card repair (defect 1), `updated + failed === ids`
  (defect 2), lifecycle filter server + modal (defect 3), preview negative
  cache with a rollup-time assertion (defect 4).
- Re-run the measurements above against a copy of a real data dir and state the
  new numbers in the PR.
