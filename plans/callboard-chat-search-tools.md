# Callboard chat search tools

Status: implemented on feat/callboard-chat-search-tools; see as-built notes below.

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

Working assumption: “visible filters” means the live sidebar settings and
submitted search from the browser tab that initiated the current chat turn,
not saved defaults. This is the one product clarification requested.

## What exists today

| Concern | Current implementation / implication |
| --- | --- |
| MCP tools | `backend/src/services/callboard-tools.ts` defines `find_chats`, `get_chat_tree`, `list_cards`, and `get_session_status`. `find_chats` requires a folder and concatenates provider-limited results before applying lineage filters; it is not globally paginated. |
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
  `find_chats` available for explicit provider content searches.
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
index, ranking/embeddings, or changes to legacy `find_chats` semantics.


## As built (2026-09-16)

### Runtime seams

- `chat-query.ts` and `chat-query-tools.ts` implement the two new read-only
  tools. `anyOf` accepts only `pinned`, `bookmarked`, `open_card`; there is
  no execution-activity predicate or liveness projection. The existing
  `find_chats` schema and implementation are unchanged.
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
  to fill pages; `find_chats` keeps its published cap/semantics.
- Semantics remain provider-specific: Claude uses case-insensitive basic
  grep over session JSONL, Codex the first prompt (native children use their
  nickname/path), Cline/ACP first-message previews, Pi derived message text.
  The tool explicitly reports this; it does not claim full-text indexing.
  The legacy REST folder search retains Claude-only worktree expansion;
  the new tool's `folder` predicate is always exact cwd.
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
