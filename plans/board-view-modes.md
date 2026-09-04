# Board view modes — card grid ↔ full-width list, folder summary, row expansion

Three board preferences, all persisted, all independent:

1. **View mode** — `cards` (today's `minmax(260px, 1fr)` grid) or `list` (one
   full-width row per card).
2. **Show paths** — off by default; when on, every card face carries the folders
   its work lives in.
3. **Expand rows by default** — list view only; sets the resting state of the
   per-row folder breakdown.

## What the data says

Measured against the live data dir (`~/.callboard/chats`, 8,718 records), because
the whole design turns on how many folders a card actually spans.

```
chats                              8718
card-eligible lineage roots         818

distinct folders per card
  0 folders      72   (8.8%)   ← lineage entirely on the retired provider
  1 folder      722   (88.3%)
  2 folders      10
  3 folders       5
  4–7            4
  11–20           5      ← 20, 16, 12, 12, 11
cards spanning >1 folder             24   (2.9%)
cards showing at most one path      794   (97.1%)
```

The zero-folder row is a correction, not a footnote. An earlier count of this
table read "1 folder — 794 (97.1%)" because the measurement did not replicate
the retired-provider skip at `card-rollup.ts:338`: it grouped every member
chat, so a card whose entire lineage ran on `openrouter` still appeared to
have a folder. It does not. `memberChats` comes back empty and `cardFolders`
returns `[]`. All 72 are that case — none is a card with member rows that
merely lack a `folder`.

Three facts drive everything below, and the first two pull in opposite
directions:

- **794 of 818 cards (97.1%) show at most one path.** So the common row must
  show one path and nothing else — no count, no chevron, no `+0`. Any per-row
  affordance that renders on a single-folder card is noise on 794 of 818 cards.
  That conclusion is unchanged by the correction above: it rests on how many
  cards have a *second* folder, and 24 is measured directly.
- **When a card does span folders, it spans a *lot* of them.** The tail is 7, 11,
  12, 12, 16, 20 — a fan-out across worktrees. So "show a list of all active
  paths" cannot be an unbounded inline list; 20 paths would destroy the row it
  sits in. Those cards are also the *interesting* ones, which is exactly what
  earns the expansion.
- **About one card in eleven has no path at all.** 8.8% is too many to treat as
  a defensive branch, and it is the reason the empty case gets a rendering
  decision rather than a `?.`: `cardFolders` returns `[]`, `CardFolderLine`
  returns `null`, and the folder cell renders nothing on either face. Desktop
  still emits the cell, empty, because the grid template has a track for it and
  a missing child would shift every cell after it into the wrong column; mobile
  omits it, because its second line is a free flex row with no column to hold
  open. Same rule, two layouts.

Two more measurements that shape the presentation:

```
root chat's own folder present in the member set   24/24 multi-folder cards
full path length          mean 49   median 48   max 94 chars
length after eliding the common prefix   mean 35   median 34   max 82
```

The first means that on a card which spans folders at all, "root path at top"
always has something real to pin — every one of the 24 has its root chat's own
folder in the set, so the pinned row is never a synthesised one. It says
nothing about the 72 cards with no member rows, which have no root path either
and are the case the paragraph above covers. The second is why the
expanded list hoists a shared prefix: a 12-row list where every row starts
`/home/cybil/` is 12 copies of the one substring that distinguishes nothing.

```
prefix: /home/cybil
    .callboard/agent-workspaces/forge
    countinghouse.feat-account-management
    countinghouse.feat-analytics
    countinghouse.feat-analytics-spec-followup
    countinghouse.feat-auth-deploy
    ... 12 total
```

## The folder model

```ts
// frontend/src/utils/cardFolders.ts
interface CardFolder {
  path: string;
  chatCount: number;
  /** Most urgent live state among this folder's chats; undefined when all are stopped. */
  live?: "waiting" | "ongoing";
  lastActivityAt: string;
  isRoot: boolean;
}
export function cardFolders(card: CardSummary): CardFolder[];
```

Derived entirely client-side from `memberChats[].folder` + `.status` — **no
backend change**. `CardSummary` has no `folder` of its own, but a card *is* its
root chat and the root is in `memberChats` (`card-rollup.ts:333-342` groups every
chat by its root).

Ordering — root folder first, then live folders (waiting before ongoing), then
the rest by recency:

```
isRoot desc, then live rank desc, then lastActivityAt desc
```

