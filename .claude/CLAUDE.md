# Callboard

## Development

- When installing dependencies on a branch or worktree, use `npm install --include=dev` — without `--include=dev`, devDependencies (TypeScript, Vite, etc.) won't be installed and the build will fail.
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

## Theming System

The frontend uses CSS custom properties (variables) for all colors, shadows, and visual tokens. Every color in the UI must reference a CSS variable — never hardcode hex, rgb, or rgba values in components.

### Architecture

- **Variable definitions:** `frontend/src/index.css` — `:root` (dark mode default) and `[data-theme="light"]` (light overrides)
- **Theme application:** `frontend/src/App.tsx` — `applyTheme()` sets `data-theme` on `<html>`
- **Theme persistence:** `frontend/src/utils/localStorage.ts` — stores `ThemeMode` ("light" | "dark" | "system")
- **Settings UI:** `frontend/src/pages/settings/GeneralSettings.tsx` — theme mode selector
- **Custom themes:** stored as files in `~/.callboard/themes/`, user-named

### CSS Variable Categories

All variables must be defined in both `:root` (dark) and `[data-theme="light"]` blocks:

| Category           | Variables                                                                                                                                                                                                                                    | Purpose                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Core palette       | `--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-hover`, `--user-bg`, `--assistant-bg`, `--code-bg`, `--danger`, `--error`, `--success`, `--warning`, `--bg-secondary`, `--text-secondary`, `--border-light` | Primary UI colors                          |
| Text on colors     | `--text-on-accent`, `--text-on-danger`                                                                                                                                                                                                       | Text readable on accent/danger backgrounds |
| Tint backgrounds   | `--accent-bg`, `--accent-light`, `--danger-bg`, `--danger-border`, `--warning-bg`, `--success-bg`                                                                                                                                            | Light semantic tints for badges, alerts    |
| Overlays & shadows | `--overlay-bg`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`                                                                                                                                                                                  | Modal overlays, elevation                  |
| Diff view          | `--diff-added-bg`, `--diff-added-border`, `--diff-added-text`, `--diff-added-line-bg`, `--diff-removed-bg`, `--diff-removed-border`, `--diff-removed-text`, `--diff-removed-line-bg`, `--diff-hunk-bg`                                       | Git diff coloring                          |
| UI elements        | `--toggle-knob`, `--status-active`, `--status-triggered`                                                                                                                                                                                     | Toggle switches, status dots               |
| Badges             | `--badge-info`, `--badge-info-bg`, `--badge-trigger`, `--badge-worktree`, `--badge-env-text`, `--badge-env-bg`, `--badge-env-border`, `--badge-sse-text`, `--badge-sse-bg`                                                                   | Categorical badge colors                   |
| Built-in commands  | `--builtin-user-bg`, `--builtin-user-border`, `--builtin-assistant-bg`, `--builtin-assistant-border`, `--builtin-text`                                                                                                                       | Slash command message styling              |
| Layout             | `--font-mono`, `--radius`, `--safe-bottom`                                                                                                                                                                                                   | Typography, spacing                        |

### Rules for Component Development

- **Never use hardcoded colors** (`#fff`, `#000`, `rgba(...)`, etc.) in `.tsx` files. Use `var(--variable-name)` instead.
- **Exception:** `TEAM_COLORS` in `MessageBubble.tsx` — 16 decorative identity colors that are intentionally fixed.
- When adding a new color need, add a CSS variable to both `:root` and `[data-theme="light"]` in `index.css` first.
- Use `var(--text-on-accent)` for text on accent-colored backgrounds, not `"#fff"`.
- Use `var(--shadow-md)` etc. for box-shadows, not inline `rgba()` strings.
- Use `var(--overlay-bg)` for modal/overlay backgrounds.
- Diff view styles in `index.css` use `var(--diff-*)` variables — no light-mode override selectors needed since the variables themselves change per theme.
- Every custom theme file must provide values for all variables in both light and dark modes.
