# Callboard chat search tools

Status: implemented on feat/callboard-chat-search-tools; consolidated with
`find_chats` on feat/consolidate-chat-search-tools. See both as-built sections
below — the 2026-09-17 one supersedes the earlier "keep `find_chats`
compatible" recommendation and records why.

## Recommendation

Add two read-only Callboard tools backed by one shared query service:

- `search_chats`: global or current-view search, optionally restricted to
  top-level chats or to chats that are pinned, bookmarked, or on an open card.
- `get_chat_view`: report the caller's current sidebar filters and their
  freshness/source, so an agent can explain what “visible” means.

Keep the existing `find_chats` tool compatible. It is a folder-oriented
provider search with published behavior, not a suitable place to silently
introduce a different corpus, pagination model, or browser-dependent defaults.
Separate list tools can be thin convenience wrappers later if actual use
shows a discoverability problem; do not build three independent query paths.

> **Superseded (2026-09-17).** `find_chats` was deleted and its capabilities
> absorbed into `search_chats`. The scope control was right at the time — this
> was never a design preference for two tools — but leaving both in place left
> an agent choosing between two similar names, where the weaker one was blind
> to 51% of the corpus. See "As built: consolidation" below.

Working assumption: “visible filters” means the live sidebar settings and
submitted search from the browser tab that initiated the current chat turn,
not saved defaults. This is the one product clarification requested.

## What exists today

| Concern | Current implementation / implication |
| --- | --- |
| MCP tools | `backend/src/services/callboard-tools.ts` defines `find_chats`, `get_chat_tree`, `list_cards`, and `get_session_status`. `find_chats` requires a folder and concatenates provider-limited results before applying lineage filters; it is not globally paginated. *(Superseded 2026-09-17: `find_chats` is deleted; `search_chats` in `chat-query-tools.ts` is the only chat-search tool.)* |
| Sidebar server filtering | `backend/src/routes/chats.ts` implements discovery, metadata augmentation, bookmarks, triggered/native-child exclusions, card lifecycle, lineage pagination, and off-page pins. Extract this logic rather than calling Express handlers from MCP. |
| Sidebar browser filtering | `frontend/src/pages/ChatList.tsx` holds advanced filters, bookmarks, and submitted search in React state. Triggered/archived preferences also use browser localStorage. The server does not have the current view. |
| Shared filter definitions | `frontend/src/types/chatFilters.ts` distinguishes advanced filters from server-resolved view options. `cardLifecycleFor` widens archive scope during a submitted content search. |
| Top-level identity | `backend/src/services/chat-lineage.ts` has both `existingRootIdOf` (real surviving root) and `rootKeyOf` (sidebar grouping, including dangling keys). They answer different questions. |
| Cards | `card-fields.ts` and `card-context.ts`: a card is an eligible stored lineage root. Missing `metadata.card` means default-open, not “no card.” Triggered/job roots and native subagents must not become cards accidentally. |
| Pins and bookmarks | Chat pins are `metadata.pinned`; bookmarks are `metadata.bookmarked`. Both are distinct from `metadata.card.pinned`. Sidebar groups aggregate member pins, but tool predicates refer to individual chats. |
| Search limitations | `/api/chats/search` currently discovers up to 9,999 sessions per provider and requests up to 50 matches per folder. Provider text matching differs: Codex currently checks the first user prompt, not the entire transcript. Do not advertise exhaustive full-text search on top of this. |
| Authentication | `backend/src/auth.ts` authenticates a shared instance using browser sessions or API keys; there is no per-user profile containing sidebar preferences. Browser-session/tab context must be explicit. |

## Proposed tool contract

```ts
search_chats({
  scope?: "all" | "visible";              // default: all
  topLevelOnly?: boolean;                  // default: false
  anyOf?: ("pinned" | "bookmarked" | "open_card")[];
  query?: string;                          // title, stored preview, folder text
  folder?: string;                         // exact working directory
  limit?: number;                          // default: 20; maximum: 100
  offset?: number;                         // default: 0
});

get_chat_view({});
```

Examples addressing the three requests:

```js
search_chats({ topLevelOnly: true });
search_chats({ scope: "visible" });
search_chats({ anyOf: ["pinned", "bookmarked", "open_card"] });

// Composable: only matching chats within the current visible-filter scope.
search_chats({ scope: "visible", anyOf: ["pinned", "bookmarked", "open_card"] });
// Individual state queries use a single entry.
search_chats({ anyOf: ["pinned"] });
```

Contract details:

- All ordinary restrictions intersect. Entries in `anyOf` are OR-ed; reject
  an explicitly empty array. Omission applies no state restriction.
- `scope: "all"` does not inherit arbitrary browser browse preferences and
  includes archived/automated candidates. Ignored project directories remain
  excluded in every scope, including explicit folder searches and appends.
- “Visible” means **all chats satisfying the effective sidebar filters**,
  not only loaded pages, expanded tree children, or pixels in the viewport.
  It returns individual matching chats; it is not a screenshot of grouped rows.
- `topLevelOnly` selects actual surviving roots using the full lineage graph,
  before the query narrows the graph. Respect legacy forks, root-only job
  stamps, discovered native ancestry, deleted ancestors, and cycle bounds.
  Positive native-child evidence must not turn into a top-level user chat
  merely because its parent cannot be resolved.
- State predicates refer to the **individual chat**: `pinned` is its own chat
  pin; `bookmarked` is its own bookmark; `open_card` means membership in an
  eligible open, non-hidden lineage-root card. There is no `active` predicate.
- Top-level and state predicates still intersect literally: a pinned or bookmarked child
  does not make its root pinned or bookmarked. Return `rootChatId` so callers
  can navigate to the tree. Tree-level rollup search would be a separately
  named option, not a hidden change to these predicates.
- `query` is inexpensive metadata search, not a promise to inspect all
  transcript contents. Current-view submitted content search is an additional
  base predicate with the same provider semantics as the sidebar. Keep
  `find_chats` available for explicit provider content searches. *(Superseded:
  transcript search is now `search_chats({ grep })`, run after the record
  predicates have narrowed the candidate set.)*
- Dates use inclusive updated-time bounds; directory patterns use the
  sidebar's `displayFolder || folder` and case-insensitive matching. Convert
  browser-local date inputs to timezone-unambiguous instants before sending.
- Additional tool restrictions never remove or widen the captured view's
  restrictions. Only the sidebar's own submitted search activates its existing
  archive-scope widening rule.

