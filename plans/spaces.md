# Plan: Spaces — separate chat contexts

Give Callboard named **environments** (e.g. _Work_, _Personal_, _Callboard dev_,
_Research_). Every chat belongs to exactly one environment. The sidebar, board,
search and the agent-facing chat tools show only the active environment, so work
in one area doesn't get mixed up with the others.

Status: **Phases 1–3 implemented** (2026-10-08); phase 4 is out of scope. Originally drafted as "environments"; renamed — see Decisions. Where the text below says "environment", read "space".

Implementation notes (where the build differs from the text below):
- Instructions reach Claude Code and Codex, the two harnesses that accept a system-prompt append. ACP, Cline and pi chats don't receive them, the same as the existing explicit-completion instruction.
- `agentScope.skills` builds a scoped copy of the custom-skills plugin for Claude Code (`~/.callboard/custom-skills-scoped/`). pi still loads every custom skill.
- A job's space is `defaults.spaceId` on the definition, set with the job tools or JSON import. There is no UI field for it yet.
- `GET /api/spaces` counts chats only with `includeCounts=true`, because the count is a pass over the whole corpus and the switcher refetches the list on every metadata change. Needs-you counts come from the sidebar's existing card index instead.

---

## Why

Today every chat sits in one flat list (`~/.callboard/chats/*.json`, merged with
discovered CLI sessions). The sidebar groups by parentage tree and Pinned/Recent
only. Card `category` and the directory include/exclude filters partly cover
this, but:

- Directory filters are per-view, client-side, and folder-shaped. Thinking isn't
  folder-shaped: "Research" spans many repos, and one repo can host both "product
  work" and "experiments".
- Agents see everything. `search_chats`, `list_cards` and `get_chat_tree` return
  results from every area, so an agent working on a client project can pull in
  personal chats.
- New-chat defaults (recent dirs, model, permissions, worktree default) are a
  single global set in localStorage. Different kinds of work want different
  defaults.

## What an environment is (and isn't)

An environment is **owned state**: a label that belongs to a chat or card
tree. It is **not** a directory property.

Under the `cwd` vs `workspaceId` rule in `.claude/CLAUDE.md`, the environment
sits with `workspaceId`, on the owned side:

| Keyed on `cwd` (unchanged)                 | Keyed on environment (new)                                  |
| ------------------------------------------ | ----------------------------------------------------------- |
| git status, diff, branches, file explorer  | which chats/cards are visible                               |
| worktree resolution, `viewForDirectory`    | new-chat defaults, recent directories                       |
|                                            | env instructions, agent tool scoping                        |

Consequences:

- **One folder can be used in several environments.** `~/callboard` can have chats
  in both _Callboard dev_ and _Research_. Git state for that folder is the same in
  both, which is correct.
- **Folder rules only set defaults.** "Chats in `~/work/**` default to _Work_"
  picks the environment for a new or discovered chat. It never re-files an
  existing chat.
- **Above workspaces and cards, not a replacement for them.** Environment →
  cards (with `category` still grouping inside an environment) → chats →
  workspace/folder.
- **Not the Agents feature.** An agent is a persona with its own workspace and
  memory. An environment can _set_ a default agent, but it isn't one.

## Data model

```ts
// shared/types/environment.ts
interface Environment {
  id: string;            // opaque, "env_…"; "default" is reserved
  name: string;
  emoji?: string;
  color?: string;        // token name, not a literal: see Theming in CLAUDE.md
  order: number;
  archived?: boolean;
  folderRules?: string[];          // globs → default env for new/discovered chats
  defaults?: NewChatDefaults;      // phase 2
  instructions?: string;           // phase 3
  agentScope?: { plugins?: string[]; skills?: string[] }; // phase 3
  createdAt: string; updatedAt: string;
}
```

- Store at `~/.callboard/environments/<id>.json`, one file per environment like
  workspaces. Writes are PATCH-shaped (see the whole-list-writes memory: two tabs
  over remote access is the normal case).
- On a chat, add `metadata.environmentId?: string`, an optional key in the existing
  metadata blob. A missing value means **`default`**, so existing chats need no
  migration or file rewrites, and the list cache (keyed on mtime and size) stays
  valid.
- **Card trees never span two environments.** The environment is resolved at the
  lineage root, the same way `archived` is resolved through `walkToRootId`.
  Children are stamped at spawn for cheap filtering, but the root wins. Moving a
  card moves the whole tree.
- **Discovered sessions** (CLI-started, no chat file) resolve through folder
  rules, then fall back to `default`. The result is computed per response, not
  written.
- **Jobs:** a job definition has an optional `environmentId`. Its runs and
  triggered chats inherit it, falling back to the `rootChatId` card's
  environment.

## Phases

### Phase 1: partition the view (the core of the feature)

Backend:
- Add `GET/POST/PATCH/DELETE /api/environments`. DELETE only works on an empty
  environment, or takes a `moveTo`.
