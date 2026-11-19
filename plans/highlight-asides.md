# Highlight text → ask, and asides

Select one or more passages in user or agent messages, then ask about them —
either in the main chat (quoted into the composer) or as an **aside**: a
branch off the main thread that is viewed in a side panel of the same chat
page, without leaving or disturbing the main conversation.

## Decisions (from the user)

- **Context is frozen.** An aside sees the parent's history up to its branch
  point and nothing after. This is exactly what a fork gives us.
- **Permissions inherit** from the parent chat by default, with a convenient
  one-click **Read only** toggle (fileWrite + codeExecution → `ask`, rest
  inherited, never looser than the parent). The toggle's last state is saved
  in localStorage and pre-selected next time.
- **Harness and model** default to the parent's. The user may change either;
  the last explicit override is saved in localStorage and offered as a
  one-click recent choice next time (the default stays "same as chat" — an
  inherited choice is never silently replaced by a stored one, because the
  stored model may belong to another harness). Harness changes go through the
  existing handoff fork path (tool calls flattened to text).

## What already exists (reuse, don't rebuild)

- `POST /api/chats/:id/fork` (`backend/src/routes/chats.ts`) — copies history
  up to and including a message timestamp into a new child chat; writes
  `parentChatId`, `rootChatId`, `chatRole`, `forkedAt`; supports `provider`,
  `model`, `effort`; allowed while the parent is streaming.
- `services/chat-fork.ts` — `resolveForkSource`, `writeForkedSession`,
  `inheritedChatFields`.
- Fork markers: `frontend/src/utils/forkMarkers.ts`,
  `frontend/src/components/ForkPointMarker.tsx`, `BRANCH_ROLES` in
  `frontend/src/utils/chatRewrite.ts`.
- Bubbles are wrapped in `[data-message-index]` in `frontend/src/pages/Chat.tsx`.
- `chatRole` is free-form on the wire (`ChatTreeNode.role`), so `"aside"` is
  NOT a gated enum value. Old bundles see an aside as an ordinary child chat.

## Wire compatibility

- New fields are optional and additive (`asideQuotes` on chat metadata and on
  `ChatTreeNode`; new optional request fields on the fork route). No new
  `stream.ts` event types, so `wire-surface.snapshot.json` should not change.
- Per-chat UI state (quote tray, open aside) keys on chat id, never `cwd`.

## PR stack

### PR 1 — Select & quote (frontend only)

- `useTextSelection` hook on the transcript container: on selection inside a
  single `[data-message-index]` bubble whose message is a timestamped text
  message (same rule as `hasMarkerSlot`), show a floating toolbar:
  **Quote** (add to tray) and **Ask** (add to tray and focus composer).
  Cross-message selections are refused (toolbar not shown), not merged.
- Quote tray above the composer: chips `{ messageIndex, timestamp, role, text }`,
  removable, keyed per chat id, cleared on send.
- On send in the main chat, the quotes are prepended to the prompt as Markdown
  blockquotes with a short origin line (e.g. `> **Assistant, 14:02:**`).
- Pure helpers (`buildQuotedPrompt`, selection → quote) are unit tested.
- Mobile: toolbar must work with touch selection (long-press select).

### PR 2 — Asides (backend + creation UI)

- Fork route: optional `kind: "aside"`, `quotes`, `prompt`, `permissions`.
  - `chatRole: "aside"`, `asideQuotes` stored in metadata, title
    `Aside: <question, truncated>`.
  - Fork point = latest timestamp among quotes (client sends it as
    `timestamp`; server validates every quote timestamp ≤ it).
  - Permissions: inherited `defaultPermissions` unless `permissions` given;
    a given value is clamped to never be looser than the parent's.
  - When `prompt` is given, the first turn is started immediately through the
    same code path `POST /:id/message` uses (quotes rendered as blockquotes +
    question), so the user does not have to send twice.
  - A short aside instruction is appended to the system prompt each turn
    (server-built, survives resume): answer the side question about the quoted
    passages; do not continue or redo the main task.