Return compact rows with `chatId`, `sessionId`, `provider`/ACP vendor, `title`,
`folder`, `displayFolder`, timestamps, `parentChatId`, `rootChatId`, `pinned`,
`bookmarked`, and nullable card identity/lifecycle/hidden state. Include
`matchedReasons` for state queries and native read-only management information
where applicable. Avoid raw metadata and
transcripts by default.

The envelope includes `chats`, `total`, `hasMore`, `nextOffset`, `asOf`, and
`appliedFilters`; visible queries also identify the view revision and update
time. Globally sort by updated time descending, breaking ties by stable
identity, **after filtering and before pagination**. `total` counts matching
chats, not sidebar groups. When discovery/search budgets prevent completeness,
return `partial: true`, concrete warnings, and an unknown exact total rather
than disguising a lower bound as an exact count. Do not use `hasMore: false`
to assert completeness of a partially examined corpus.

## Implementation

### 1. Extract the shared query building blocks

- Add shared query/view DTOs and pure filter normalization/matching helpers
  under `shared/`; keep compatibility re-exports from the frontend filter
  module. Do not import frontend code into the backend.
- Extract discovery, augmentation, visibility predicates, and content-match
  collection from `routes/chats.ts` into backend services. Preserve the REST
  response shape, tree-row pagination, off-page pin behavior, and cache contract.
- Build one request-scoped corpus/lineage context from provider discovery and
  `listChatsSnapshot()`. The stored snapshot is a metadata/lineage index, not
  a replacement for filesystem-only session discovery. Conversely, do not
  return every stale stored-only record just because it is in the index:
  preserve the sidebar's rules for listable sessions and stored appendables.
- Resolve session aliases, provider ownership, and native parents once.
  Ambiguous identities must not silently attach to a different provider/chat.
  Deduplicate resumed-session aliases to one logical chat before pagination.
- Reuse/extract card membership from `card-context.ts` without invoking a full
  card rollup, job listing, or preview replay for every candidate. Reconcile
  the route's older native-lineage path against card-context fixtures before
  replacing it; similar-looking implementations are not necessarily equivalent.
- Preserve the triggered-filter exception for the representative chat of a
  job waiting on approval. Do not treat every automated chat as an unconditional
  exclusion or confuse “unarchived” with “has an open card.”
- Do not apply a provider's first-page limit before metadata/lineage filters.
  Enumerate candidates in bounded batches, or explicitly report partial
  coverage. The existing 9,999/50 caps must not masquerade as exhaustive results.
- Resolve expensive fallback previews only for returned rows. Use bounded,
  asynchronous/worker-backed execution for corpus text/regex work; moving
  arbitrary browser regex evaluation onto the daemon must not introduce an
  unbounded event-loop block. Validate pattern/date failures consistently and
  expose ignored/unsupported predicates, not silently different scopes.

### 2. Make the originating browser view available to the session

- Add a browser-tab view publisher and an authenticated backend view registry.
  Store predicates, not loaded chat IDs. Publish applied filters, view toggles,
  and the **submitted** search; exclude unsent search text and modal drafts.
- Give each tab a distinct opaque view identity. Bind ownership to the
  authenticated browser session using a server-side identity, never a caller-
  supplied user ID or a raw session cookie exposed to the model.
- Carry an optional view reference and initial normalized snapshot with the
  new-message/follow-up request. Register that snapshot before execution, so
  the first tool call cannot race the view publisher. Associate it with the
  running invocation, not a process-global “last active tab.”
- Thread the optional context through `routes/stream.ts`, the frontend message
  sender, and `claude.ts` into `buildCallboardToolsSpec`. Read the registry at
  tool-call time so changes made in the originating tab during a long turn
  become visible. Capture a single revision for the duration of each query.
- Use monotonic revisions to reject late updates, a heartbeat/expiry policy,
  and cleanup on logout/disconnect/expiry. A later turn sent from another tab
  binds to that tab; simply opening a chat elsewhere does not steal the binding.
- CLI, automation, old browser bundles, expired tabs, and daemon restarts can
  have no live view. `get_chat_view` explains that state; `scope: "visible"`
  returns a clear unavailable/stale-context error. Never silently fall back to
  unrestricted search or another tab. Explicit `scope: "all"` still works.
- Add only optional request fields; preserve wire compatibility. Prefer normal
  authenticated HTTP updates over adding a new SSE event type for this feature.
  The tools inspect filters; they do not change them.

### 3. Add the MCP surface

- Implement `backend/src/services/chat-query.ts` and a small
  `chat-query-tools.ts` builder (names illustrative), registered by
  `buildCallboardToolsSpec`.
- Update `mcp-tool-registry.ts` to match the real schemas and tool descriptions.
  Verify tool exposure through the common provider transports and read-only
  permission classification; do not add engine-specific implementations.
- Validate limits, offsets, query lengths, filter enums, dates, and view
  ownership. Errors should be structured and distinguish no matches from
  unavailable UI context and incomplete provider results.
- Avoid serving stale browser-list response-cache entries for tool queries.
  Reuse immutable/discovery caches, but evaluate metadata and the selected
  view revision at query time. Any result cache must include all predicates
  and appropriate metadata/view versions.

## Test and acceptance matrix

1. **Hierarchy:** ordinary roots, cross-folder/provider descendants, legacy
   `forkedFrom`, job root stamps, missing ancestors, cycles, filesystem-only
   sessions, and unresolved native-child ancestry.
2. **Visible-filter parity:** same frozen corpus plus same effective filters
   yields the same eligible IDs in sidebar and tool. Cover bookmarks, triggered
   visibility/approval exceptions, archived/hidden cards, card-less chats,
   include/exclude patterns, date bounds/timezones, and search widening.
3. **State truth table:** each state alone, every union combination, overlap
   without duplicates, pin versus bookmark/card-pin, all bookmark combinations,
   and member open-card inheritance. Include a pinned/bookmarked child with
   an unpinned/unbookmarked root. Reject `active` as an unsupported predicate.
4. **Pagination/completeness:** matches beyond provider page one, more than 50
   matches in one folder, more than the old discovery cap, multiple providers,
   stable ties, alias deduplication, accurate totals, and explicit partial/error
   behavior. Filtering must happen before the requested page is selected.
5. **View context:** two tabs with conflicting filters, two authenticated
   browser sessions, spoofed ownership, stale/out-of-order updates, the first
   message race, follow-up from another tab, expired context, old clients, and
   automation without a view. No global-last-writer behavior.
6. **Boundaries/performance:** ignored folders cannot be resurrected by pins,
   roots, or explicit filters; querying writes no chat/card metadata; expensive
   previews are page-bounded; discovery/native replay budgets are shared per
   response; pin/bookmark/card changes are not hidden by list-cache TTLs.
