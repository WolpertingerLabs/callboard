# Cleanup Task List

> **Last updated:** Post-commit `e1787b8` (feat: add OpenAPI spec auto-generation)

Ordered by dependency, risk level, and impact. Complete top-to-bottom.

---

## Phase 1: Dead Code Removal (Low Risk, Immediate Value)

### 1.1 Delete Unused Files

- [ ] Delete `frontend/src/hooks/useStream.ts` (entirely unused)
- [ ] Delete `frontend/src/components/ScheduleModal.tsx` (entirely unused)

### 1.2 Remove Unused Backend Exports

- [ ] Remove `getAllSessions()` from `backend/src/services/sessions.ts`
- [ ] Remove `getTotalChats()` from `backend/src/services/chat-file-service.ts`
- [ ] Remove `getImagesDir()` from `backend/src/services/image-storage.ts`
- [ ] Remove `getAllDirectoriesWithSlashCommands()` from `backend/src/services/slashCommands.ts`
- [ ] Remove `removeSlashCommandsForDirectory()` from `backend/src/services/slashCommands.ts`

### 1.3 Remove Unused Frontend Functions

- [ ] Remove `stopChat()` from `frontend/src/api.ts`
- [ ] Remove `createChat()` from `frontend/src/api.ts`
- [ ] Remove `getImageUrl()` from `frontend/src/api.ts`
- [ ] Remove `getSlashCommands()` from `frontend/src/api.ts` and its import in Chat.tsx
- [ ] Remove `clearFolderCache()` from `frontend/src/api/folders.ts`
- [ ] Remove `clearAllRecentDirectories()` from `frontend/src/utils/localStorage.ts`
- [ ] Remove `addToBacklog()` wrapper from `frontend/src/api.ts` (callers should use `createDraft()` directly)

### 1.4 Remove Unused Imports

- [ ] Remove unused `ChevronDown` import from `frontend/src/pages/Chat.tsx`
- [ ] Remove unused `useMemo` import from `frontend/src/pages/ChatList.tsx`
- [ ] Remove unused `ChatListResponse` type import from `frontend/src/pages/ChatList.tsx`
- [ ] Remove unused `FolderOpen`, `File` imports from `frontend/src/components/FolderBrowser.tsx`
- [ ] Remove unused local `StoredImage` interface from `frontend/src/components/ImageUpload.tsx`

### 1.5 Remove Debug Logging from Production

- [ ] Remove or gate behind `NODE_ENV` the `appendFileSync` debug logger in `backend/src/services/claude.ts:11-22`
- [ ] Remove 8 `console.log('[DEBUG]...')` statements from `backend/src/routes/stream.ts` (lines 248, 252, 262, 266, 269, 275, 282, 287)
- [ ] Remove 5 `console.log('[DEBUG]...')` statements from `backend/src/services/image-storage.ts` (including directory listing dump)

---

## Phase 2: Bug Fixes & Critical Security (Low Risk, Critical)

### 2.1 Fix Unreachable Route

- [ ] Move `GET /upcoming/next-hour` route (line 232) **above** `GET /:id` (line 88) in `backend/src/routes/queue.ts`

### 2.2 Fix Command Injection Vulnerability (CRITICAL)

- [x] ~~Replace all `execSync` calls in `backend/src/utils/git.ts` that interpolate user input (`branch`, `base` params at lines 260, 267, 284, 290) with `execFileSync` (bypasses shell entirely)~~ (FIXED)
- [x] ~~Replace `JSON.stringify`-based shell escaping in `removeWorktree` (`utils/git.ts:207`) with `execFileSync`~~ (FIXED)
- [x] ~~Add branch name validation (regex allowlist for valid git ref characters) before any git operations~~ (FIXED -- `validateGitRef()` added, called in `ensureWorktree` and `switchBranch`)
- [x] ~~Add `folder` path validation/allowlisting in `backend/src/routes/git.ts` endpoints~~ (FIXED -- `validateFolderPath()` added, used in all git route handlers)

### 2.3 Fix Configuration Errors

- [ ] Fix hardcoded path in `ecosystem.config.cjs` from `/home/exedev/` to `/home/cybil/`
- [ ] Move `@types/multer` from `dependencies` to `devDependencies` in `package.json`
- [x] ~~Remove redundant root `tsc` call from the `build` script in `package.json`~~ (FIXED in recent commits)

---

## Phase 3: Define Missing CSS Variables (Low Risk)

- [ ] Define `--bg-secondary` in `frontend/src/index.css` (affects **12 files** incl. BranchSelector.tsx)
- [ ] Define `--font-mono` in `frontend/src/index.css`
- [ ] Define `--error` in `frontend/src/index.css`
- [ ] Define `--border-light` in `frontend/src/index.css`
- [ ] Define `--text-secondary` in `frontend/src/index.css`
- [ ] Define `--text-muted` in `frontend/src/index.css` (NEW -- used in 5 places in BranchSelector.tsx)
- [ ] Remove duplicate `.hljs` media query rules in `index.css` (lines 136-154)