- Add `environment=<id>|all` to `GET /api/chats`, `/api/cards` and
  `/api/chats/:id/tree`. **Add it to the `chatListCache` key** (`routes/chats.ts:287`),
  or the cache will serve one environment's list to another.
- Filter in `chat-visibility.ts` next to `excludeTriggered`, so pagination
  (`paginateTreeRows`) counts tree rows after filtering.
- Add `PATCH /api/cards/:id { environmentId }` to move a tree, plus a bulk move
  (by selection, or "everything in folder X").
- Spawned chats inherit the caller's environment in `start_chat_session`,
  including `independent: true` spawns. Being parentless shouldn't send a chat to
  `default`; see the spawned-chats-need-parent memory.

Frontend:
- Add an **environment switcher** at the top of the sidebar: emoji, name, and a
  small "needs you" count per other environment. **Separation must not hide a
  blocked chat:** the board's "Needs you" bucket and notifications stay
  cross-environment, tagged with an env chip.
- Store the active environment in the URL as `?env=` so tabs differ and links
  work, with the last-used one in localStorage as a fallback. `/chat/:id` stays
  unprefixed. Opening a chat from another environment switches to it, with a
  quiet toast.
- New chats go into the active environment. The panel shows an env chip that can
  be changed before sending.
- Add a "Move to environment…" action on card and chat rows.
- Search is scoped by default, with an "All environments" toggle that shows env
  chips on the results.

### Phase 2: per-environment defaults

- Move `recentDirectories`, default provider/model/effort, `defaultPermissions`
  and `worktreeByDefault` from the global `claude-code-settings` localStorage blob
  into `Environment.defaults`, server-side. They then follow the environment
  across devices.
- Keep the global localStorage values as the fallback for an environment that
  has no defaults set.
- Optionally set a default agent per environment.
- Optionally give each environment an accent colour, so you can see at a glance
  which one you're in. It should be a token-based tint, not a full theme.

### Phase 3: scope what agents see and get

- **Instructions:** append `Environment.instructions` to the system prompt for
  regular chats in that environment, at the hook in `claude.ts:~1395` where the
  proxy listing is appended. Do the equivalent for Codex/OR. Keep it capped; see
  the agent-prompt-bloat memory.
- **Callboard MCP tools:** pass `getEnvironment()` into `buildCallboardToolsSpec`,
  alongside `getPermissions`.
  - `search_chats`, `list_cards` and `get_chat_tree` default to the caller's
    environment and accept `environment: "all"`.
  - Explicit-id tools (`read_session_messages`, `continue_chat`) still work across
    environments, because naming an id is deliberate. They should report the
    target's environment.
- **Plugins/skills subset:** `agentScope` filters `buildMcpServerOptions` and
  `buildPluginOptions`. An example is turning off the Slack MCP in _Personal_.
- **Storage/artifacts/canvases:** start global. Add an optional
  `environmentId` tag later if lists get noisy. These are looked up by key, so
  leaks are less of a concern.

## Risks and gotchas

- **Naming collision.** "Environment" already appears in the UI as
  `SystemInfo.environment` (NODE_ENV) in About, "Environment Variables" for MCP
  plugins, and "Environment & Tools" (TOOLS.md). It also appears in the code as
  Codex `<environment_context>` and `agentEnvPolicy`. It also suggests
  dev/staging/prod. **Consider _Space_ in the UI** ("Work space" reads badly, but
  "Space: Work" is fine). Alternatives are _Context_ (overloaded with LLM
  context) and _Desk_/_Lane_. Whatever the UI says, the code name should be one
  that doesn't grep-collide.
- **Leak paths to test:** the list cache key, `includePinned` (pinned chats in
  other environments), the board's lineage rollup, `search_chats`, job-triggered
  chats, discovered sessions, and the chat tree fetched on expand.
- **Wire compatibility.** `Chat` changes are optional additions. If an env chip
  ever goes into `shared/types/stream.ts`, it has to be a new optional field,
  never an enum value.
- **Performance.** The filter is a metadata read on records that are already
  cached. Use `listCardMemberChats()`, not `getAllChats()`, for env rollups (see
  the cards-rollup-scan-cost memory).

## Initial sort (first-run UX)

On creating a second environment, offer a one-time "sort existing chats"
sheet. It groups cards by `displayFolder` with chat counts and recent activity,
and assigns whole groups with one click each. Folder choices can optionally be
saved as `folderRules`. Anything left over stays in `default`, renamed to
something like _General_.

## Decisions (2026-10-08)

1. **UI and code name: "Space".** `Space`, `spaceId`, `/api/spaces`, `?space=`. The word "environment" stays reserved for env vars and NODE_ENV.
2. **There is an "All" view** in the switcher (`?space=all`). It shows every space's chats with a space chip on each row.
3. **Agents may search across spaces by choice.** Chat tools default to the caller's space; `space: "all"` (or a specific id) is allowed for any chat.
4. **No hard isolation.** Phase 4 (separate config dirs, credentials, scoped bearer keys) is out of scope. Scope is phases 1–3.