7. **Regression suites:** keep `chats.cards-only`, `chats.pinned`, native-child
   route tests, `chats.job-run-status`, `chat-lineage`, card-native integration,
   `ChatList.showArchived`, `ChatList.pinnedSections`, `ChatTreeList`, and
   `mcp-tool-registry.manifest` tests passing. Add focused query-service,
   view-registry/publisher, and MCP handler tests.

## Delivery sequence

1. Characterize existing predicates/corpus behavior with parity fixtures and
   extract shared helpers without changing sidebar behavior.
2. Deliver `search_chats` for all-scope, top-level, and state-union queries.
3. Add tab-context publication/binding, `get_chat_view`, and visible scope.
4. Run cross-provider integration/regression tests and a large-corpus
   performance check; verify the three example calls manually in the UI.

Not required for this change: persistent user profiles, board-filter mirroring,
pixel/expanded-tree scraping, search-result writes or adoption, a new full-text
index, ranking/embeddings, or changes to legacy `find_chats` semantics. *(That
last exclusion is what the 2026-09-17 consolidation lifted.)*


## As built (2026-09-16)

### Runtime seams

- `chat-query.ts` and `chat-query-tools.ts` implement the two new read-only
  tools. `anyOf` accepts only `pinned`, `bookmarked`, `open_card`; there is
  no execution-activity predicate or liveness projection. The existing
  `find_chats` schema and implementation are unchanged. *(Superseded 2026-09-17:
  `find_chats` is deleted and `searchChatsSchema` carries its filters.)*
- Shared building blocks, rather than an Express-handler adapter:
  `chat-discovery.ts` enumerates provider pages without a total-hit cap;
  `card-membership.ts` is the extracted metadata-only part of card-context;
  `chat-visibility.ts` shares archive/approval-exception predicates;
  `shared/types/chat-filters.ts` supplies the browser and daemon matcher.
  REST tree-row pagination, off-page pins and response caching remain in the
  route. Tools never consume that response cache or project runtime status.
- Membership now resolves historical session aliases and verified
  filesystem-only native parent anchors. Stored roots alone anchor cards;
  unresolved positive native evidence never becomes an ordinary root/card.
  Individual pins/bookmarks do not inherit group or card pins.
- Provider routing and alias deduplication precede tool filtering and stable
  global pagination. Stored-only candidates remain restricted to sidebar
  appendables (pins and related tree members); there is no adoption or
  wholesale listing of stale stored records. Exact cwd and ignored-directory
  boundaries also apply to appendables.
- Tool rows contain metadata titles/previews when stored; they do not perform
  fallback transcript-preview reads. Missing titles are explicit nulls.
  This keeps the query metadata-only and avoids unbounded preview I/O.

### Browser context

- Normal authenticated `PUT /api/chats/view-context` publishes the applied
  ChatList state. Optional `chatView` snapshots on both initial and follow-up
  message requests close the initial-publication race and bind the execution.
  No SSE enum/capability or global last-tab state was added.
- Ownership is the validated browser-session identity, retained only inside
  the server binding. API keys cannot publish a browser view. Tool output
  contains the tab handle, never the session cookie/token.
- Handles are per-JS-realm, not shared browser storage, and use the existing
  insecure-origin-safe ID strategy (plain HTTP/LAN works). Modal drafts and
  unsubmitted search text are excluded. Browser date inputs become absolute
  ISO instants before transport.
- Heartbeats run every 25 seconds; views expire after 90 seconds. Reads check
  session validity; cleanup runs every 30 seconds. Expired views keep bounded
  revision tombstones until session invalidation so delayed packets cannot
  resurrect stale filters. There is a 4,096-handle registry bound, reported as
  an error rather than evicting a different live tab.
- ChatList unmount sends a versioned DELETE. A delayed unmount cannot close a
  newer remount. No mounted ChatList (for example the folder-only sidebar,
  mobile chat-only layout), old clients, automation and expired/disconnected
  tabs have no live chat-list view; visible scope fails explicitly rather
  than guessing saved/default filters. Board/folder-view mirroring remains
  outside this feature.

### Content-search and completeness tradeoffs

- Submitted sidebar search and REST search share `chat-content-search.ts`.
  It searches discovered session files using the providers' actual text
  readers, **not** their folder-search result pages. This avoids both the
  Claude helper's hard 50-hit cap and repeatedly grepping the same directory
  to fill pages; `find_chats` keeps its published cap/semantics. *(Superseded
  2026-09-17: `search_chats({ grep })` uses the same module, so there is one
  content path rather than two.)*
- Semantics remain provider-specific: Claude uses case-insensitive basic
  grep over session JSONL, Codex the first prompt (native children use their
  nickname/path), Cline/ACP first-message previews, Pi derived message text.
  The tool explicitly reports this; it does not claim full-text indexing.
  The legacy REST folder search retains Claude-only worktree expansion;
  the new tool's `folder` predicate is always exact cwd. *(Superseded
  2026-09-17: `folder` is still exact cwd — matched against the record's cwd as
  well as the browse projection — and worktree expansion is the separate `repo`
  parameter, derived from records rather than from a live `.git`.)*
- Content work runs in up to two isolated workers, with a 15-second
  response deadline, 192 MiB worker heap and 32 MiB per-file read boundary.
  Claude grep batches contain at most 128 paths, not 128 hits. Overload,
  unavailable files, unsupported readers and exhausted budgets produce
  concrete partial-coverage warnings, null exact total, and null hasMore
  when further coverage is unknown. No limit masquerades as completeness.
- Advanced browser regexes run via the identical shared matcher in an
  isolated worker (at most two concurrent, 1.5-second deadline, 128 MiB heap). Invalid regexes retain
  the sidebar's skip semantics and are reported as ignored predicates;
  expensive regexes fail explicitly. Date bounds remain inclusive.
- Provider/native traversal failures are also reported as partial. A query
  captures one metadata/view snapshot; subsequent tool invocations read
  current metadata and the originating tab's latest accepted revision.

### Verification and reviewer focus

Focused coverage includes real stored/native/filesystem-only lineage,
archive/bookmark/triggered/search parity with REST, aliases and ambiguous
owners, individual OR semantics and active rejection, no-write/ignored-cwd
boundaries, 10,050-session discovery, filtering a 10,020-chat corpus before
pagination, 130 Claude content hits, worker error coverage, authenticated
ownership, initial/follow-up binding, live revisions and expiry/unmount races.
Existing /tmp-based route fixtures explicitly opt their directories in now
that the shared ignore boundary is enforced before discovery/appends.