---

## Phase 4: Create Shared Types Package (Medium Risk, Highest Value)

### 4.1 Set Up Shared Package

- [ ] Create `shared/` directory at project root with its own `tsconfig.json`
- [ ] Update `backend/tsconfig.json` and `frontend/tsconfig.json` to reference shared types
- [ ] Update build scripts to compile shared types first

### 4.2 Migrate Types to Shared Package

- [ ] Move `DefaultPermissions` / `PermissionLevel` to `shared/types/permissions.ts` and remove from `backend/services/claude.ts`, `frontend/api.ts`, `frontend/utils/localStorage.ts`
- [ ] Move `Plugin` / `PluginCommand` / `PluginManifest` to `shared/types/plugins.ts` and remove from `backend/services/plugins.ts`, `frontend/api.ts`, `frontend/types/plugins.ts`
- [ ] Move `Chat` to `shared/types/chat.ts` -- reconcile extra frontend fields (`title`, `session_ids`, `session_log_path`) into a single definition; remove from `backend/chat-file-service.ts`, `frontend/api.ts`
- [ ] Move `ParsedMessage` to `shared/types/message.ts` -- reconcile diverged fields (frontend: `toolUseId`, `isBuiltInCommand`, `teamName`; backend: `tool_name`, `tool_input`, `tool_result`, `thinking`); remove from `backend/routes/chats.ts`, `frontend/api.ts`
- [ ] Move `StoredImage` to `shared/types/image.ts` -- add `chatId?`, `sha256?` fields the frontend was missing; remove from `backend/image-storage.ts`, `frontend/api.ts`
- [ ] Move `QueueItem` to `shared/types/queue.ts` -- type `defaultPermissions` properly (not `any`); remove from `backend/queue-file-service.ts`, `frontend/api.ts`
- [ ] Move `FolderItem` / `BrowseResult` / `ValidateResult` / `FolderSuggestion` to `shared/types/folders.ts`; remove from `backend/folder-service.ts`, `frontend/api/folders.ts`
- [ ] Move `StreamEvent` to `shared/types/stream.ts` -- add all fields; remove from `backend/services/claude.ts`, `frontend/hooks/useStream.ts`
- [ ] Move `SlashCommand` to `shared/types/slashCommand.ts`; remove from `backend/services/slashCommands.ts`, `frontend/api.ts`
- [ ] Move `BranchConfig` to `shared/types/git.ts` (NEW -- currently frontend-only at `api.ts:283-287` with no backend definition)
- [ ] Delete `frontend/src/types/plugins.ts` (now empty)

---

## Phase 5: Backend Deduplication (Medium Risk)

### 5.1 Extract Shared Utilities

- [x] ~~Create `backend/src/utils/paths.ts` with shared `CLAUDE_PROJECTS_DIR` constant~~ (FIXED -- `utils/paths.ts` now exists with `CLAUDE_PROJECTS_DIR` and `projectDirToFolder`)
- [ ] Create `backend/src/utils/session-log.ts` with shared `findSessionLogPath()` function (note: `chats.ts:22-29` and `stream.ts:16-25` have diverged -- stream.ts has try/catch, chats.ts does not)
- [ ] Create `backend/src/utils/chat-lookup.ts` with unified `findChat()` function (merging `findChat` at `chats.ts:413-466` and `findChatForStatus` at `stream.ts:30-43`)
- [ ] Update `routes/chats.ts` and `routes/stream.ts` to import from shared utilities instead of defining locally

### 5.2 Unify Data Directory Resolution

- [ ] Audit all 5 services (`chat-file-service.ts`, `queue-file-service.ts`, `sessions.ts`, `image-storage.ts`, `slashCommands.ts`) for data directory strategy
- [ ] Standardize on `__dirname`-based resolution (not `process.cwd()`)
- [ ] Create `backend/src/utils/data-dir.ts` with a single `getDataDir(subpath)` function
- [ ] Update all services to use the shared data directory function

### 5.3 Extract SSE Helpers

- [ ] Create `backend/src/utils/sse.ts` with `writeSSEHeaders(res)` function
- [ ] Create shared SSE event handler factory in `backend/src/utils/sse.ts`
- [ ] Refactor `routes/stream.ts` to use the shared SSE helpers (eliminating 3x repetition at lines 178-212, 300-323, 377-402)

### 5.4 Consolidate Image Metadata Logic

- [ ] Merge `updateChatWithImages()` (`images.ts:205-230`) and `storeMessageImages()` (`stream.ts:338-365`) into a single function in `services/image-storage.ts`
- [ ] Update both routes to call the shared function