The root pins to the top even when it is quiet, per your call. It is the card's
origin, and a list whose first row moves on every 15s poll is a list you cannot
build muscle memory against.

Two edge cases the fallback has to cover, and the second is the common one:
`isCardEligible` (card-fields.ts:321) has no provider check, but the member-chat
grouping skips retired providers (`card-rollup.ts:338`) — so a root on a retired
provider is a real card whose own member row is missing, and `memberChats` can
be empty outright. That second case is **72 cards, 8.8% of the board**, not a
rarity: about one card in eleven has nothing to say about folders at all.
`cardFolders` returns `[]` there and every consumer renders nothing; it never
renders `undefined`.

The consumers that need a story for it, in full, because 8.8% is too many to
leave to a `?.`:

- `CardFolderLine` returns `null` — no path, no `+0`, no empty dot.
- The row's folder cell renders on desktop and not on mobile, per the grid
  argument above.
- The drawer's "New chat on card" has no member folder to start in, so it falls
  through to the filter chip if one is set and then to the New Chat MRU. It
  must not fall through to the MRU while a filter *is* set: the new chat joins
  the card by lineage, so that would give the card a folder from whatever
  project was opened last.

Note what we give up by staying frontend-only: `CardMemberChat` carries `folder`
but not `displayFolder`, so a worktree chat contributes its *worktree* path, not
the main repo. Given the fan-out cards above are precisely worktree fan-outs,
that is the information we want. If we later want the repo↔worktree distinction,
add an optional `displayFolder?: string` to `CardMemberChat` — old bundles ignore
unknown keys, so it needs no capability gate.

## Collapsed row — the 97% case

```
📋  Wire capability negotiation   Rebasing onto main   /home/cybil/callboard.feat-wire-caps   ● Active   💬 4   2h
```

One path: the root folder, middle-truncated. On a single-folder card that is the
entire path story and there is no chevron, no count, nothing else.

On a multi-folder card the path cell becomes:

```
▸  /home/cybil/callboard.feat-acp-adapter   +19
```

- `+N` counts distinct folders other than the root's.
- The chevron and the `+N` render **only when N > 0**.
- When any of those other folders holds a live chat, `+N` takes the rollup dot's
  colour. That one glyph is what says "the action is somewhere other than the
  folder on this row" — which is the actual failure mode of showing the root
  path alone, and the objection that started this.

## Middle truncation — `CardPathLabel`

Pure CSS, no measurement, no `ResizeObserver`:

```
/home/cybil/some/deep/proj…/callboard/frontend
└──────── head, shrinks ──────┘└─ tail, never shrinks ─┘
```

- `tail` = the last **two** segments (parent + leaf), `flex: 0 0 auto`.
- `head` = everything before them, `flex: 0 1 auto; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap`.
- Container `display: flex; min-width: 0`, `title={fullPath}`.

Flex supplies the priority for free — the tail claims its width first, the head
ellipsizes into whatever is left — and it reflows live on window resize and
sidebar drags because the browser is doing the layout.

Accepted cost: the head's ellipsis lands mid-segment (`…proj…`) rather than on a
`/`, since CSS cannot cut at a delimiter. Full path is in the `title`, and a
JS-measured variant can replace the internals later without changing the
component's surface. (`direction: rtl` moves the ellipsis to a boundary but
reorders slashes under bidi — not worth it.)

`CardPathLabel` takes an optional `prefix` to strip, which is how the expanded
group renders remainders against a hoisted prefix. Degenerate paths — `/`, one
segment, two segments, trailing slash — give an empty head and render tail-only.

## Expanded row — one row per folder, not per chat

```
▾  /home/cybil/callboard.feat-acp-adapter                    ● Active   💬 4   2h
   ┌ /home/cybil
   │  ● callboard.feat-acp-adapter          root    💬 4   2h
   │  ● callboard.feat-wire-caps                    💬 3   5h
   │    callboard.fix-chat-search                   💬 1   2d
   │    .callboard/agent-workspaces/forge           💬 2   4d
   └  … 16 more
```

- **Per folder, not per chat.** The 20-folder card has 38 chats; 38 inline rows
  on the board is a second drawer. Per-folder with counts is the summary the
  board wants, and it is literally the "list of all active paths" the row is for.
- The shared prefix is hoisted to the group header and each row shows its
  remainder (mean 49 → 35 chars, and more to the point, one copy of
  `/home/cybil` instead of twelve). Computed at segment boundaries, and only
  when it leaves every row a non-empty remainder.