Review `chat-query.ts` identity/appendable selection, `card-membership.ts`
native alias resolution, `chat-content-search.ts` worker limits, and the
`chat-view.ts` / browser publisher / stream binding path first.

#### Validation results

- Feature/ownership/manifest/wire/ignored-boundary selection: 13 files,
  101 tests passed. This includes the 10k-corpus tests and real native/REST
  parity fixtures.
- Broad route/native/sidebar regressions: 38 files, 600 tests passed
  (`chats.*`, `stream.*`, `card-native*`, `codex-native*`, legacy
  `chat-search` / Claude session provider, `ChatList.*`, `ChatTreeList`).
- `build:shared`, `build:computer-use`, `build:backend`, and
  `build:frontend` passed. Frontend retains its large-chunk warning.
- Staged-file `npm run lint`: zero errors; 290 warnings, including existing
  large-file React-hook/any/console warnings and test-fixture any warnings.
- Direct compiled-JavaScript content-worker smoke passed, including Node
  launched with `--input-type=module`. Worker bootstrap uses dynamic imports
  so inherited ESM execution flags do not break it.
- Existing lockfile dependencies were installed with
  `npm ci --ignore-scripts`; dependencies/lockfile were not upgraded.
- Initial failures from ignored /tmp fixtures, malformed-metadata preservation,
  test typing, and ESM worker bootstrapping were fixed and re-tested. No known
  failing test remains in these selections. A full repository test sweep and
  manual live-browser/provider run were not performed.

### Review round 1 hardening

- Native lineage is a captured, budgeted evidence boundary. When it is
  incomplete, search omits unverified Codex candidates (including stored pins)
  and candidates depending on an unverified root, with explicit partial
  coverage. Later provider discovery warming the metadata cache cannot promote
  an unknown child to an ordinary, writable root. This intentionally favors
  conservative partial results over extra unbounded metadata replay.
- Content session keys now include provider + ACP vendor + session ID;
  logical chat aliases live in a separate set. Only legacy REST search flattens
  the two namespaces to string IDs. Historical-only cross-engine discovery
  backs the logical record without replacing its current execution identity.
- Visible append reachability is computed after captured sidebar server
  predicates, before tool-only restrictions; appended relatives are filtered
  again. Excluded automation cannot introduce a stale stored-only root.
- DELETE creates a bounded, owner-scoped revision tombstone even before the
  first PUT/inline snapshot arrives. Explicit foreground message capture mints
  a fresh revision to renew an expired view; delayed old packets retain old
  revisions and remain fenced out.
- View validation/binding is message preflight, before branch/workspace,
  adoption, metadata and image side effects. No new wire enums were added.
- Shared UI/transport limits reject oversized predicates visibly at Apply or
  Search, without truncation (including inactive drafts). Invalid legacy UI
  state or a rejected publication disables that originating context and shows
  an actionable warning rather than attaching an invalid snapshot to every
  chat message. Messages remain usable without a view; visible tools still
  fail explicitly, never query unrestricted. Network failures may still be
  recovered by the authenticated inline snapshot.

#### Round 1 validation

- Full `npx vitest run`: 380 files passed, 3 skipped; 5,803 tests passed,
  32 skipped (includes manifest/wire, backend, frontend and regressions).
- Final focused query/content/view/stream/UI selection: 10 files, 96 tests
  passed. Original independent-review reproduction config: 2 files, all 5
  tests passed. New regressions are committed in-repo, not only in `/tmp`.
- `npm run build` passed (shared, computer-use, backend, frontend and import
  rewrite). Existing frontend large-chunk warning remains.
- `npm run test:computer-use`: 56 passed, 1 skipped. Staged lint on the two
  cohesive commits: 0 errors, 84 + 25 warnings. `git diff --check` passed.
- Development-only failures corrected: an implicit-any test callback, a
  test clock whose default function had been captured before spying, and a
  capacity-fixture timeout during concurrent full/focused suites. Capacity
  setup now skips redundant cleanup while seeding, then exercises real
  cleanup for its assertions. No outstanding test failures. No manual live
  browser run beyond component tests and real-file/provider integrations.

### Review round 2 hardening

- Browse projection and execution identity are separate: globally newest
  discovery backing supplies timestamps/folder/display-folder, including
  historical cross-engine backing. Later current-session discovery does not
  overwrite it. Returned provider/session remain the logical chat's current
  routing. This restores sidebar date, ordering and pagination parity.
- Rejected native headers (duplicate IDs, mismatches and unreadable metadata)
  now make native discovery explicitly incomplete, alongside budget misses.
  Aggregated reason/count warnings accompany the existing verified-session
  boundary. Search conservatively omits unverified candidates, stored pins
  and dependent roots without extra metadata replay.
- Uncertain historical ACP aliases do not revoke an independently owned
  current chat. Such aliases/matches are omitted with a warning; vendor
  isolation is unchanged. Historical-only ACP backing requires qualified
  ownership; a vendor transition cannot be inferred from raw session IDs.
- Publisher failure isolation now uses normalized applied-state/remount
  generations, not snapshot-object identity. Revision-only foreground
  captures, heartbeats and identical-state publications cannot hide a
  rejection. A confirmed newer successful publication of the same generation
  protects it from older failures; different state/remount generations remain
  isolated. Unconfirmed late failures disable attachment and disclose the
  unavailable view rather than poisoning subsequent message sends.

Round 2 validation: one full `npx vitest run` passed (380 files, 5,819 tests;
3 files / 32 tests skipped). Focused query/native/provider/publisher tests:
8 files, 134 passed. Both reviewer Vitest configs passed (7 backend assertions
plus the root ACP assertion). Real publisher/registry capacity reproduction
now reports one warning and no attached snapshot (the reproduction's
bug-expecting assertions were inverted in a `/tmp` copy); renewal and the
original unmount/oversized-state scripts still have the expected behavior.
Full `npm run build` passed, including import rewrite; staged lint has zero
errors and 7 fixture warnings. No test failures this round. No manual browser
run; existing large frontend bundle warning remains.

### Review round 3 identity correction

Lineage-enriched records may carry a historical native-parent anchor in their
`session_id`. Historical-backed query rows and stored-only appendables now
explicitly restore the canonical stored owner's session ID. The ordinary
provider-discovery path already did so; output consumes these corrected row
identities. New regressions cover historical backing with/without a current
log, ordinary current discovery, pinned appendables and native-tree relatives.
Newest browse fields and qualified content evidence are unchanged. No
UI/context runtime code changed.