- `ChatTreeNode.asideQuotes?` exposed via `chat-lineage.ts`.
- Creation UI: the tray gains **Ask as aside** alongside the main-chat send,
  with a compact options row: Read-only toggle, harness/model picker
  (defaults: same as chat; recent override chip), both persisted via
  `frontend/src/utils/localStorage.ts`.
- `"aside"` added to `BRANCH_ROLES`; `ForkPointMarker` labels asides
  separately ("N asides"). Clicking still navigates to the aside chat in this
  PR.
- Backend tests for the route (role, metadata, clamp, auto-start, refusal of
  quotes after the fork point); frontend tests for the options persistence.

### PR 3 — Aside panel & highlights

- Aside panel: a right-hand drawer in the chat page, opened via
  `?aside=<childChatId>`, showing the aside thread with full chat features
  (streaming, approvals, stop, composer). First approach: `Chat` gains a
  `chatId` override + `embedded` mode (no header/sidebar chrome, no
  navigation or new-chat redirects, scoped shortcuts). The main chat keeps
  its scroll position and keeps streaming. Mobile: full-screen sheet.
- Aside list: the marker chip opens the panel instead of navigating; a
  header control lists all asides of this chat.
- Highlights: quoted ranges of asides are painted with the CSS Custom
  Highlight API (no DOM mutation of memoized bubbles); hovering an aside chip
  emphasises its ranges. New theme variable `--aside-highlight-bg` (both
  themes in `index.css`, `BUILTIN_PALETTE`, `THEME_VARIABLE_NAMES`). Graceful
  no-op where `CSS.highlights` is unsupported.
- Asides are hidden as separate rows in the sidebar tree (`ChatTreeList`);
  the parent row shows an aside count. Still visible in `get_chat_tree`.
- **Insert into main chat** on an aside reply: quotes it into the main
  composer tray (reuses PR 1).

### PR 3 — embedded-Chat audit

The panel renders a second `Chat` (`chatId` + `embedded`), keyed per aside,
inside the main chat's page row. Everything in `Chat.tsx` that is global to the
page was checked:

| Concern | Finding | Handling |
|---|---|---|
| `activeChatViewEntry` (module-scope compose-screen slot) | A second publisher logs an error and could steal a new-chat redirect's claim | The embedded chat never publishes |
| `location.key`-keyed state (staged model/effort, opened Staging draft, new-chat origin) | Opening the panel is a navigation, so it rotated the key and dropped the main chat's open draft | `useChatViewKey`: an aside-param-only change keeps the view; the embedded chat's view is `embedded:<id>` |
| Route state, `?folder`, new-chat path | Would leak the main route's state (in-flight handoff, draft prefill) into the aside | Ignored when embedded |
| `navigate` calls | Fork → whole page goes to the fork (user-chosen); continue/compress/rerun → `onReplaced` puts the replacement in the panel; header back/new-chat redirect are header/new-chat only | — |
| `window` keydown (scroll latch) | Focus on `<body>` unlatched both transcripts on PageUp | Body-targeted keys belong to the main chat only |
| `document` visibilitychange, SSE, polls, timers | Per-instance, keyed on each instance's own chat id | Unchanged: both refetch their own chat on resume, both stream |
| Selection toolbar listeners (`useMessageTextSelection`) | Container-scoped; Escape only acts with its own range | Unchanged |
| Quote tray / composer drafts | Keyed by chat id | Unchanged; "Insert into main chat" writes the main id's tray |
| `document.title` | Not set by Chat | — |
| `CSS.highlights` names | Page-global | Only the main instance paints (embedded passes no asides) |
| Remount of the main chat | A conditional wrapper would remount it | Page shape is constant: the main chat is always the first child of `.chat-page` |
| Modals from the embedded chat | `position: fixed`, z-index 1000 | Panel has no `transform`; sheet z-index 40 sits below them |

Nested asides (Ask as aside inside the panel) are not offered.

## Out of scope (for now)

- Live (non-frozen) asides.
- Merging an aside's conversation back into the main session history.
- An MCP tool for agents to create asides.