### 5.5 Cache Git Info Properly

- [ ] Extend `getCachedGitInfo()` (chats.ts:34-49) usage to all 4 bare `getGitInfo()` call sites (lines 304, 360, 427, 447) -- currently only used at line 223
- [ ] Move git info fetching to a service with TTL-based caching

### 5.6 Deduplicate `migratePermissions()`

- [ ] Move `migratePermissions()` to `shared/utils/permissions.ts`
- [ ] Update `backend/services/claude.ts` and `frontend/utils/localStorage.ts` to import from shared

### 5.7 Consolidate `ensureDataDir` Pattern

- [ ] Create `backend/src/utils/data-dir.ts` utility that handles `mkdirSync({ recursive: true })` once
- [ ] Replace the 4 separate `mkdirSync` calls across services

### 5.8 Consolidate `__dirname` Computation (NEW)

- [ ] Create a shared `__dirname` helper in `backend/src/utils/paths.ts` (e.g., `getDirname(importMetaUrl)`)
- [ ] Replace the 7 independent `dirname(fileURLToPath(import.meta.url))` computations (`index.ts:7,95`, `swagger.ts:5`, `queue-file-service.ts:6`, `image-storage.ts:7`, `chat-file-service.ts:6`, `claude.ts:11`, `sessions.ts:5`)

### 5.9 Fix `projectDirToFolder()` Exponential Complexity (NEW)

- [ ] Replace the exponential `2^(n-1)` brute-force path resolution in `utils/paths.ts:13-36` with a linear algorithm (e.g., walk the filesystem incrementally)
- [ ] Fix the lossy fallback that converts ALL dashes to slashes (line 35)

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

### 6.6 Add Input Validation to BranchSelector (NEW)

- [ ] Add client-side git branch name validation regex to `BranchSelector.tsx:216` input
- [ ] Ensure worktree path preview (`BranchSelector.tsx:72-76`) matches backend path computation to avoid misleading users

### 6.7 Fix `formatRelativeTime()` Edge Cases (NEW)

- [ ] Handle invalid date strings in `frontend/src/utils/dateFormat.ts` (currently returns `'just now'` for invalid input)
- [ ] Handle negative time differences (future timestamps / clock skew)

---

## Phase 7: Break Up Oversized Files (Higher Risk)

### 7.1 Refactor `Chat.tsx` (~1,176 lines)

- [ ] Extract SSE streaming logic into `frontend/src/hooks/useChatStream.ts`
- [ ] Extract session status polling into `frontend/src/hooks/useSessionStatus.ts`
- [ ] Extract chat header into `frontend/src/components/ChatHeader.tsx`
- [ ] Extract message list rendering into `frontend/src/components/MessageList.tsx`
- [ ] Extract in-flight message display into `frontend/src/components/InFlightMessage.tsx`
- [ ] Extract new-chat welcome screen into `frontend/src/components/NewChatWelcome.tsx`
- [ ] Deduplicate the two in-flight message UI blocks (lines 956-986 and 1027-1057)

### 7.2 Refactor `routes/chats.ts` (659 lines)

- [ ] Extract `parseMessages()` into `backend/src/services/message-parser.ts`
- [ ] Extract `discoverSessionsPaginated()` into `backend/src/services/session-discovery.ts`
- [ ] Extract `readJsonlFile()` into `backend/src/utils/jsonl.ts`
- [ ] Move git caching into the git service (see Phase 5.5)

### 7.3 Refactor `routes/stream.ts` (587 lines)

- [ ] Extract title generation logic into `backend/src/services/title-generator.ts`
- [ ] Extract image metadata storage into image-storage service (see Phase 5.4)
- [ ] Extract CLI file watcher logic into `backend/src/services/cli-watcher.ts`
- [ ] Use SSE helpers (see Phase 5.3)

---

## Phase 8: Performance Improvements (Medium-High Risk)

### 8.1 Backend Performance

- [ ] Replace blocking `execSync` in `routes/chats.ts:70` with async `execFile` or `readdir`
- [ ] Fix exponential `projectDirToFolder()` in `utils/paths.ts` (see Phase 5.9)
- [ ] Add in-memory cache with TTL to `ChatFileService.getAllChats()` (invalidate on write)
- [ ] Replace `readdirSync` + `find()` in `image-storage.ts:getImage()` with a lookup map
- [ ] Replace synchronous file I/O in `slashCommands.ts` with async equivalents
- [ ] Replace self-HTTP calls in `queue-processor.ts` and `queue.ts:180-212` with direct service function calls
- [ ] Replace `execSync` in `utils/git.ts` with async `execFile`
- [ ] Replace `statSync` per-file calls in `folder-service.ts:browseDirectory()` and `getRecentFolders()` with async alternatives