Round 3 validation: 9 focused backend/native/query suites, 130 tests passed;
all backend review reproductions passed (9 assertions plus root ACP). View
capacity/renewal/unmount/oversized-state scripts still behave correctly.
Full build and final backend typecheck/import rewrite passed; staged lint:
0 errors, 3 existing fixture warnings. An initially invalid synthetic-child
filename in the new relative-append fixture was corrected to a valid rollout
filename before the green rerun. No additional full sweep was run this round.

### Post-merge follow-up corrections

- Native exclusion now requires positive Codex/native evidence, consulting
  canonical routing and provider-stamped rows for ancestors. Missing legacy
  `provider` metadata is not evidence of Codex. Cold native discovery no
  longer removes unrelated Claude/Cline/Pi/ACP roots or their descendants.
- Budget-deferred identities are separate from per-pass rejected identities.
  `nativeDiscoveryIncomplete` describes budget/traversal incompleteness;
  duplicates, malformed and unavailable headers are localized exclusions with
  aggregate warnings, not a permanent global exclusion mode. Query results
  still report partial coverage. Transient header I/O failures, like budget
  misses, are not cached as malformed metadata and are retried.
- Single-provider REST pages again delegate their window to the adapter (with
  a defensive full-corpus fallback for ineligible returned rows). All-corpus
  discovery requests a full snapshot once from each built-in provider, rather
  than rewalking it per thousand rows. Adapters imposing smaller pages still
  get drained with the existing stall/coverage checks. Provider tie ordering
  is deterministic before slicing; ignored-folder filtering remains before
  adapter pagination. This is not a new persistent filesystem index: one
  complete scan/snapshot is still required for corpus-wide queries.
- Publisher HTTP 429/5xx responses retain live state and retry on the existing
  25-second heartbeat, without a busy retry loop. Hard rejections still stop
  attachment; generation, accepted-revision and unmount protections remain.
- Visible content search now scans only surviving candidates' qualified
  provider/vendor/session identities, retaining all accepted historical
  aliases. Empty candidate/session sets do not create content workers.

Follow-up validation: initial reproductions had 9 failing assertions across
4 suites; after correction, 12 focused suites passed all 207 tests. Full
`vitest --maxWorkers=2`: 380 files / 5,849 tests passed, 3 files / 32 tests
skipped. All 9 external backend review assertions and root ACP passed; real
publisher capacity/renewal probes also passed. Full build passed; full lint
had 0 errors (1,143 warnings). Computer-use: 56 passed, 1 skipped. Real find
scan-count and endpoint tests cover >2,000 sessions; full-corpus enumeration
covers 10,050. No manual browser run or wall-time benchmark was performed.

PR455 review corrections:
- Captured rejected/deferred **current session** inventory now independently
  fences metadata-free pins and ancestors. Historical-only route inference
  cannot override it; explicit non-Codex routing or independently discovered
  current ownership can. Chat-ID collisions are not session evidence.
- Single-provider page hints require an explicit eligible-pages capability
  (currently Claude only). Other adapters use one complete filtered corpus,
  avoiding page-local coordinate changes from missing cwd. Whole-corpus
  requests always drain capped adapters; short ordinary windows also fall
  back to the drain. No per-1000-row builtin rescans were introduced.
- Real-file regressions cover rejected/unreadable legacy records, unchanged
  file recovery and ownership collisions; route tests cover actual Pi missing
  cwd, legacy eligibility and capped ordinary/postfilter windows. UI/context
  and content-search behavior are unchanged.

Review-fix validation (frozen final runtime): full Vitest with maxWorkers=2
passed 381 files / 5,867 tests (3 files / 32 tests skipped); external review
configs passed 54 assertions, including the new native and pagination cases.
Build and lint-all passed (0 errors, 1,154 warnings); computer-use passed
56 tests with 1 skipped. An interim full run overlapped the final collision
regression/edit and failed that new assertion; the frozen rerun above passed.
No manual browser run or latency benchmark; UI/context code was untouched.

## As built: consolidation (2026-09-17)

`find_chats` is deleted. `search_chats` is the single chat-search tool.

### Why deletion and not an alias

The split between the two tools was scope control from #454 ("changes to
legacy `find_chats` semantics" were out of scope), not a design preference —
and the same plan already said *do not build three independent query paths*.
What the split cost was concrete: an agent picking between two similar names
landed roughly half the time on the weaker index. Aliasing `find_chats` to the
merged implementation would have preserved exactly that, so the name goes.

Nothing outside the repo called it: 0 jobs, 0 skills, and the three in-repo
references were one test fixture using the name as a plausible MCP tool string
and two plan documents.

### The bug that made it urgent

`find_chats` was filesystem-first. `discoverProjectDirs` admitted a worktree
only when `resolveWorktreeToMainRepo` found a live `.git`, so removing a
worktree removed every chat that ran in it from the tool's reach — under every
filter, `grep` included. Measured on the development corpus: **129 of 255
claude-code sessions under `/home/cybil/callboard` (51%) sat in 52 removed
worktrees**, every one with `metadata.lastBranch` recorded correctly and a chat
record on disk. The data was never missing; the index refused to look at it.

Two smaller findings fixed alongside it:

- `chat-query.ts`'s `folder` predicate matched only `chat.folder`, the *browse
  projection* assigned during discovery enrichment. For a chat whose directory
  is gone that projection is the lossy decode of the project-dir name — a path
  that never existed. `/home/cybil/callboard.refactor-auto-create-worktree`
  returned 0 rows while the same chats came back under the fabricated
  `/home/cybil/callboard/refactor-auto-create-worktree`. What is *reported* is
  unchanged (two views of one git tree must agree); matching now accepts the
  record's cwd as well.
- The `meta.lastBranch` fallback at `chat-search.ts:325-329` was dead code —
  step 2 dropped null-branch directories before it could ever run.

### What `search_chats` gained

`repo`, `branch`, `agentAlias`, `triggered`, `grep`, `rootChatId`,
`parentChatId`, `updatedAfter`, `updatedBefore`, `sort`.

`folder` and `repo` are deliberately separate parameters, not one name with two
meanings: `folder` is an exact cwd, `repo` is a repo root that expands. Per
CLAUDE.md's `cwd`/`workspaceId` rule both are directory questions and both key
on `cwd`; workspace records are read for the `cwd`/`repoPath` pair they carry,
never for identity, and no `workspaceId` is parsed.

Repo membership (`chat-repo-scope.ts`) is derived from records first, and every
row reports which rule admitted it as `repoSource`: `exact`, `descendant`,
`workspace-record`, `live-git`, `sibling-path`. Only the last is an inference,
and it applies **only when the directory is gone** — a sibling that still
exists and does not resolve back to this repo is a different repo sharing a
path prefix, which `find_chats` rejected and so does this. That is the whole
fix: the reach is `find_chats`' reach minus the live-`.git` requirement.

