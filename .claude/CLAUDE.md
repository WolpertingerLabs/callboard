# Callboard

## Development

- When running the development server, always run it in the background using `run_in_background: true` so you can test the functionality while it's running

## Production Deployment

- Production runs on port 8000 by default
- `callboard start` - start as background daemon
- `callboard stop` - stop the background server
- `callboard restart` - restart the background server
- `callboard status` - check server health, PID, port, uptime
- `callboard logs` - view and follow server logs
- `callboard config` - show effective configuration

## Linting

- `npm run lint` - lint only staged files (used in workflows)
- `npm run lint:fix` - lint and fix only staged files
- `npm run lint:all` - lint all files in the project
- `npm run lint:all:fix` - lint and fix all files in the project

## Wire compatibility

`shared/types/stream.ts` is a published interface, not an internal type — a browser tab can be running a bundle older than the daemon it is talking to. The authoritative rules and their reasoning are the doc-comment block at the top of that file. The short version:

- Fields are added, never removed, never renamed.
- Optional never becomes required.
- New `type`/enum values are gated behind a capability — `session.supports(CLIENT_CAPS.someCapability)`, from `shared/types/protocol.ts`.
- The semantics of an existing field never change. New meaning → new field.

The asymmetry that keeps this cheap: **adding an optional field needs no gate** (old clients ignore keys they don't know), but **adding an enum value does** (an old client hits its `switch` default and drops the event entirely). Most changes are the former — reach for a new optional field first.

Enforced by `shared/types/stream.test.ts` against the committed `wire-surface.snapshot.json`. A failure there means the wire surface changed; read the rules before regenerating the snapshot.

## Workspace keying — `cwd` vs `workspaceId`

A **workspace** (`shared/types/workspace.ts`, `~/.callboard/workspaces/`) is where work happens: a `cwd`, its git isolation, and its lifecycle. Several workspaces may share one `cwd`, and that is a supported state, not a bug. Everything cached, stored or keyed in this codebase belongs on exactly one side of a line, and which side is mechanical:

- Anything the **directory** determines keys on `cwd` — git status, diff, file contents, branch list, worktree resolution, file-explorer listings. Two workspaces on one checkout seeing the same git state is *correct*.
- Anything the **workspace** owns keys on `workspaceId` — drafts, view state, composer attachments, per-context UI, diff-mode overrides, expand/collapse state.

**Do not collapse the two.** Re-keying a directory-backed query by workspace makes two views of one git tree disagree; re-keying owned state by path leaks it between workspaces on the same folder. The key *is* the boundary — there is no third rule to remember.

Two corollaries that already bite:

- `workspaceId` is **opaque**. Never parse it back into a path, and never assume a chat has one: workspace records are only written when a chat starts in a worktree, so the overwhelming majority of chats are path-only. Reads prefer the workspace when present and fall back to `folder`/`displayFolder` when absent.
- **Listings of directories key on the directory.** The sidebar's `FolderSummary` is one row per `cwd` with the workspace record supplying identity, not one row per record — see `backend/src/services/workspace-views.ts`. Grouping a directory listing by `Chat.workspaceId` splits a folder's chats across identically-named rows for as long as any chat predates the entity, which is approximately all of them.

Callboard has less workspace-owned client state than this rule anticipates. Adopting it *before* accumulating that state is the entire point.

## Theming System

The frontend uses CSS custom properties (variables) for all colors, shadows, and visual tokens. Every color in the UI must reference a CSS variable — never hardcode hex, rgb, or rgba values in components.

### Architecture

- **Variable definitions:** `frontend/src/index.css` — `:root` (dark mode default) and `[data-theme="light"]` (light overrides)
- **Theme application:** `frontend/src/App.tsx` — `applyTheme()` sets `data-theme` on `<html>`
- **Theme persistence:** `frontend/src/utils/localStorage.ts` — stores `ThemeMode` ("light" | "dark" | "system")
- **Settings UI:** `frontend/src/pages/settings/GeneralSettings.tsx` — theme mode selector
- **Custom themes:** stored as files in `~/.callboard/themes/`, user-named

### CSS Variable Categories

The authoritative list of all CSS variables is in `frontend/src/index.css` — always reference that file for the current variable names and values. Variables are organized into commented sections in both `:root` (dark) and `[data-theme="light"]` blocks:

- **Core palette** — primary UI colors (`--bg`, `--surface`, `--text`, `--accent`, etc.)
- **Text on colors** — text readable on accent/danger backgrounds
- **Semantic tint backgrounds** — light tints for badges, alerts
- **Overlays & shadows** — modal overlays, elevation
- **Diff view** — git diff coloring (`--diff-*`)
- **UI elements** — toggle switches, status dots
- **Badges** — categorical badge colors (`--badge-*`)
- **Built-in commands** — slash command message styling (`--builtin-*`)
- **Chat list** — sidebar chat list styling (`--chatlist-*`)
- **Layout** — typography, spacing

### Rules for Component Development

- **Never use hardcoded colors** (`#fff`, `#000`, `rgba(...)`, etc.) in `.tsx` files. Use `var(--variable-name)` instead.
- **Exception:** `TEAM_COLORS` in `MessageBubble.tsx` — 16 decorative identity colors that are intentionally fixed.
- When adding a new color need, add a CSS variable to both `:root` and `[data-theme="light"]` in `index.css` first.
- Use `var(--text-on-accent)` for text on accent-colored backgrounds, not `"#fff"`.
- Use `var(--shadow-md)` etc. for box-shadows, not inline `rgba()` strings.
- Use `var(--overlay-bg)` for modal/overlay backgrounds.
- Diff view styles in `index.css` use `var(--diff-*)` variables — no light-mode override selectors needed since the variables themselves change per theme.
- Every custom theme file must provide values for all variables in both light and dark modes.
