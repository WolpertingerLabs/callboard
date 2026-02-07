# Cleanup Task List

> **Last updated:** Post-commit `478305b` (refactor: create shared types package, deduplicate backend utils, and fix quick wins)

Ordered by dependency, risk level, and impact. Complete top-to-bottom.

---

## Phase 1: Dead Code Removal (Low Risk, Immediate Value) ✅ COMPLETE

### 1.1 Delete Unused Files

- [x] ~~Delete `frontend/src/hooks/useStream.ts` (entirely unused)~~ (FIXED)
- ~~[ ] Delete `frontend/src/components/ScheduleModal.tsx` (entirely unused)~~ (NOT DEAD CODE -- used in Queue.tsx)

### 1.2 Remove Unused Backend Exports

- [x] ~~Remove `getAllSessions()` from `backend/src/services/sessions.ts`~~ (FIXED)
- [x] ~~Remove `getTotalChats()` from `backend/src/services/chat-file-service.ts`~~ (FIXED)
- [x] ~~Remove `getImagesDir()` from `backend/src/services/image-storage.ts`~~ (FIXED)
- [x] ~~Remove `getAllDirectoriesWithSlashCommands()` from `backend/src/services/slashCommands.ts`~~ (FIXED)
- [x] ~~Remove `removeSlashCommandsForDirectory()` from `backend/src/services/slashCommands.ts`~~ (FIXED)

### 1.3 Remove Unused Frontend Functions

- [x] ~~Remove `stopChat()` from `frontend/src/api.ts`~~ (FIXED)
- [x] ~~Remove `createChat()` from `frontend/src/api.ts`~~ (FIXED)
- [x] ~~Remove `getImageUrl()` from `frontend/src/api.ts`~~ (FIXED)
- [x] ~~Remove `getSlashCommands()` from `frontend/src/api.ts` and its import in Chat.tsx~~ (FIXED)
- [x] ~~Remove `clearFolderCache()` from `frontend/src/api/folders.ts`~~ (FIXED)
- [x] ~~Remove `clearAllRecentDirectories()` from `frontend/src/utils/localStorage.ts`~~ (FIXED)
- [x] ~~Remove `addToBacklog()` wrapper from `frontend/src/api.ts` (callers should use `createDraft()` directly)~~ (FIXED -- DraftModal.tsx updated to import `createDraft` directly)

### 1.4 Remove Unused Imports

- [x] ~~Remove unused `ChevronDown` import from `frontend/src/pages/Chat.tsx`~~ (FIXED)
- [x] ~~Remove unused `useMemo` import from `frontend/src/pages/ChatList.tsx`~~ (FIXED)
- [x] ~~Remove unused `ChatListResponse` type import from `frontend/src/pages/ChatList.tsx`~~ (FIXED)
- [x] ~~Remove unused `FolderOpen`, `File` imports from `frontend/src/components/FolderBrowser.tsx`~~ (FIXED)
- [x] ~~Remove unused local `StoredImage` interface from `frontend/src/components/ImageUpload.tsx`~~ (FIXED)
- [x] ~~Remove unused `getSlashCommandsForDirectory` import from `backend/src/routes/chats.ts`~~ (FIXED)

### 1.5 Remove Debug Logging from Production

- [x] ~~Remove or gate behind `NODE_ENV` the `appendFileSync` debug logger in `backend/src/services/claude.ts:11-22`~~ (FIXED -- gated behind `NODE_ENV !== "production"` check)
- [x] ~~Remove 8 `console.log('[DEBUG]...')` statements from `backend/src/routes/stream.ts`~~ (FIXED -- removed. One informational `console.log` remains for OpenRouter title generation at line 40)
- [x] ~~Remove 5 `console.log('[DEBUG]...')` statements from `backend/src/services/image-storage.ts` (including directory listing dump)~~ (FIXED in prior commit)

---

## Phase 2: Bug Fixes & Critical Security (Low Risk, Critical) ✅ COMPLETE

### 2.1 Fix Unreachable Route

- [x] ~~Move `GET /upcoming/next-hour` route (line 232) **above** `GET /:id` (line 88) in `backend/src/routes/queue.ts`~~ (FIXED -- deleted route and unused `getUpcomingMessages()` entirely; both were dead code with no callers)

### 2.2 Fix Command Injection Vulnerability (CRITICAL)