`branch` reads `metadata.lastBranch`, written by `routes/stream.ts`'s
**generic** message route and therefore recorded by every engine, falling back
to the directory's live branch when it still exists. `branchSource` is
`record`, `live-git` or `unknown`. `agentAlias` and `triggered` likewise come
from records, so they narrow for every engine instead of `find_chats`'
claude-code-only behaviour of returning other engines' rows unfiltered.

`grep` is transcript search, explicitly opt-in and deliberately **last**: the
cheap record predicates narrow the candidate set, and only the survivors' files
are opened. `find_chats` grepped every JSONL under the folder tree unscoped;
scoped to an open card this is ~20 transcripts. It reuses
`chat-content-search.ts` — the same per-engine readers each adapter's
`searchSessions` greps with, under the existing worker time/heap/byte budgets —
rather than adding a third content path. Each hit reports `matchKind`:
`transcript` (claude-code, pi), `first-prompt` (codex, cline, acp), or
`metadata` (a Codex native child, whose "first prompt" is its nickname).

The governing rule for provenance is *never silently drop a row you could not
evaluate; stamp it*. A `branch` filter that meets a chat with no recorded
branch and no directory left counts those rows and reports them as a warning,
which also makes `total` honestly `null` rather than a confident undercount.

### What stayed

- The `SessionProvider.searchSessions` port and every adapter's implementation
  of it. Per-engine transcript matching belongs behind that seam.
- **Interpretation note.** The brief for this change said to delete "the dead
  aggregation in `chat-search.ts`" while keeping "the port and each provider's
  `searchSessions`". Those are the same code: `chat-search.ts`'s `searchChats`
  *is* `ClaudeCodeSessionProvider.searchSessions`. Keeping the port won, so
  what was deleted is the cross-provider aggregation that sat on top of it —
  the `for (const provider of getSessionProviders())` loop in the `find_chats`
  tool definition — and `chat-search.ts` remains as the claude-code adapter's
  implementation, with its own ignore-list test. Its `discoverProjectDirs`
  blind spot survives inside that adapter, but it is no longer the index an
  agent reaches for.
- The native-agent identity apparatus in `chat-query.ts`: `rejectedNativeSessions`,
  `unsafeNative`, ambiguous-identity warnings, retired-provider skip. `find_chats`
  had none of it and the merged tool does not lose it.
- Sidebar behaviour. Nothing outside `chat-query-tools.ts` imports
  `chat-query.ts`; `routes/chats.ts` has its own path.

### Parity guarantee

`backend/src/services/chat-search-parity.test.ts` builds a fixture shaped like
the motivating corpus — main checkout, live worktree, **removed** worktree, and
an unrelated repo sharing the path prefix — and drives *both* implementations
against it. The first `describe` pins `find_chats`' shipped behaviour across 19
query shapes (folder; folder+grep; folder+gitBranch; folder+agentAlias;
folder+triggered; date bounds; both sorts; parentChatId/rootChatId), including
the blind spot. The second asserts `search_chats` returns a **superset** of
each of those row sets under a mechanical translation of the filters, plus the
rows the baseline could not reach, and that it still refuses the neighbouring
repo.

### Verification

- `backend/src/services/chat-search-parity.test.ts` — 12 tests.
- `backend/src/services/chat-repo-scope.test.ts` — 8 tests.
- `chat-query.test.ts` (+4 cases), `chat-query.identity.test.ts`,
  `chat-query.integration.test.ts`, `chat-query.native-risk.test.ts`,
  `chat-query-tools.test.ts` — all green, unmodified apart from the additions.
- Full repository sweep and `tsc --noEmit` on the backend project.

### Deliberately not done

- No schema migration or backfill. `repo` reads what is already recorded.
- No change to `chat-search.ts`'s own worktree discovery. Fixing it there would
  be fixing the claude-code adapter's `searchSessions`, which has no caller and
  is not the path an agent takes.
- No wire-type (`shared/types/stream.ts`) changes; the new fields are MCP tool
  JSON, not SSE.

### Review round (2026-09-17, three parallel reviews of #456)

Independently cleared: identity safety, sidebar isolation, the no-per-row-scan
property, cheap-call cost, and the removal of `find_chats`' `getChat`-per-row
trap. What follows is what changed as a result of the 22 findings.

**Membership could admit a different repo.** `classify` returned
`RepoSource | null`, so "git was asked and said no" was indistinguishable from
"nothing could be asked" — and the caller, holding two spellings of a chat's
cwd, gave the fabricated one a second turn after the real one was refused. The
lexical `descendant` rule then admitted a neighbour as fact:
`callboard-contrast-shots` decodes to `callboard/contrast/shots`. Two changes:
`evaluate` now returns {@link RepoVerdict} with an explicit `refused`, and only
`null` earns a second spelling. Workspace records refuse as well as admit — one
naming a *different* `repoPath` beats the `sibling-path` inference, which it
previously lost to. Verified on the real corpus: 365 rows admitted across 131
directories (312 `workspace-record`, 26 `exact`, 21 `sibling-path`, 6
`live-git`), with `/home/cybil/callboard-contrast-shots` correctly refused.

**`repo` given a worktree returned one worktree's chats.** Callboard's normal
mode is an agent running inside a worktree, so `repo: process.cwd()` is both the
natural value and the broken one — `live-git` compares `mainRepoPath` against
the argument, so siblings and the main checkout both failed and `sibling-path`
could not fire, all with a confident total. `createRepoScope` now normalises
through `resolveWorktreeToMainRepoCached`, falling back to a workspace record
when the named directory is itself gone, and reports `appliedFilters.repoRoot` /
`repoNormalisedFrom`. Verified: `repo: <this worktree>` and
`repo: /home/cybil/callboard` return the same 365 rows.

**The schema documented nothing.** `defineTool` passes `inputSchema` straight
through, so the generated JSON Schema is all an agent sees; the registry is only
the browser's REST listing. Eleven absorbed parameters shipped as bare types
after `find_chats`' inline documentation was deleted rather than moved. Every
field now carries `.describe()`, the registry mirrors those strings, and the
manifest test keeps the two honest. The sharpest case was `rootChatId` /
`parentChatId` becoming **global** in this PR — undocumented, an agent keeps
passing `folder` alongside them and drops every relative that ran in another
worktree.