- Capped at **8 rows** with a `… N more` footer that opens the drawer. A 20-row
  expansion pushes every other card off the screen — the cap is what keeps
  expansion a summary rather than a navigation.
- Live folders carry the rollup dot; `root` is a label, not a sort surprise.
- Clicking a folder row opens `CardDrawer` **filtered to that folder**, which
  needs one new optional prop on the drawer (`initialFolderFilter?: string`).
  Per-chat detail, card fields, description and metadata all stay in the drawer.
  The board does not grow a second copy of it.

## Expansion state

Per-row, with a header toggle that sets the resting state:

```ts
const [expandOverrides, setExpandOverrides] = useState<Set<string>>(new Set());
const isExpanded = (id: string) => expandAllDefault !== expandOverrides.has(id);
```

`expandAllDefault` is the persisted preference (#3); `expandOverrides` is
ephemeral. That satisfies both readings of "expanded and contracted views" —
it is a view-level setting *and* a per-row control — for about five lines, and
the per-row override is what makes it usable when only one card on the board has
a fan-out worth opening.

Not persisted per card, deliberately: an expansion restored across a reload for a
card that has since collapsed to one folder is a row that opens onto nothing.

Only single-folder-plus cards are expandable at all, so on today's board
(3 open cards, 1 of them multi-folder) "expand all" opens exactly one row.

## Card view keeps the summary, not the expansion

The tile shows the root path + `+N` on its own line and stops. A tile is 260px
wide and its click already opens the drawer, which is the detail surface. This is
the honest split between the two view modes, and the reason both earn their
place: **card view is glanceable, list view is scannable and drillable.**

## Layout

- Card view keeps `maxWidth: 1100` (Board.tsx:406).
- **List view raises it to 1400.** The list has a path column and an expansion
  the grid does not, and a full-width row at 1100 wastes the one advantage rows
  have over tiles. Still capped rather than `100%`: past ~1400 the eye loses the
  line between the title column and the time column.
- `CardRow` is a `display: grid` per row on a shared template, so columns align
  down the list — that alignment is the whole reason to have a list view rather
  than a squashed tile.

```
gridTemplateColumns: "18px minmax(0,2fr) minmax(0,3fr) minmax(0,1.5fr) auto auto auto"
                      emoji  title        status       folders         rollup 💬N  time
```

The folders column is dropped from the template entirely when paths are off,
rather than rendered empty. The emoji cell is the same fixed 18px box the tile
uses, so the selection checkbox swaps in without shifting anything. Selection
shows as an `outline` plus a 2px left accent bar — the tile's 1px `box-shadow`
ring reads as a table border on a full-width row.

**Mobile** (`useIsMobile`): two lines — title + rollup, then status/folders/time.
Rows keep a ≥44px hit target; the expansion chevron gets its own.

## What does not change

The grouping machinery in `Board.tsx` — `BUCKETS`, `groupByCategory`,
`sortCards`, the closed strip, and `orderedIds` — is untouched. List mode swaps
the container and the row component; it does not re-derive order.

That is load-bearing. `orderedIds` (Board.tsx:220) is flattened out of the very
arrays the JSX renders, and shift+click ranges read from it. Same sections, same
nesting, same order ⇒ range selection, Ctrl+A, lifecycle scoping and the 15s-poll
reconciliation keep working with zero changes. **Expanded folder rows must not
enter `orderedIds`** — they are not cards and cannot be selected; a shift+click
range that steps through them would select cards the user never saw.

## Shared face logic — `cardFace.ts`

`CardTile` and `CardRow` show the same facts, so extract before writing the
second one — the same argument `components/listParity.test.tsx` already makes for
task lists. Out of `CardTile.tsx` into `components/board/cardFace.ts`:

- `ROLLUP_LABELS`, `ROLLUP_COLORS` (nothing outside `CardTile` imports them
  today, so the move is free).
- `useCardCountdown(card)` — the `hasCountdown` gate plus the 1s ticker. The gate
  matters more in list mode, where more rows are on screen at once.
- `useCardActivation({...})` → `{ handleClick, gestureProps, inert, showCheckbox,
  hoverProps }`. The whole interaction contract: click-suppression after a long
  press, modified-click toggle, the conditional mount of gesture handlers so
  `preventDefault` never steals the browser menu from a surface with no selection
  to offer. Reimplementing this in `CardRow` is where the bug would be.
- `statusLine(card, now)` — the ladder inline at CardTile.tsx:230-237.

`pendingLabels.ts` is unchanged.

## Persistence

`utils/localStorage.ts`, alongside `boardClosedExpanded`:

```ts
/** Board layout: full-width rows instead of the tile grid. Absent = "cards". */
boardViewMode?: "cards" | "list";
/** Whether card faces show the folders their chats live in. Absent = hidden. */
boardShowPaths?: boolean;
/** List view: whether rows rest expanded. Absent = collapsed. */
boardRowsExpanded?: boolean;
```

Readers follow the existing `=== true` / explicit-value-match style, so a garbage
stored value falls back to the default rather than throwing. Defaults are today's
behaviour throughout.

## Controls

Right-aligned in the Board header (Board.tsx:409-430), after the `<h1>`'s
`flex: 1`:

- Segmented `LayoutGrid` / `List`, `role="radiogroup"`.
- `Folder` toggle, `aria-pressed={showPaths}`.
- `ChevronsUpDown` toggle for `boardRowsExpanded` — **rendered only in list mode
  with paths on**, since it controls nothing otherwise.

Icon-only on mobile, where the back button and title already occupy the row. All
use existing `--board-*` / `--surface` / `--border` / `--accent` tokens — **no
new CSS variables**, which keeps this clear of the `index.css` ↔
`backend/src/services/theme-contrast-palette.ts` mirror and of the "every custom
theme defines every variable" rule.

## Tests

- `utils/cardFolders.test.ts` — dedupe by folder; root pinned first even when
  quiet; live-before-stale ordering under it; chat counts; empty `memberChats`;
  root's member row missing (retired provider); every member sharing one folder
  ⇒ exactly one entry.
- `utils/pathTruncate.test.ts` — head/tail split for a deep path, exactly two
  segments, one segment, `/`, trailing slash, relative path; and prefix
  computation: segment-boundary only, no prefix when it would empty a row,
  the `/home/cybil` + `.callboard/agent-workspaces/forge` mixed-depth case from
  the real data.
- `components/board/cardFace.parity.test.tsx` — a table over
  `[CardTile, CardRow]` asserting one selection contract on both: checkbox hidden
  until hover/focus/selection-mode, `aria-checked`, inert out-of-scope,
  long-press enters selection, a click after long-press does not also open the
  drawer. This is the file that stops the two faces drifting.
- `pages/Board.viewmode.test.tsx` —
  - list mode renders the same cards in the same order under the same
    section/group headings (read through the `role="heading"` outline the
    grouping tests already use);
  - a shift+click range across a section boundary selects the same set in both
    modes, **and with a row expanded** — the regression guard for `orderedIds`;
  - single-folder card shows no chevron and no `+N`;
  - multi-folder card shows `+N`, expands to folder rows, caps at 8 with
    `… N more`;
  - the paths toggle affects both modes; `boardRowsExpanded` flips the resting
    state and a per-row chevron overrides it in both directions;
  - all three preferences round-trip through localStorage across a remount.
- `Board.test.tsx` / `Board.grouping.test.tsx` need no changes — they run in
  default card mode, which is the point of defaulting there.

## Order of work

1. `pathTruncate.ts` + `cardFolders.ts` + their tests — pure functions, no UI.
2. Extract `cardFace.ts` from `CardTile`; behaviour unchanged, existing test
   still green. Ship-able alone.
3. `CardPathLabel`, wired into `CardTile` as root-path + `+N` behind the
   `showPaths` flag. **Card view is now done.**
4. `CardRow` (collapsed only) + the parity test + the container/width swap.
5. Folder expansion, the drawer's `initialFolderFilter` prop, and the header's
   expand toggle.
6. `Board.viewmode.test.tsx`.

1–3 are independently mergeable and leave the board better even if list view
slips. 5 is the only step that touches `CardDrawer`.

## Open questions

- **Is `.callboard/agent-workspaces/*` worth showing?** It appears in 5 of the 24
  fan-out cards. `localStorage.ts:112` already filters it out of *recommended
  folders*, so there is precedent for treating it as infrastructure — but it is
  real work with real chats, and hiding it would make a folder count disagree
  with `chatCount`. This plan shows it. Sorting it last within its rank is a
  one-line change if it reads as noise.
- **Clicking a folder row** opens the drawer filtered to that folder. The
  alternative — navigate straight to that folder's most recent chat — is faster
  but ambiguous when the folder holds five chats, and it makes a summary row
  behave differently from the card row above it.