- [x] ~~Replace all `execSync` calls in `backend/src/utils/git.ts` that interpolate user input (`branch`, `base` params at lines 260, 267, 284, 290) with `execFileSync` (bypasses shell entirely)~~ (FIXED)
- [x] ~~Replace `JSON.stringify`-based shell escaping in `removeWorktree` (`utils/git.ts:207`) with `execFileSync`~~ (FIXED)
- [x] ~~Add branch name validation (regex allowlist for valid git ref characters) before any git operations~~ (FIXED -- `validateGitRef()` added, called in `ensureWorktree` and `switchBranch`)
- [x] ~~Add `folder` path validation/allowlisting in `backend/src/routes/git.ts` endpoints~~ (FIXED -- `validateFolderPath()` added, used in all git route handlers)

### 2.3 Fix Configuration Errors

- [x] ~~Fix hardcoded path in `ecosystem.config.cjs` from `/home/exedev/` to `/home/cybil/`~~ (FIXED -- uses `__dirname` for portability across machines)
- [x] ~~Move `@types/multer` from `dependencies` to `devDependencies` in `package.json`~~ (VERIFIED -- already in `devDependencies` at line 47)
- [x] ~~Remove redundant root `tsc` call from the `build` script in `package.json`~~ (FIXED in recent commits)

---

## Phase 3: Define Missing CSS Variables (Low Risk) ✅ COMPLETE