**Honesty rules applied consistently.** `grep` dropped candidates with no
discoverable transcript — stored-only pins, rows whose log is gone — with no
counter and a confident `total`, which is what the `branch` path had already
been changed to stop doing. Both content paths now share one helper that counts
and reports them. `matchKind`'s fallback defaulted an unknown engine to the
*strongest* claim; it is keyed by `AgentProviderKind` now, so a new engine is a
compile error, and pi is `messages` rather than `transcript` — pi's
`deriveSearchText` is conversational text with no tool traffic, where
claude-code greps raw JSONL including tool results, and an agent hunting a file
path must not read the absence of pi hits as evidence.

**Unscoped grep is refused, not merely slow.** `find_chats` never needed this
guard because its `folder` was required; `search_chats` made a corpus-wide grep
reachable in one short argument list — measured at 2,096 files / 1.15 GB /
~3.3 s, against 609 ms alongside `anyOf: ["open_card"]`. `grep` now requires a
narrowing filter and throws `GREP_UNSCOPED` (1 ms) rather than returning a
correct-looking page that cost the corpus.

**Live branch reads no longer spawn.** `getGitInfo` on a directory with no
`.git` of its own shells out to `git rev-parse --git-dir` with a 5 s timeout —
2.73 ms against 0.03 ms for a directory that has one — and this path has no
worker, deadline or cap. `nearestGitDir` walks up with `existsSync` and hands
git a directory it serves from HEAD. Measured after: `branch=main` over the
whole corpus is 480 ms end to end.

**Pool saturation is now distinguishable.** `collectContentMatches` reports a
busy pool as a warning plus an empty result set, which reads from outside
exactly like "nothing matched"; the sibling pool (`matchAdvanced`) throws for
the same condition. `chat-query.ts` now throws `CHAT_CONTENT_BUSY` instead of
returning a successful-looking empty page.

**Deferred, deliberately.** Two things in `chat-content-search.ts` /
`chat-content-worker.ts` are pre-existing and shared with `routes/chats.ts`, and
half-fixing either is worse than leaving a note:

- *The worker's budgets do not nest.* Claude batches are 128 paths each with a
  5-second `execFileSync` timeout, inside a 15-second worker deadline — so a
  corpus-sized run could spend 17 batches x 5 s against a 15 s ceiling and the
  per-batch timeout never binds. The outcome is already honest (the deadline
  fires, the warning says so, `total` goes null), and `GREP_UNSCOPED` removed
  the input size that made the mismatch reachable from this tool: a scoped grep
  is 24 files and 609 ms. Threading a remaining-time budget into each batch
  changes behaviour the sidebar's submitted search shares, so it belongs in its
  own change.
- *Three callers contend for two slots.* `grep`, the sidebar's submitted search
  and `routes/chats.ts:245` share one pool. Throwing `CHAT_CONTENT_BUSY` makes
  saturation visible to this tool's caller, which was the reviewable half;
  sizing or queueing the pool is not.

**`lastBranch` is last, not all.** A chat that moved between branches records
only the most recent one, so `branch=` can miss a chat that genuinely worked on
the branch asked for. Documented on the schema field and in the row's provenance
comment rather than counted as unevaluable — counting stale-record misses would
change `total` semantics for a case nothing distinguishes from a true miss.

**`partial` / `total: null` — investigated, no fix.** The concern was that the
identity warnings make `total` null almost always. Measured on the real 2,095-row
corpus: those warnings fire **zero** times. What does fire is
`nativeDiscoveryIncomplete`, and only on a cold process — it is a 16 MB
metadata-read budget that memoises what it read. Pass 1: 1,801 rows,
`partial: true` (and honestly so — 294 rows really were omitted). Passes 2-5:
2,095 rows, `partial: false`, `total: 2095`. The daemon is long-lived and the
sidebar polls every 15 s, so the warm state is the normal one and the signal is
meaningful.

**Also:** rows now report `agentAlias` and `triggered`, so the filters are
self-checking the way `branch` is; `branchSource` is resolved for the page's
rows rather than only when `branch=` was passed, so "unknown" no longer means
"we never looked"; `folder`/`repo` must be absolute, because a relative path
would resolve against the daemon's cwd rather than the caller's.

### Review round two (2026-09-17, over-correction hunt on the fix delta)

Round two reviewed only the previous round's delta and found that two of those
fixes had over-corrected. Both were proven against the live workspace registry
rather than a fixture, and **both reached green CI** — which is why the third
item here is about the tests.

**The refusal vetoed genuine members.** `repoPath` is written once at creation
and never re-normalised, so a worktree spawned from a worktree records its
*parent worktree* as its repo — a normal Callboard shape. String-comparing the
field read that as "not this repo", the veto ran first and short-circuited, and
nothing downstream could recover the row. Measured over 174 live workspace
cwds: `sibling-path` went 1 → 0 and `refused` 0 → 28, and **the one row lost was
the 51% rule's only live customer** (`callboard.feat-ori-agent-callboard-integration.feat-pi-adapter-phase-0`).
Three variants held too: a moved or renamed repo would make all 146 records
naming `/home/cybil/callboard` refuse, because `samePath` degrades to a string
compare when `realpathSync` throws on a dead path; the bucket loop returned on
the first non-matching record, so a newer record could veto an older one naming
this repo; and an existing directory inside the repo could be refused on a
stale field. Now: admissions are read first and across the whole bucket,
`repoPath` is resolved through `resolveWorktreeToMainRepoCached`, an
unresolvable one never vetoes, and the on-disk `descendant` fact outranks the
record. Live tally after: `sibling-path` 1, `refused` 27 (all genuinely other
repos — perch, drawlatch, countinghouse).

**`nearestGitDir` answered for directories that do not exist.** The upward walk
did not check that its starting point was there, so
`/home/cybil/callboard/feat/gone/worktree` reported `main`. The stamp was the
least of it: a non-null live branch makes `recorded === null && live === null`
false, so a chat in a removed worktree with no recorded branch was dropped from
a `branch=` query as a *proven mismatch* instead of counted as unevaluable —
the honesty counter this PR built, defeated by the performance fix sitting next
to it. One `existsSync` guard restores `null` and keeps the whole measured
saving, which was for live subdirectories.

**Normalisation was one hop and trusted `repoPath` verbatim**, so
`createRepoScope("<nested worktree>")` produced a *worktree* as its `repoRoot`
and that scope then refused the real repo — for precisely the usage
normalisation exists to serve. It iterates now, bounded, preferring live git and
falling back to a record only when the directory is gone, with a deterministic
choice among several records on one cwd.

**Two of the twelve grep-narrowing filters narrowed nothing.** The guard tested
`!== undefined`, so `topLevelOnly: false` (the documented default) and
`query: ""` both satisfied it and opened all 2,096 transcripts while the caller
believed a guard held. `query` is `.min(1)` at the schema; the predicate checks
`topLevelOnly === true` and a non-blank `query`. An explicit
`updatedAfter: "1970-01-01"` is still accepted — it narrows nothing, but the
caller reached for it on purpose.