### 8.2 Frontend Performance

- [ ] Replace full `getMessages()` refetch on every SSE `message_update` with incremental/delta updates
- [ ] Add a batched `/api/sessions/status` endpoint to replace N parallel `getSessionStatus()` calls in ChatList
- [ ] Add debounce to resize listener in `hooks/useIsMobile.ts`
- [ ] Memoize `remarkPlugins`, `rehypePlugins`, `components` arrays in `MarkdownRenderer.tsx`
- [ ] Replace 6x `.filter()` with a single `.reduce()` for queue tab counts in `Queue.tsx`
- [ ] Cache `getValidationMessage()` result in `FolderSelector.tsx` to avoid double-call
- [ ] Implement tiered interval in `useRelativeTime.ts` (NEW -- 5s for <60s, 30s for <60m) to reduce re-renders from dozens of concurrent 5-second intervals

---

## Phase 9: Security Hardening (Variable Risk)

### 9.1 Critical

- [ ] Restrict CORS `origin` to specific allowed domain(s) in production (currently `origin: true`) ⏳ **REVIEW LATER** -- mitigated by authentication requirement
- [ ] Add path allowlist to folder browsing service (currently unrestricted filesystem access) ⏳ **REVIEW LATER** -- mitigated by authentication requirement
- [x] ~~Add path allowlist to git operations in `routes/git.ts` (NEW -- same unrestricted access problem)~~ (FIXED -- `validateFolderPath()` resolves paths and validates existence)
- [ ] Fix queue processor auth bypass (has existing TODO)

### 9.2 Important

- [ ] Add `secure: true` flag to session cookie in production (`backend/src/auth.ts`)
- [ ] Sanitize image IDs before filesystem lookup to prevent directory traversal (`image-storage.ts`)
- [ ] Remove `storagePath` from API responses in `image-storage.ts` (leaks server paths)
- [ ] Fix `sanitizeBranchForPath()` (`utils/git.ts:229-231`) -- handle `\`, `?`, `*`, `:` characters and prevent collision between `feature/foo` and `feature-foo` (NEW)
- [ ] Fix `ensureWorktree` TOCTOU race condition (`utils/git.ts:252-254`) -- make check+create atomic (NEW)

### 9.3 Maintenance

- [ ] Add periodic cleanup or TTL to the rate limit `Map` in `auth.ts`
- [ ] Set explicit body size limit with `express.json({ limit: '1mb' })` in `index.ts`
- [ ] Add JSON schema validation for `metadata` fields parsed via `JSON.parse()`

---

## Phase 10: API Design Standardization (Medium Risk)

- [ ] Define a standard success envelope: `{ success: true, data: T }` and apply across all routes
- [ ] Define a standard error envelope: `{ success: false, error: string, details?: unknown }` and apply across all routes
- [ ] Replace `error: any` in all catch blocks with proper type narrowing (`error instanceof Error`)
- [ ] Add `.catch()` handlers to all fire-and-forget async calls (e.g., `generateAndSaveTitle()` at `stream.ts:194`)
- [ ] Make `generateAndSaveTitle()` invocation consistent -- currently fire-and-forget in `POST /new/message` (line 194) but `await`ed in `POST /:id/message` (line 298) (NEW)
- [ ] Audit and remove all empty `catch {}` blocks -- log errors or handle them properly
- [ ] Fix images router double-mount -- mount only on `/api/images`, update frontend calls accordingly (now at `index.ts:88-89`)

---

## Phase 11: Build & Config Cleanup (Low Risk)

- [ ] Reconcile `start-server.js` with `ecosystem.config.cjs` -- use one or the other, not both
- [ ] Add comments to `tsconfig.json` files explaining different `target` choices (ES2022 vs ES2020)
- [ ] Narrow lint-staged glob from `*.{ts,tsx}` to `{frontend,backend}/**/*.{ts,tsx}` for performance
- [ ] Standardize monospace font stack across all components (currently 4 different stacks)
- [ ] Extract all inline `style={{}}` objects to module-level constants or CSS classes (especially BranchSelector.tsx with ~20 inline styles)
- [ ] Evaluate whether `prebuild: npm run swagger` should be a soft dependency (warning, not failure) to prevent swagger issues from blocking builds (NEW)

---

## Phase 12: Final Verification

- [ ] Run `npm run lint:all` and fix any new warnings
- [ ] Run `npm run build` and verify clean compilation
- [ ] Verify all frontend pages load correctly
- [ ] Verify SSE streaming still works end-to-end
- [ ] Verify queue processing still works
- [ ] Verify image upload/display still works
- [ ] Verify branch selector / worktree creation works end-to-end (NEW)
- [ ] Run production build and smoke test with `npm run redeploy:prod`
