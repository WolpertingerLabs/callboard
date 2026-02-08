# Plan: Git Diff View Toggle in Chat Header

## Overview
Add a toggle button in the chat header to switch between "Chat" view and "Git Diff" view. The diff view shows the current working directory's git diff with expandable/collapsible file sections and inline red/green line coloring.

## Architecture

### Backend: New API Endpoint
**File: `backend/src/routes/git.ts`** — Add a `GET /api/git/diff` endpoint

- Accepts `folder` query param (same pattern as existing `/branches` and `/worktrees` endpoints)
- Runs `git diff` in the folder directory using `execSync` (same pattern as other git utils)
- Also includes staged changes via `git diff --cached` to show the full picture
- Returns raw diff text as JSON: `{ diff: string }`
- Uses existing `validateFolderPath()` for safety

**File: `backend/src/utils/git.ts`** — Add `getGitDiff()` utility function
- Runs `git diff` + `git diff --cached` and concatenates output
- Returns the raw unified diff string
- Uses same `execSync` pattern with 10s timeout

### Frontend: New API Function
**File: `frontend/src/api.ts`** — Add `getGitDiff(folder: string)` function
- Calls `GET /api/git/diff?folder=...`
- Returns `{ diff: string }`

### Frontend: New `GitDiffView` Component
**File: `frontend/src/components/GitDiffView.tsx`** — New component

**Diff parsing** (built-in, no library needed):
- Parse unified diff format into structured data: files → hunks → lines
- Each file gets: filename, hunks array
- Each hunk gets: header string, lines array
- Each line gets: type (added/removed/context), content, old line number, new line number

**Rendering**:
- Each file as a clickable header bar (filename + stats) — expandable/collapsible, all expanded by default
- Inline diff display (NOT side-by-side):
  - Added lines: green background (`rgba(46, 160, 67, 0.15)`) with green left border
  - Removed lines: red background (`rgba(248, 81, 73, 0.15)`) with red left border
  - Context lines: no special coloring
  - Line numbers in gutter (monospace)
  - Hunk headers (`@@ ... @@`) styled as separators
- If diff is empty: show centered message "No changes detected" with a muted icon
- Refresh button to re-fetch the diff
- Uses inline styles consistent with existing codebase patterns
- Uses CSS variables from `index.css` (e.g., `var(--bg)`, `var(--border)`, `var(--text-muted)`)

### Frontend: Chat Header Toggle
**File: `frontend/src/pages/Chat.tsx`** — Modify the header

- Add state: `const [viewMode, setViewMode] = useState<'chat' | 'diff'>('chat')`
- Add a segmented toggle in the header (between the folder/branch info and the action buttons):
  - Two options: "Chat" and "Diff"
  - Uses `GitBranch` icon from lucide-react for the Diff button
  - Uses `MessageSquare` icon for the Chat button
  - Active state uses `var(--accent)` background, inactive uses `var(--bg-secondary)`
- Toggle only visible when folder is a git repo (`info?.is_git_repo` or `chat?.is_git_repo`)
- When "Diff" is selected, the main content area renders `<GitDiffView>` instead of the chat messages
- The footer (PromptInput/FeedbackPanel) remains visible in both views so user can still send messages

### Flow
1. User clicks "Diff" toggle → `viewMode` changes to `'diff'`
2. `GitDiffView` mounts → calls `getGitDiff(folder)` → parses and renders
3. User can expand/collapse individual files
4. User can click "Chat" toggle to return to normal chat view
5. Refresh button in diff view re-fetches latest diff

## Files to Change (in order)
1. `backend/src/utils/git.ts` — Add `getGitDiff()` utility
2. `backend/src/routes/git.ts` — Add `GET /diff` route
3. `frontend/src/api.ts` — Add `getGitDiff()` API function
4. `frontend/src/components/GitDiffView.tsx` — New component (diff parsing + rendering)
5. `frontend/src/pages/Chat.tsx` — Add toggle state, toggle UI in header, conditional rendering
6. `frontend/src/index.css` — Add diff-specific CSS classes for line coloring (supports both dark & light mode)
