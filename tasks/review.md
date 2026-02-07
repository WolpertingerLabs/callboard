# Full Architectural Review: Claude Code UI

> **Last updated:** Post-commit `478305b` (refactor: create shared types package, deduplicate backend utils, and fix quick wins)

## Table of Contents

1. [Dead Code](#1-dead-code)
2. [Duplicate Code](#2-duplicate-code)
3. [Inefficient Code](#3-inefficient-code)
4. [Security Concerns](#4-security-concerns)
5. [API Design Issues](#5-api-design-issues)
6. [Architectural Issues](#6-architectural-issues)
7. [Styling Issues](#7-styling-issues)
8. [Type Safety Issues](#8-type-safety-issues)
9. [Configuration Issues](#9-configuration-issues)

---

## 1. Dead Code

### Entire Unused Files

| File                                        | Lines  | Notes                                                                 |
| ------------------------------------------- | ------ | --------------------------------------------------------------------- |
| ~~`frontend/src/hooks/useStream.ts`~~       | ~~87~~ | **FIXED** -- deleted (never imported; Chat.tsx implements SSE inline) |
| `frontend/src/components/ScheduleModal.tsx` | 161    | Not dead code -- used in Queue.tsx                                    |

### Unused Backend Exports

| Function                                   | File                                        | Line | Status               |
| ------------------------------------------ | ------------------------------------------- | ---- | -------------------- |
| ~~`getAllSessions()`~~                     | `backend/src/services/sessions.ts`          | 101  | **FIXED** -- removed |
| ~~`getTotalChats()`~~                      | `backend/src/services/chat-file-service.ts` | 194  | **FIXED** -- removed |
| ~~`getImagesDir()`~~                       | `backend/src/services/image-storage.ts`     | 203  | **FIXED** -- removed |
| ~~`getAllDirectoriesWithSlashCommands()`~~ | `backend/src/services/slashCommands.ts`     | 79   | **FIXED** -- removed |
| ~~`removeSlashCommandsForDirectory()`~~    | `backend/src/services/slashCommands.ts`     | 87   | **FIXED** -- removed |

### Unused Frontend Functions/Imports

| Item                               | File                                        | Status                                                                     |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| ~~`stopChat()`~~                   | `frontend/src/api.ts`                       | **FIXED** -- removed                                                       |
| ~~`createChat()`~~                 | `frontend/src/api.ts`                       | **FIXED** -- removed                                                       |
| ~~`getImageUrl()`~~                | `frontend/src/api.ts`                       | **FIXED** -- removed                                                       |
| ~~`getSlashCommands()`~~           | `frontend/src/api.ts`                       | **FIXED** -- removed (and import in Chat.tsx)                              |
| ~~`clearFolderCache()`~~           | `frontend/src/api/folders.ts`               | **FIXED** -- removed                                                       |
| ~~`clearAllRecentDirectories()`~~  | `frontend/src/utils/localStorage.ts`        | **FIXED** -- removed                                                       |
| ~~`addToBacklog()`~~               | `frontend/src/api.ts`                       | **FIXED** -- removed; DraftModal.tsx updated to use `createDraft` directly |
| ~~`ChevronDown` import~~           | `frontend/src/pages/Chat.tsx`               | **FIXED** -- removed                                                       |
| ~~`useMemo` import~~               | `frontend/src/pages/ChatList.tsx`           | **FIXED** -- removed                                                       |
| ~~`ChatListResponse` type import~~ | `frontend/src/pages/ChatList.tsx`           | **FIXED** -- removed                                                       |
| ~~`FolderOpen`, `File` imports~~   | `frontend/src/components/FolderBrowser.tsx` | **FIXED** -- removed                                                       |
| ~~`StoredImage` interface~~        | `frontend/src/components/ImageUpload.tsx`   | **FIXED** -- removed                                                       |
| ~~`getSlashCommandsForDirectory`~~ | `backend/src/routes/chats.ts`               | **FIXED** -- removed                                                       |

### Unreachable Backend Route

| Route                         | File                          | Issue                                                                                                |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| ~~`GET /upcoming/next-hour`~~ | `backend/src/routes/queue.ts` | **FIXED** -- deleted route and unused `getUpcomingMessages()` service method (dead code, no callers) |

---

## 2. Duplicate Code

### Cross-File Duplications (Backend)

| What                                              | Location A                       | Location B                             | Impact                                                                                                                                           |
| ------------------------------------------------- | -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~`findSessionLogPath()`~~                        | ~~`routes/chats.ts:22-29`~~      | ~~`routes/stream.ts:16-25`~~           | **FIXED** -- extracted to `utils/session-log.ts`; both routes now import from shared utility                                                     |
| ~~`CLAUDE_PROJECTS_DIR` constant~~                | ~~`routes/chats.ts:12`~~         | ~~`routes/stream.ts:12`~~              | **FIXED** -- now shared via `utils/paths.ts`                                                                                                     |
| ~~`findChat()` / `findChatForStatus()`~~          | ~~`routes/chats.ts:413-466`~~    | ~~`routes/stream.ts:30-43`~~           | **FIXED** -- extracted to `utils/chat-lookup.ts`; both routes now import from shared utility                                                     |
| SSE event handler pattern                         | `routes/stream.ts:186-212`       | `routes/stream.ts:306-323` & `385-402` | Same handler logic repeated **3 times**                                                                                                          |
| SSE header block                                  | `routes/stream.ts:178-182`       | `routes/stream.ts:300-304` & `377-381` | Same 5-line writeHead block **3 times**                                                                                                          |
| Image loading loop                                | `routes/stream.ts:152-167`       | `routes/stream.ts:260-288`             | Same iteration over imageIds                                                                                                                     |
| `updateChatWithImages()` / `storeMessageImages()` | `routes/images.ts:205-230`       | `routes/stream.ts:338-365`             | Near-identical metadata storage                                                                                                                  |
| Git info fetch pattern                            | `routes/chats.ts`                | Lines 304, 360, 427, 447               | Same bare try/catch `getGitInfo()` block **4 times** (cached version exists at line 223 but only used once)                                      |
| `__dirname` computation                           | **2 files**                      | `index.ts:7,73`, `swagger.ts:5`        | Partially fixed -- 5 services now use `DATA_DIR` from `utils/paths.ts`; only `index.ts` and `swagger.ts` still compute `__dirname` independently |
| ~~`migratePermissions()`~~                        | ~~`backend/services/claude.ts`~~ | ~~`frontend/utils/localStorage.ts`~~   | **FIXED** -- moved to `shared/types/permissions.ts`; both ends now import from shared                                                            |

### Cross-File Duplications (Frontend)

| What                               | Location A                                                                                    | Location B                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| ~~`Plugin` type definitions~~      | ~~`frontend/src/api.ts:9-26`~~                                                                | ~~`frontend/src/types/plugins.ts:1-18`~~     | **FIXED** -- both now import from `shared/types/plugins.ts`; `types/plugins.ts` is a re-export |
| `getCommandDescription()`          | `SlashCommandAutocomplete.tsx:125-134`                                                        | `SlashCommandsModal.tsx:14-32`               |
| `getMinDateTime()`                 | `DraftModal.tsx:65-69`                                                                        | `Queue.tsx:375` (inline)                     |
| `activePlugins` localStorage logic | `SlashCommandsModal.tsx:51-66`                                                                | `Chat.tsx:462-483`                           |
| In-flight message UI block         | `Chat.tsx:956-986`                                                                            | `Chat.tsx:1027-1057`                         |
| Modal overlay pattern              | `ConfirmModal`, `DraftModal`, `ScheduleModal`, `Queue`, `FolderBrowser`, `SlashCommandsModal` | Same 10-line style block in **6 components** |
| Worktree path computation          | `frontend/src/components/BranchSelector.tsx:72-76`                                            | `backend/src/utils/git.ts:233-240`           | Client-side preview computes path independently from backend -- can diverge                    |

### Cross-Boundary Duplications (Backend <-> Frontend)

~~Every shared type is manually duplicated with no single source of truth.~~ **LARGELY FIXED** -- A `shared/` types package now provides the single source of truth. Both frontend and backend import from `shared/types/`. The following types have been unified:

| Type                                                          | Shared Location                | Status                                                                 |
| ------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| ~~`DefaultPermissions`~~                                      | `shared/types/permissions.ts`  | **FIXED** -- single definition; `migratePermissions()` also shared     |
| ~~`Plugin/PluginCommand/PluginManifest`~~                     | `shared/types/plugins.ts`      | **FIXED** -- single definition; `frontend/types/plugins.ts` re-exports |
| ~~`Chat` / `ChatListResponse`~~                               | `shared/types/chat.ts`         | **FIXED** -- reconciled with all fields                                |
| ~~`ParsedMessage`~~                                           | `shared/types/message.ts`      | **FIXED** -- reconciled with all fields from both sides                |
| ~~`StoredImage` / `ImageUploadResult`~~                       | `shared/types/image.ts`        | **FIXED** -- includes `chatId`, `sha256` fields                        |
| ~~`QueueItem`~~                                               | `shared/types/queue.ts`        | **FIXED** -- `defaultPermissions` properly typed                       |
| ~~`FolderItem/BrowseResult/ValidateResult/FolderSuggestion`~~ | `shared/types/folders.ts`      | **FIXED** -- single definition                                         |
| ~~`StreamEvent`~~                                             | `shared/types/stream.ts`       | **FIXED** -- all fields included                                       |
| ~~`SlashCommand`~~                                            | `shared/types/slashCommand.ts` | **FIXED** -- single definition                                         |
| ~~`BranchConfig`~~                                            | `shared/types/git.ts`          | **FIXED** -- now shared (was frontend-only)                            |
| ~~`SessionStatus`~~                                           | `shared/types/session.ts`      | **FIXED** -- new shared definition                                     |

---

## 3. Inefficient Code

### Backend Performance Issues

| Issue                                              | File:Line                                | Severity     | Detail                                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocking `execSync`** for chat listing           | `routes/chats.ts:70`                     | **HIGH** ⏳  | `find \| xargs \| ls` shell pipeline runs synchronously, blocking the Node event loop                                                                          |
| ~~**Exponential `projectDirToFolder()`**~~         | `utils/paths.ts`                         | ~~**HIGH**~~ | **FIXED** -- replaced with O(n) greedy left-to-right directory walking algorithm; lossy fallback removed                                                       |
| **Full directory scan per image retrieval**        | `image-storage.ts:116`                   | MEDIUM       | `readdirSync` + `find()` on every `getImage()` call; also recomputes SHA256 hash every time                                                                    |
| **No caching in ChatFileService**                  | `chat-file-service.ts:27-53`             | MEDIUM       | `getAllChats()` reads+parses every JSON file from disk on every request                                                                                        |
| **No caching in slashCommands**                    | `slashCommands.ts`                       | LOW          | Reads/writes JSON file synchronously on every call                                                                                                             |
| **O(n\*m) scan to remove one image**               | `routes/images.ts:235-266`               | MEDIUM       | `removeImageFromAllChats()` reads ALL chat files, parses ALL metadata                                                                                          |
| **O(n) fallback in `getChat()`**                   | `chat-file-service.ts:56-87`             | LOW          | Falls back to reading every JSON file if filename lookup fails                                                                                                 |
| ~~**Queue self-HTTP calls**~~                      | `queue-processor.ts` & `routes/queue.ts` | ~~MEDIUM~~   | **FIXED** -- both now call `sendMessage()` directly instead of HTTP                                                                                            |
| ~~**Synchronous `appendFileSync` debug logging**~~ | ~~`services/claude.ts:11-22`~~           | ~~LOW~~      | **FIXED** -- gated behind `NODE_ENV !== "production"` check; debug log file only created in non-production                                                     |
| **Synchronous `execSync` for git info**            | `utils/git.ts:31-52`                     | LOW          | Two synchronous process spawns with 5s timeouts; cached in only 1 of 5 call sites                                                                              |
| **`getRecentFolders()` full scan with `statSync`** | `folder-service.ts:194-281`              | MEDIUM       | Reads all `.jsonl` files + `statSync` per file + `existsSync` per folder. 2-min cache mitigates repeat calls. (Exponential `projectDirToFolder` is now fixed.) |
| **`browseDirectory()` per-file `statSync`**        | `folder-service.ts:104-137`              | LOW          | Synchronous `statSync` for up to 500 entries, blocking event loop                                                                                              |

### Frontend Performance Issues

| Issue                                                        | File:Line                                     | Severity | Detail                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Refetch ALL messages on every SSE update**                 | `Chat.tsx:248`                                | **HIGH** | Every `message_update` event triggers a full `getMessages()` HTTP request                                                                                           |
| **Triple fetch on `message_complete`**                       | `Chat.tsx:211-221`                            | MEDIUM   | `getChat()`, `getMessages()`, `loadSlashCommands()` all fire simultaneously                                                                                         |
| **N parallel status requests**                               | `ChatList.tsx:42-51`                          | MEDIUM   | Up to 20 `getSessionStatus()` calls fired at once with `Promise.all`; no batched endpoint                                                                           |
| **Dozens of concurrent 5s intervals from `useRelativeTime`** | `ToolCallBubble.tsx:16` & `MessageBubble.tsx` | MEDIUM   | Every tool call and message bubble <1hr old runs a 5-second interval; conversations with many tool calls create dozens of concurrent intervals and re-renders       |
| **`useRelativeTime` 5s interval is unconditional**           | `hooks/useRelativeTime.ts:32`                 | LOW      | Even messages 59 minutes old (display changes per-minute at most) still poll every 5 seconds. A tiered interval (5s for <60s, 30s for <60m) would be more efficient |
| **No debounce on resize listener**                           | `hooks/useIsMobile.ts`                        | LOW      | `setState` on every resize event                                                                                                                                    |
| **`getValidationMessage()` called twice**                    | `FolderSelector.tsx:176-180`                  | LOW      | Called for truthiness check, then again for display                                                                                                                 |
| **MarkdownRenderer creates new arrays every render**         | `MarkdownRenderer.tsx`                        | LOW      | `remarkPlugins`, `rehypePlugins`, `components` not memoized -- triggers re-renders                                                                                  |
| **Queue tab counts filter full array 6 times**               | `Queue.tsx:93-100`                            | LOW      | Should be a single reduce pass                                                                                                                                      |

---

## 4. Security Concerns

| Issue                                                             | File:Line                                                                                         | Severity         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~**Command injection via unsanitized branch names**~~            | `utils/git.ts`                                                                                    | ~~**CRITICAL**~~ | **FIXED** -- All user-facing git operations (`ensureWorktree`, `switchBranch`, `removeWorktree`) now use `execFileSync` (no shell). `validateGitRef()` rejects invalid branch names. |
| **CORS allows any origin with credentials**                       | `index.ts:24` -- `cors({ origin: true, credentials: true })`                                      | **HIGH** ⏳      | **REVIEW LATER** -- mitigated by authentication requirement                                                                                                                          |
| **No path restriction on folder browsing**                        | `routes/folders.ts` + `folder-service.ts` -- authenticated users can browse `/etc`, `/root`, etc. | **HIGH** ⏳      | **REVIEW LATER** -- mitigated by authentication requirement                                                                                                                          |
| ~~**No path restriction on git operations**~~                     | `routes/git.ts`                                                                                   | ~~**HIGH**~~     | **FIXED** -- `validateFolderPath()` resolves and validates all folder inputs in git routes                                                                                           |
| ~~**Queue processor bypasses auth**~~                             | `queue-processor.ts`                                                                              | ~~**HIGH**~~     | **FIXED** -- queue processor and execute-now route now call `sendMessage()` directly instead of HTTP, eliminating the auth bypass                                                    |
| ~~**`removeWorktree` uses `JSON.stringify` for shell escaping**~~ | `utils/git.ts`                                                                                    | ~~MEDIUM~~       | **FIXED** -- now uses `execFileSync` (bypasses shell entirely)                                                                                                                       |
| **Missing `secure` flag on session cookie**                       | `auth.ts:54-59` -- cookie sent over HTTP too                                                      | MEDIUM ⏳        |
| **Rate limit map grows unbounded**                                | `auth.ts:17-19` -- entries never cleaned up                                                       | LOW ⏳           |
| **Server filesystem paths leaked in API responses**               | `image-storage.ts:92` -- `storagePath` returned to client                                         | LOW              |
| **No body size limit explicitly set**                             | `index.ts:24` -- relies on Express 100KB default                                                  | LOW              |
| ~~**Image ID not sanitized before filesystem lookup**~~           | `image-storage.ts:118`                                                                            | ~~LOW~~          | **FIXED** -- UUID format validation added to `getImage()` and `deleteImage()`; debug logging removed                                                                                 |
| **`sanitizeBranchForPath()` too simplistic**                      | `utils/git.ts:229-231`                                                                            | LOW              | Only replaces `/` with `-`. Branch collision possible (`feature/foo` and `feature-foo` map to same path). Other chars (`\`, `?`, `*`, `:`) not handled.                              |
| **`ensureWorktree` TOCTOU race condition**                        | `utils/git.ts:252-254`                                                                            | LOW              | `existsSync` check + creation not atomic -- concurrent requests for same branch could race                                                                                           |

---

## 5. API Design Issues

| Issue                                              | Location                           | Detail                                                                                                               |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Images router double-mounted**                   | `index.ts:88-89`                   | Mounted on both `/api/images` and `/api/chats`, creating ambiguous routes                                            |
| **Inconsistent success envelopes**                 | All routes                         | Mix of `{ ok: true }`, `{ success: true }`, `{ success: true, message: '...' }`                                      |
| **Inconsistent error envelopes**                   | All routes                         | Some use `{ error }`, others `{ error, details }`                                                                    |
| **`error: any` in all catch blocks**               | All routes                         | No proper error type narrowing                                                                                       |
| **Silent error swallowing**                        | 15+ empty `catch {}` blocks        | Many real errors hidden behind `try {} catch {}`                                                                     |
| **Fire-and-forget async without `.catch()`**       | `stream.ts:194`                    | `generateAndSaveTitle()` errors are completely lost (fire-and-forget in new message route)                           |
| **Inconsistent `generateAndSaveTitle` invocation** | `stream.ts:194` vs `stream.ts:298` | Fire-and-forget in `POST /new/message`, but `await`ed in `POST /:id/message` -- different latency and error behavior |
| **Metadata JSON parsed without validation**        | 8+ locations                       | `JSON.parse(chat.metadata \|\| '{}')` -- no schema validation                                                        |
| **Swagger comments are documentation-only**        | All route files                    | `#swagger.tags` / `#swagger.requestBody` annotations don't enforce schemas at runtime                                |

---

## 6. Architectural Issues

### Oversized Files

| File                           | Lines      | Recommended Action                                                                                                      |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/pages/Chat.tsx`  | **~1,176** | Extract SSE hook, session management hook, sub-components for header, message list, in-flight message, new-chat welcome |
| `backend/src/routes/chats.ts`  | **659**    | Extract `parseMessages()`, `discoverSessionsPaginated()`, `readJsonlFile()`, git caching into services                  |
| `backend/src/routes/stream.ts` | **587**    | Extract SSE helpers, title generation, image metadata storage, CLI file watcher into services                           |

### ~~No Shared Types Package~~

~~The single biggest architectural issue. Every type is manually duplicated between `frontend/` and `backend/` with no shared `types/` or `shared/` package.~~

**FIXED** -- `shared/` package created at project root with unified type definitions for all 11 previously duplicated types. Both frontend (`api.ts`, `localStorage.ts`, `api/folders.ts`, `types/plugins.ts`) and backend (7 service/route files) now import from `shared/types/`. Configured via TypeScript path aliases and Vite alias resolution.

### Inconsistent Data Directory Resolution

Mostly fixed -- 4 of 5 services now use `DATA_DIR` from `utils/paths.ts`. One holdout remains:

| Service                     | Strategy                                            | Status                                                    |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| ~~`sessions.ts`~~           | ~~`__dirname + '../../../data'`~~                   | **FIXED** -- now imports `DATA_DIR` from `utils/paths.ts` |
| ~~`chat-file-service.ts`~~  | ~~`__dirname + '../../data/chats'`~~                | **FIXED** -- now imports `DATA_DIR` from `utils/paths.ts` |
| ~~`image-storage.ts`~~      | (was independent)                                   | **FIXED** -- now imports `DATA_DIR` from `utils/paths.ts` |
| ~~`queue-file-service.ts`~~ | (was independent)                                   | **FIXED** -- now imports `DATA_DIR` from `utils/paths.ts` |
| `slashCommands.ts`          | `process.cwd() + '/data'` -> depends on working dir | **NOT FIXED** -- still defines own `DATA_DIR` locally     |

### Debug Logging in Production

- ~~`backend/src/services/claude.ts:11-22`: Writes to `logs/slash-commands-debug.log` with synchronous `appendFileSync` unconditionally~~ **FIXED** -- gated behind `NODE_ENV !== "production"`
- ~~`backend/src/routes/stream.ts`: 8 `console.log('[DEBUG]...')` statements including full request body dumps~~ **FIXED** -- removed. One `console.log` remains for OpenRouter title generation (line 40) -- informational, not debug
- ~~`backend/src/services/image-storage.ts`: 5 `console.log('[DEBUG]...')` lines in `getImage()`~~ **FIXED** -- removed in prior commit

### New Architectural Concerns

- ~~**`projectDirToFolder()` exponential complexity** (`utils/paths.ts:13-36`)~~ **FIXED** -- replaced with O(n) greedy left-to-right directory walking; lossy fallback removed.
- **`swagger.ts` computes `__dirname` independently** (line 5) despite `utils/paths.ts` existing for shared path constants.
- **`index.ts` computes `__dirname`/`__rootDir` twice** (lines 7 and 73) for different purposes.
- **`folder-service.ts` cache stores heterogeneous types via unsafe double cast** (`cached.data as unknown as RecentFolder[]` at line 199 and `results as unknown as BrowseResult` at line 274).
- **`switchBranch()` doesn't verify directory is a git repo** (`utils/git.ts:281-296`) unlike `getGitInfo()` which checks for `.git`.
- **Hardcoded `"main"` fallback branch** (`utils/git.ts:56,63`): Returns `"main"` for detached HEAD instead of `undefined` or `"HEAD (detached)"` -- misleading for repos using `master` or other default branches.
- **`getGitBranches()` shell quoting fragility** (`utils/git.ts:84`): Single quotes in format string are shell-interpreted. Output stripping (line 95) confirms quotes leak into results.
- **`prebuild` script creates hard dependency on swagger generation** (`package.json:10`): If swagger generation fails, the entire build fails -- making a docs tool a build blocker.

---

## 7. Styling Issues

### ~~Undefined CSS Variables~~

**FIXED** -- All previously undefined CSS variables are now defined in `index.css` for both dark and light modes:

| Variable               | Status                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| ~~`--bg-secondary`~~   | **FIXED** -- dark: `#1c2128`, light: `#f0f4f8`                           |
| ~~`--font-mono`~~      | **FIXED** -- SF Mono, Monaco, Cascadia Code, Roboto Mono, Consolas, etc. |
| ~~`--error`~~          | **FIXED** -- dark: `#f85149`, light: `#cf222e`                           |
| ~~`--border-light`~~   | **FIXED** -- dark: `#21262d`, light: `#e2e8f0`                           |
| ~~`--text-secondary`~~ | **FIXED** -- dark: `#8b949e`, light: `#64748b`                           |
| `--text-muted`         | Was already defined -- dark: `#8b949e`, light: `#64748b`                 |

### Other Styling Issues

- **6 modal components** each re-implement the same fullscreen overlay pattern (~10 lines each) -- no shared `<ModalOverlay>` component
- **4 different monospace font stacks** used across components
- ~~**Identical `.hljs` media query rules** for dark and light mode in `index.css` (lines 136-154)~~ **FIXED** -- removed redundant dark/light media queries; base rule already uses CSS variables
- **All inline `style={{}}`** -- new objects created on every render, no hover/focus pseudo-class support, no reuse
- **BranchSelector.tsx has ~20 inline style objects** that are all recreated every render

---

## 8. Type Safety Issues

- **`any` types** used in 20+ locations across frontend and backend (API return types, catch blocks, request bodies). Notable instances:
  - `routes/chats.ts:185,193` -- `fileChats: any[]`, `fileChatsBySessionId: Map<string, any>`
  - `routes/queue.ts:185` -- `requestBody: any`
  - `Chat.tsx:518` -- `const requestBody: any = { folder, prompt, defaultPermissions }`
  - Note: `findChat()` and `findChatForStatus()` moved to `utils/chat-lookup.ts` -- return types improved but some `any` casts may remain in route handlers
- **Non-null assertions (`!`)**: 12+ instances of `streamChatId!` and `id!` in Chat.tsx
- ~~**`addToBacklog()` is a trivial wrapper** around `createDraft()` with misleading naming (`api.ts:261-264`)~~ **FIXED** -- removed; callers use `createDraft()` directly
- ~~**`BranchConfig` interface** defined only in frontend (`api.ts:283-287`) with no backend counterpart~~ **FIXED** -- moved to `shared/types/git.ts`
- **`getGitBranches` return type** is an inline object (`Promise<{ branches: string[] }>`) rather than a named interface
- ~~**`formatRelativeTime()` silently returns `'just now'`** for invalid dates and future timestamps (`dateFormat.ts:2-4`) -- no error indication~~ **FIXED** -- now returns `""` for invalid dates and `"just now"` for future timestamps (clock skew)
- **`getCachedGitInfo()` and 4 other git call sites** silently swallow all errors with empty `catch {}` blocks

---

## 9. Configuration Issues

| Issue                                            | File                     | Detail                                                                             |
| ------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------- |
| ~~**Wrong hardcoded path**~~                     | `ecosystem.config.cjs:6` | **FIXED** -- now uses `__dirname` for portability across machines                  |
| ~~**start-server.js ignores ecosystem.config**~~ | `start-server.js`        | **FIXED** -- now uses `pm2 start ecosystem.config.cjs` instead of inline args      |
| ~~**`@types/multer` in dependencies**~~          | `package.json:47`        | **FIXED** -- already in `devDependencies` (verified)                               |
| ~~**Redundant root `tsc` in build script**~~     | ~~`package.json:8`~~     | **FIXED** -- build script is now `npm run build:backend && npm run build:frontend` |