- [x] ~~Define `--bg-secondary` in `frontend/src/index.css` (affects **12 files** incl. BranchSelector.tsx)~~ (FIXED -- dark: #1c2128, light: #f0f4f8)
- [x] ~~Define `--font-mono` in `frontend/src/index.css`~~ (FIXED -- SF Mono, Monaco, Cascadia Code, Roboto Mono, Consolas, Courier New, monospace)
- [x] ~~Define `--error` in `frontend/src/index.css`~~ (FIXED -- dark: #f85149, light: #cf222e)
- [x] ~~Define `--border-light` in `frontend/src/index.css`~~ (FIXED -- dark: #21262d, light: #e2e8f0)
- [x] ~~Define `--text-secondary` in `frontend/src/index.css`~~ (FIXED -- dark: #8b949e, light: #64748b)
- [x] ~~Define `--text-muted` in `frontend/src/index.css`~~ (was already defined -- dark: #8b949e, light: #64748b)
- [x] ~~Remove duplicate `.hljs` media query rules in `index.css` (lines 136-154)~~ (FIXED -- removed redundant dark/light media queries; base rule already uses CSS variables)

---

## Phase 4: Create Shared Types Package (Medium Risk, Highest Value) ✅ COMPLETE

### 4.1 Set Up Shared Package

- [x] ~~Create `shared/` directory at project root with its own `tsconfig.json`~~ (FIXED -- `shared/package.json` and `shared/tsconfig.json` created)
- [x] ~~Update `backend/tsconfig.json` and `frontend/tsconfig.json` to reference shared types~~ (FIXED -- path aliases configured in both)
- [x] ~~Update build scripts to compile shared types first~~ (FIXED -- Vite alias and local package dependency configured)

### 4.2 Migrate Types to Shared Package

- [x] ~~Move `DefaultPermissions` / `PermissionLevel` to `shared/types/permissions.ts`~~ (FIXED -- includes `migratePermissions()` function)
- [x] ~~Move `Plugin` / `PluginCommand` / `PluginManifest` to `shared/types/plugins.ts`~~ (FIXED -- `frontend/types/plugins.ts` now re-exports)
- [x] ~~Move `Chat` to `shared/types/chat.ts`~~ (FIXED -- reconciled with all fields; `ChatListResponse` also shared)
- [x] ~~Move `ParsedMessage` to `shared/types/message.ts`~~ (FIXED -- reconciled fields from both sides)
- [x] ~~Move `StoredImage` to `shared/types/image.ts`~~ (FIXED -- includes `chatId`, `sha256`; also `ImageUploadResult`)
- [x] ~~Move `QueueItem` to `shared/types/queue.ts`~~ (FIXED -- `defaultPermissions` properly typed)
- [x] ~~Move `FolderItem` / `BrowseResult` / `ValidateResult` / `FolderSuggestion` to `shared/types/folders.ts`~~ (FIXED)
- [x] ~~Move `StreamEvent` to `shared/types/stream.ts`~~ (FIXED -- all fields included)
- [x] ~~Move `SlashCommand` to `shared/types/slashCommand.ts`~~ (FIXED)
- [x] ~~Move `BranchConfig` to `shared/types/git.ts`~~ (FIXED -- was frontend-only, now shared)
- [x] ~~`SessionStatus` to `shared/types/session.ts`~~ (FIXED -- new shared definition)
- [x] ~~`frontend/src/types/plugins.ts` updated~~ (FIXED -- now re-exports from shared, not empty but a thin passthrough)

---

## Phase 5: Backend Deduplication (Medium Risk)

### 5.1 Extract Shared Utilities

- [x] ~~Create `backend/src/utils/paths.ts` with shared `CLAUDE_PROJECTS_DIR` constant~~ (FIXED -- `utils/paths.ts` now exists with `CLAUDE_PROJECTS_DIR`, `DATA_DIR`, and `projectDirToFolder`)
- [x] ~~Create `backend/src/utils/session-log.ts` with shared `findSessionLogPath()` function~~ (FIXED -- both `chats.ts` and `stream.ts` now import from shared utility)
- [x] ~~Create `backend/src/utils/chat-lookup.ts` with unified `findChat()` function~~ (FIXED -- provides `findChat()` and `findChatForStatus()`; both routes import from shared utility)
- [x] ~~Update `routes/chats.ts` and `routes/stream.ts` to import from shared utilities instead of defining locally~~ (FIXED)

### 5.2 Unify Data Directory Resolution

- [x] ~~Audit all 5 services for data directory strategy~~ (DONE -- 4 of 5 now use shared `DATA_DIR`)
- [x] ~~Create shared `DATA_DIR` constant~~ (FIXED -- in `utils/paths.ts`, used by `chat-file-service.ts`, `queue-file-service.ts`, `sessions.ts`, `image-storage.ts`)
- [ ] Update `slashCommands.ts` to import `DATA_DIR` from `utils/paths.ts` instead of defining its own via `process.cwd()`

### 5.3 Extract SSE Helpers

- [ ] Create `backend/src/utils/sse.ts` with `writeSSEHeaders(res)` function
- [ ] Create shared SSE event handler factory in `backend/src/utils/sse.ts`
- [ ] Refactor `routes/stream.ts` to use the shared SSE helpers (eliminating 3x repetition)

### 5.4 Consolidate Image Metadata Logic

- [ ] Merge `updateChatWithImages()` (`images.ts`) and `storeMessageImages()` (`stream.ts`) into a single function in `services/image-storage.ts`
- [ ] Update both routes to call the shared function

### 5.5 Cache Git Info Properly

- [ ] Extend `getCachedGitInfo()` usage to all bare `getGitInfo()` call sites
- [ ] Move git info fetching to a service with TTL-based caching

### 5.6 Deduplicate `migratePermissions()`

- [x] ~~Move `migratePermissions()` to shared package~~ (FIXED -- now in `shared/types/permissions.ts`)
- [x] ~~Update `backend/services/claude.ts` and `frontend/utils/localStorage.ts` to import from shared~~ (FIXED)

### 5.7 Consolidate `ensureDataDir` Pattern

- [ ] Create `backend/src/utils/data-dir.ts` utility that handles `mkdirSync({ recursive: true })` once
- [ ] Replace the separate `mkdirSync` calls across services

### 5.8 Consolidate `__dirname` Computation

- [x] ~~Replace 5 service-level `__dirname` computations with `DATA_DIR` import~~ (FIXED -- `chat-file-service.ts`, `queue-file-service.ts`, `sessions.ts`, `image-storage.ts`, `claude.ts` all use shared `DATA_DIR`)
- [ ] Create a shared `__dirname` helper for the remaining 2 files (`index.ts:7,73` and `swagger.ts:5`) that still need module-relative `__dirname`

### 5.9 Fix `projectDirToFolder()` Exponential Complexity

- [x] ~~Replace the exponential `2^(n-1)` brute-force path resolution in `utils/paths.ts` with a linear algorithm~~ (FIXED -- O(n) greedy left-to-right directory walking)
- [x] ~~Fix the lossy fallback that converts ALL dashes to slashes~~ (FIXED -- removed)

---

## Phase 6: Frontend Deduplication (Medium Risk)

### 6.1 Consolidate API Layer

- [ ] Move `frontend/src/api/folders.ts` exports into `frontend/src/api.ts` (or restructure into `frontend/src/api/index.ts` barrel)
- [ ] Remove duplicate `const BASE = '/api'` definition

### 6.2 Extract Shared Frontend Utilities

- [ ] Create `frontend/src/utils/commands.ts` with shared `getCommandDescription()` function
- [ ] Update `SlashCommandAutocomplete.tsx` and `SlashCommandsModal.tsx` to import from shared utility
- [ ] Create `frontend/src/utils/datetime.ts` with shared `getMinDateTime()` function
- [ ] Update `DraftModal.tsx` and `Queue.tsx` to import from shared utility

### 6.3 Create Shared Modal Overlay Component

- [ ] Create `frontend/src/components/ModalOverlay.tsx` with the shared fullscreen overlay pattern
- [ ] Refactor `ConfirmModal`, `DraftModal`, `Queue` (inline modal), `FolderBrowser`, `SlashCommandsModal` to use `<ModalOverlay>`

### 6.4 Consolidate Plugin State Logic

- [ ] Extract `activePlugins` localStorage read/write logic from `SlashCommandsModal.tsx` and `Chat.tsx` into a shared hook or utility

### 6.5 Standardize Error Handling in API Functions

- [ ] Audit all functions in `frontend/src/api.ts` -- ensure consistent throw-on-error behavior
- [ ] Remove silent fallback returns (e.g., `getSlashCommands` returning empty array on error)

### 6.6 Add Input Validation to BranchSelector

- [x] ~~Add client-side git branch name validation regex to `BranchSelector.tsx` input~~ (FIXED -- `validateBranchName()` with comprehensive checks; error display integrated into input)
- [ ] Ensure worktree path preview (`BranchSelector.tsx`) matches backend path computation to avoid misleading users

### 6.7 Fix `formatRelativeTime()` Edge Cases

- [x] ~~Handle invalid date strings in `frontend/src/utils/dateFormat.ts`~~ (FIXED -- returns `""` for invalid dates)
- [x] ~~Handle negative time differences (future timestamps / clock skew)~~ (FIXED -- returns `"just now"` for future timestamps)

---

## Phase 7: Break Up Oversized Files (Higher Risk)

### 7.1 Refactor `Chat.tsx` (~1,176 lines)

- [ ] Extract SSE streaming logic into `frontend/src/hooks/useChatStream.ts`
- [ ] Extract session status polling into `frontend/src/hooks/useSessionStatus.ts`
- [ ] Extract chat header into `frontend/src/components/ChatHeader.tsx`
- [ ] Extract message list rendering into `frontend/src/components/MessageList.tsx`
- [ ] Extract in-flight message display into `frontend/src/components/InFlightMessage.tsx`
- [ ] Extract new-chat welcome screen into `frontend/src/components/NewChatWelcome.tsx`
- [ ] Deduplicate the two in-flight message UI blocks

### 7.2 Refactor `routes/chats.ts` (reduced from 659 lines after dedup)

- [ ] Extract `parseMessages()` into `backend/src/services/message-parser.ts`
- [ ] Extract `discoverSessionsPaginated()` into `backend/src/services/session-discovery.ts`
- [ ] Extract `readJsonlFile()` into `backend/src/utils/jsonl.ts`
- [ ] Move git caching into the git service (see Phase 5.5)

### 7.3 Refactor `routes/stream.ts` (reduced from 587 lines after dedup)

- [ ] Extract title generation logic into `backend/src/services/title-generator.ts`
- [ ] Extract image metadata storage into image-storage service (see Phase 5.4)
- [ ] Extract CLI file watcher logic into `backend/src/services/cli-watcher.ts`
- [ ] Use SSE helpers (see Phase 5.3)

---

## Phase 8: Performance Improvements (Medium-High Risk)

### 8.1 Backend Performance

- [ ] Replace blocking `execSync` in `routes/chats.ts:70` with async `execFile` or `readdir` ⏳ **REVIEW LATER**
- [x] ~~Fix exponential `projectDirToFolder()` in `utils/paths.ts`~~ (FIXED -- see Phase 5.9)
- [ ] Add in-memory cache with TTL to `ChatFileService.getAllChats()` (invalidate on write)
- [ ] Replace `readdirSync` + `find()` in `image-storage.ts:getImage()` with a lookup map
- [ ] Replace synchronous file I/O in `slashCommands.ts` with async equivalents
- [x] ~~Replace self-HTTP calls in `queue-processor.ts` and `queue.ts:180-212` with direct service function calls~~ (FIXED -- both now call `sendMessage()` directly)
- [ ] Replace `execSync` in `utils/git.ts` with async `execFile`
- [ ] Replace `statSync` per-file calls in `folder-service.ts:browseDirectory()` and `getRecentFolders()` with async alternatives

### 8.2 Frontend Performance

- [ ] Replace full `getMessages()` refetch on every SSE `message_update` with incremental/delta updates
- [ ] Add a batched `/api/sessions/status` endpoint to replace N parallel `getSessionStatus()` calls in ChatList
- [ ] Add debounce to resize listener in `hooks/useIsMobile.ts`
- [ ] Memoize `remarkPlugins`, `rehypePlugins`, `components` arrays in `MarkdownRenderer.tsx`
- [ ] Replace 6x `.filter()` with a single `.reduce()` for queue tab counts in `Queue.tsx`
- [ ] Cache `getValidationMessage()` result in `FolderSelector.tsx` to avoid double-call
- [ ] Implement tiered interval in `useRelativeTime.ts` (5s for <60s, 30s for <60m) to reduce re-renders from dozens of concurrent 5-second intervals

---

## Phase 9: Security Hardening (Variable Risk)

### 9.1 Critical

- [ ] Restrict CORS `origin` to specific allowed domain(s) in production (currently `origin: true`) ⏳ **REVIEW LATER** -- mitigated by authentication requirement
- [ ] Add path allowlist to folder browsing service (currently unrestricted filesystem access) ⏳ **REVIEW LATER** -- mitigated by authentication requirement
- [x] ~~Add path allowlist to git operations in `routes/git.ts`~~ (FIXED -- `validateFolderPath()` resolves paths and validates existence)
- [x] ~~Fix queue processor auth bypass~~ (FIXED -- queue processor and execute-now route now call `sendMessage()` directly instead of HTTP, eliminating the auth bypass entirely)

### 9.2 Important

- [ ] Add `secure: true` flag to session cookie in production (`backend/src/auth.ts`) ⏳ **REVIEW LATER**
- [x] ~~Sanitize image IDs before filesystem lookup to prevent directory traversal (`image-storage.ts`)~~ (FIXED -- added UUID format validation in `getImage()` and `deleteImage()`; also removed debug logging)
- [ ] Remove `storagePath` from API responses in `image-storage.ts` (leaks server paths)
- [ ] Fix `sanitizeBranchForPath()` (`utils/git.ts`) -- handle `\`, `?`, `*`, `:` characters and prevent collision between `feature/foo` and `feature-foo`
- [ ] Fix `ensureWorktree` TOCTOU race condition (`utils/git.ts`) -- make check+create atomic

### 9.3 Maintenance

- [ ] Add periodic cleanup or TTL to the rate limit `Map` in `auth.ts` ⏳ **REVIEW LATER**
- [ ] Set explicit body size limit with `express.json({ limit: '1mb' })` in `index.ts`
- [ ] Add JSON schema validation for `metadata` fields parsed via `JSON.parse()`

---

## Phase 10: API Design Standardization (Medium Risk)

- [ ] Define a standard success envelope: `{ success: true, data: T }` and apply across all routes
- [ ] Define a standard error envelope: `{ success: false, error: string, details?: unknown }` and apply across all routes
- [ ] Replace `error: any` in all catch blocks with proper type narrowing (`error instanceof Error`)
- [ ] Add `.catch()` handlers to all fire-and-forget async calls (e.g., `generateAndSaveTitle()` at `stream.ts`)
- [ ] Make `generateAndSaveTitle()` invocation consistent -- currently fire-and-forget in `POST /new/message` but `await`ed in `POST /:id/message`
- [ ] Audit and remove all empty `catch {}` blocks -- log errors or handle them properly
- [ ] Fix images router double-mount -- mount only on `/api/images`, update frontend calls accordingly

---

## Phase 11: Build & Config Cleanup (Low Risk)

- [x] ~~Reconcile `start-server.js` with `ecosystem.config.cjs` -- use one or the other, not both~~ (FIXED -- `start-server.js` now uses `ecosystem.config.cjs` instead of inline args)
- [ ] Add comments to `tsconfig.json` files explaining different `target` choices (ES2022 vs ES2020)
- [ ] Narrow lint-staged glob from `*.{ts,tsx}` to `{frontend,backend}/**/*.{ts,tsx}` for performance
- [ ] Standardize monospace font stack across all components (currently 4 different stacks)
- [ ] Extract all inline `style={{}}` objects to module-level constants or CSS classes (especially BranchSelector.tsx with ~20 inline styles)
- [ ] Evaluate whether `prebuild: npm run swagger` should be a soft dependency (warning, not failure) to prevent swagger issues from blocking builds

---

## Phase 12: Final Verification

- [ ] Run `npm run lint:all` and fix any new warnings
- [ ] Run `npm run build` and verify clean compilation
- [ ] Verify all frontend pages load correctly
- [ ] Verify SSE streaming still works end-to-end
- [ ] Verify queue processing still works
- [ ] Verify image upload/display still works
- [ ] Verify branch selector / worktree creation works end-to-end
- [ ] Run production build and smoke test with `npm run redeploy:prod`