**A `null` repo verdict is counted.** `null` and `refused` were dropped
identically, but `null` means the directory is gone, nothing recorded it and its
name says nothing — a removed worktree in `~/worktrees/foo`, invisible to `repo`
and indistinguishable from a genuine absence. It is now counted and warned about,
the same rule the branch filter follows. On the live corpus that is 2 rows out
of 366, named rather than absorbed.

#### The net that let two regressions through

Round two mutation-tested the suite and found the reach rules mutually
redundant: killing the gone-`descendant` rule or the caller's two-spelling loop
passed 109/109, and killing `sibling-path` failed only a *stamp* assertion.

The redundancy is structural, and worth stating because it will recur. A
claude-code session's folder is decoded from its project-dir name, and the
decoder commits a segment as soon as the path so far exists — so while the repo
directory is on disk, every sibling `repo<sep>suffix` projects to
`repo/suffix`, which is *inside* the repo. `sibling-path` is therefore only ever
the sole admitting rule for an engine that records its cwd **verbatim** (codex,
pi, cline, acp read it out of the session file). The fixture now models one.

`each reach rule is individually load-bearing` gives every rule a row no other
rule can admit, asserted **present** rather than asserted-with-a-stamp, so
deleting a rule loses a chat instead of relabelling one. The
`shapesWithNonEmptyBaseline` count was renamed from `constraining` for the same
reason: every row it counts is one `find_chats` could already see, so it is
fixture-liveness, not reach coverage, and the old name invited the confusion.

Mutation results after (11 mutants, `chat-search-parity` +
`chat-repo-scope` + `chat-query` + `chat-query-tools`): **11 killed, 0
survivors**. The three that previously survived or only mis-stamped now fail
named reach assertions — `sibling-path reaches a removed worktree that only its
name identifies`, `gone-descendant reaches a removed directory inside the repo`,
and `the second spelling reaches a chat whose record cwd answers nothing` — and
killing the two-spelling loop now also fails the superset guarantee itself.

### Gate round (2026-09-17)

**`repoUnevaluated` — corrected figure and method.** The earlier note said "2
rows out of 366". The row count was right on this machine and the total was
stale; the measured figure is **2 rows out of 365**, and it is worth recording
how it was obtained, because a reviewer measuring the same counter got 17.

Instrumenting the counter itself (not `classify` in isolation) on the live
corpus:

```
searchChats({ repo: "/home/cybil/callboard" })
  → observedMatches 365, total null, partial true
  → "2 chats ran in a directory that is gone, is not recorded in any workspace
     and does not follow the worktree naming convention"
  → both rows: /home/cybil/cb-p4-scratch, nearest existing git ancestor = none
```

Two populations are easy to conflate here and the difference is the whole
discrepancy. Over **all 9,053 stored chat folders**, 317 rows across 187 folders
classify `null` — close to the ~348/~210 a reviewer reported, and the right
number for that question. But `rows` is built from *discovered sessions*, and
stored-only records are appended only when pinned or lineage-related, so almost
none of those 317 ever become query candidates. The counter measures candidates.

Of those 187 `null` folders, **zero** have a non-this-repo git ancestor. The
reason is worth stating: they are record cwds like
`/home/cybil/perch.feat-x-api-provider`, whose nearest ancestor is `/home/cybil`
and has no `.git`. The projection spelling — `perch/feat-x-api-provider` — does
sit inside a live repo, but never reaches `null`, because `recordRefuses`
answers on the record spelling first and the caller's loop short-circuits.

**The ancestor discriminator is implemented anyway**, and it is a backstop
rather than a correction. A gone directory whose nearest existing ancestor
resolves to a repository that is not this one has an answer — its own repo's —
so it is `refused`, not "nothing could be asked". Today that outcome depends
entirely on a workspace record existing, and records are only written when a
chat starts in a worktree and the entity is recent, so the no-record case is the
common historical shape and the one this covers. Placed **last** in the gone
branch, after `descendant` and `sibling-path`, or a checkouts directory that is
itself under version control would refuse this repo's own removed worktrees.
A/B on the live corpus: 365 rows with the rule and 365 without, nothing dropped
and nothing added — it changes no answer here, and would on a machine whose
removed worktrees lack records.

**`recordAdmits` compares with `samePath`**, not `===`. The direct arm
realpath-normalised and the transitive arm added in the previous round did not,
so a caller who typed an aliased spelling of the repo lost a row that should be
`workspace-record` — which then fed the `null` counter. Every other comparison
in the module already used `samePath`.

**Parity-file timing.** Four tests in `chat-search-parity.test.ts` timed out in
CI at 5001–5026 ms on the 5 s default while passing locally. The cause was
recomputation, not a tight limit: three tests looped the 19 query shapes and a
fourth looped them again, each iteration re-running provider discovery (a `find`
over the transcript tree) and the legacy path's `ls`/`grep` — roughly 90
subprocess-backed calls for 19 distinct answers. `shapeResults()` computes both
implementations' answers once in a `beforeAll`; the baseline loop calls
`findChats` once per shape instead of twice; the grep test makes one call rather
than two. File duration 10.88 s → 5.69 s, slowest single test 2205 ms → 998 ms.
The file then sets an explicit `vi.setConfig({ testTimeout: 30_000 })` with a
comment: 30 s is a deadlock guard with room for a machine several times slower
than the development one, not a performance budget.

**Side effect worth naming:** `query: z.string().min(1)` was added for the grep
guard, but it applies to every call — `query: ""` is now rejected outright
rather than treated as "no text filter". That is arguably the better contract
(an empty substring matches everything, so it never meant anything) but it is
wider than the guard that motivated it.

**Not changed, with evidence.** A logged, caught
`No "resolveWorktreeToMainRepoCached" export is defined on the "../utils/git.js"
mock` from `chat-lookup` was attributed to this branch. It is pre-existing:
`chat-lookup.ts` has imported that symbol since `26ba7075`, which is on
`origin/main`, and this branch does not touch the file. It does not reproduce
here — 0 occurrences across a full 5,916-test sweep, and 0 when the suspect
suites run alone — so it is ordering- or environment-dependent. Completing the
seven bare `git.js` mocks that omit the export was tried and reverted: it
changes the outcome of **13 tests across `chats.preview` and
`chats.job-run-status`**, which currently depend on `chat-lookup` taking its
catch path. Making those suites assert the post-fix behaviour is a real change
to the sidebar preview path and does not belong in this PR.
