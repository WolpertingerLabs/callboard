# Callboard

User-facing setup, CLI, configuration and scripts are in `README.md`. This file covers what a contributor needs on top of that.

## Development

- When running the development server, always run it in the background using `run_in_background: true` so you can test the functionality while it's running.
- `npm run dev` uses `CALLBOARD_DATA_DIR=$HOME/.callboard-dev` and needs `DEV_PORT_SERVER=3002` in the root `.env` (see README → Development).
- Production runs on port 8000 by default and is managed with `callboard start|stop|restart|status|logs|config`.

## Linting and tests

- `npm run lint` / `lint:fix` lint only **staged** files (used in workflows). `npm run lint:all` / `lint:all:fix` lint the whole project.
- Run vitest from the repo root. Backend tests import `shared` from `shared/dist`, so run `npm run build:shared` after editing `shared/types`.

## Wire compatibility

`shared/types/stream.ts` is a published interface, not an internal type — a browser tab can be running a bundle older than the daemon it is talking to. The authoritative rules and their reasoning are the doc-comment block at the top of that file. The short version:

- Fields are added, never removed, never renamed.
- Optional never becomes required.
- New `type`/enum values are gated behind a capability — `session.supports(CLIENT_CAPS.someCapability)`, from `shared/types/protocol.ts`.
- The semantics of an existing field never change. New meaning → new field.

The asymmetry that keeps this cheap: **adding an optional field needs no gate** (old clients ignore keys they don't know), but **adding an enum value does** (an old client hits its `switch` default and drops the event entirely). Reach for a new optional field first.

Enforced by `shared/types/stream.test.ts` against the committed `wire-surface.snapshot.json`. A failure there means the wire surface changed; read the rules before regenerating the snapshot.

## Workspace keying — `cwd` vs `workspaceId`

A **workspace** (`shared/types/workspace.ts`, `~/.callboard/workspaces/`) is where work happens: a `cwd`, its git isolation, and its lifecycle. Several workspaces may share one `cwd`; that is supported, not a bug. Everything cached, stored or keyed belongs on exactly one side of this line:

- Anything the **directory** determines keys on `cwd` — git status, diff, file contents, branch list, worktree resolution, file-explorer listings. Two workspaces on one checkout seeing the same git state is _correct_.
- Anything the **workspace** owns keys on `workspaceId` — drafts, view state, composer attachments, per-context UI, diff-mode overrides, expand/collapse state.

**Do not collapse the two.** Re-keying a directory-backed query by workspace makes two views of one git tree disagree; re-keying owned state by path leaks it between workspaces on the same folder.

Two corollaries:

- `workspaceId` is **opaque**. Never parse it back into a path, and never assume a chat has one: workspace records are only written when a chat starts in a worktree, so most chats are path-only. Prefer the workspace when present and fall back to `folder`/`displayFolder` when absent.
- **Listings of directories key on the directory.** `viewForDirectory` in `backend/src/services/workspace-views.ts` resolves one `cwd` to one view, with the workspace record supplying identity only when exactly one record claims it. Grouping a directory listing by `Chat.workspaceId` would split a folder's chats across identically named rows for every chat that predates its workspace record.

## Theming

Every colour, shadow and visual token in the UI is a CSS custom property.

- **Definitions:** `frontend/src/index.css` — `:root` (dark, the default) and `[data-theme="light"]`, in commented sections. That file is the authoritative list of variables.
- **Application:** `applyTheme()` in `frontend/src/App.tsx` sets `data-theme` on `<html>`; the mode (`"light" | "dark" | "system"`) is stored via `frontend/src/utils/localStorage.ts` and chosen in `frontend/src/pages/settings/GeneralSettings.tsx`.
- **Custom themes:** files in `~/.callboard/themes/`. A theme may define any subset of the literal-valued variables (`THEME_VARIABLE_NAMES` in `backend/src/services/theme-variables.ts`); anything it omits inherits from `index.css`, and derived (`var()`/`color-mix()`) variables are filtered out. Every write goes through `backend/src/services/theme-write.ts`, which checks WCAG AA contrast (only the HTTP API can opt out).

Rules for components:

- **Never hardcode colours** (`#fff`, `rgba(...)`, etc.) in `.tsx` files. Use `var(--name)`. The one exception is `TEAM_COLORS` in `MessageBubble.tsx`, 16 fixed identity colours.
- Use `var(--text-on-accent)` for text on accent backgrounds, `var(--shadow-*)` for box-shadows and `var(--overlay-bg)` for overlays.
- To add a colour, define the variable in both `:root` and `[data-theme="light"]`, then mirror it in `BUILTIN_PALETTE` (`backend/src/services/theme-contrast-palette.ts`) and, if its value is a literal, `THEME_VARIABLE_NAMES`. `backend/src/services/theme-contrast.stylesheet.test.ts` fails until they match — it is a backend test, so a frontend-only run won't catch it.
- Diff styles use `var(--diff-*)`, which already change per theme; no light-mode override selectors are needed.
