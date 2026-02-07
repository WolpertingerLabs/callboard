# Full Architectural Review: Claude Code UI

> **Last updated:** Post-commit `e1787b8` (feat: add OpenAPI spec auto-generation)

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

| File                                        | Lines | Notes                                                     |
| ------------------------------------------- | ----- | --------------------------------------------------------- |
| `frontend/src/hooks/useStream.ts`           | 87    | Never imported anywhere. Chat.tsx implements SSE inline   |
| `frontend/src/components/ScheduleModal.tsx` | 161   | Never imported. DraftModal.tsx handles scheduling instead |

### Unused Backend Exports

| Function                               | File                                        | Line |
| -------------------------------------- | ------------------------------------------- | ---- |
| `getAllSessions()`                     | `backend/src/services/sessions.ts`          | 101  |
| `getTotalChats()`                      | `backend/src/services/chat-file-service.ts` | 194  |
| `getImagesDir()`                       | `backend/src/services/image-storage.ts`     | 203  |
| `getAllDirectoriesWithSlashCommands()` | `backend/src/services/slashCommands.ts`     | 79   |
| `removeSlashCommandsForDirectory()`    | `backend/src/services/slashCommands.ts`     | 87   |

### Unused Frontend Functions/Imports

| Item                           | File                                           | Notes                                                                    |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `stopChat()`                   | `frontend/src/api.ts:123`                      | Chat.tsx makes its own inline fetch                                      |
| `createChat()`                 | `frontend/src/api.ts:77`                       | Chat creation uses `/new/message` now                                    |
| `getImageUrl()`                | `frontend/src/api.ts:186`                      | Never called                                                             |
| `getSlashCommands()`           | `frontend/src/api.ts:266`                      | Imported in Chat.tsx but never invoked                                   |
| `clearFolderCache()`           | `frontend/src/api/folders.ts:91`               | Never called                                                             |
| `clearAllRecentDirectories()`  | `frontend/src/utils/localStorage.ts:111`       | Never called                                                             |
| `ChevronDown` import           | `frontend/src/pages/Chat.tsx:3`                | Imported but unused in this file (used separately in BranchSelector.tsx) |
| `useMemo` import               | `frontend/src/pages/ChatList.tsx:1`            | Imported but never used                                                  |
| `ChatListResponse` type import | `frontend/src/pages/ChatList.tsx:4`            | Imported but never used                                                  |
| `FolderOpen`, `File` imports   | `frontend/src/components/FolderBrowser.tsx:2`  | Icons imported but unused                                                |
| `StoredImage` interface        | `frontend/src/components/ImageUpload.tsx:4-11` | Defined locally but never referenced                                     |

### Unreachable Backend Route

| Route                     | File                              | Issue                                                                                                                              |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /upcoming/next-hour` | `backend/src/routes/queue.ts:232` | **BUG**: Registered after `GET /:id` (line 88) -- Express matches `upcoming` as an `:id` parameter. This route is never reachable. |

---

## 2. Duplicate Code

### Cross-File Duplications (Backend)

| What                                              | Location A                          | Location B                                                                                                                                  | Impact                                                                                                      |
| ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `findSessionLogPath()`                            | `routes/chats.ts:22-29`             | `routes/stream.ts:16-25`                                                                                                                    | Duplicated with slight divergence -- stream.ts wraps in try/catch, chats.ts does not                        |
| ~~`CLAUDE_PROJECTS_DIR` constant~~                | ~~`routes/chats.ts:12`~~            | ~~`routes/stream.ts:12`~~                                                                                                                   | **FIXED** -- now shared via `utils/paths.ts`                                                                |
| `findChat()` / `findChatForStatus()`              | `routes/chats.ts:413-466`           | `routes/stream.ts:30-43`                                                                                                                    | Same lookup pattern                                                                                         |
| SSE event handler pattern                         | `routes/stream.ts:186-212`          | `routes/stream.ts:306-323` & `385-402`                                                                                                      | Same handler logic repeated **3 times**                                                                     |
| SSE header block                                  | `routes/stream.ts:178-182`          | `routes/stream.ts:300-304` & `377-381`                                                                                                      | Same 5-line writeHead block **3 times**                                                                     |
| Image loading loop                                | `routes/stream.ts:152-167`          | `routes/stream.ts:260-288`                                                                                                                  | Same iteration over imageIds                                                                                |
| `updateChatWithImages()` / `storeMessageImages()` | `routes/images.ts:205-230`          | `routes/stream.ts:338-365`                                                                                                                  | Near-identical metadata storage                                                                             |
| Git info fetch pattern                            | `routes/chats.ts`                   | Lines 304, 360, 427, 447                                                                                                                    | Same bare try/catch `getGitInfo()` block **4 times** (cached version exists at line 223 but only used once) |
| `__dirname` computation                           | **7 files**                         | `index.ts:7,95`, `swagger.ts:5`, `queue-file-service.ts:6`, `image-storage.ts:7`, `chat-file-service.ts:6`, `claude.ts:11`, `sessions.ts:5` |
| `migratePermissions()`                            | `backend/services/claude.ts:90-109` | `frontend/utils/localStorage.ts:13-35`                                                                                                      | Same migration logic in both ends                                                                           |

### Cross-File Duplications (Frontend)

| What                               | Location A                                                                                    | Location B                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `Plugin` type definitions          | `frontend/src/api.ts:9-26`                                                                    | `frontend/src/types/plugins.ts:1-18`         |
| `getCommandDescription()`          | `SlashCommandAutocomplete.tsx:125-134`                                                        | `SlashCommandsModal.tsx:14-32`               |
| `getMinDateTime()`                 | `DraftModal.tsx:65-69`                                                                        | `Queue.tsx:375` (inline)                     |
| `activePlugins` localStorage logic | `SlashCommandsModal.tsx:51-66`                                                                | `Chat.tsx:462-483`                           |
| In-flight message UI block         | `Chat.tsx:956-986`                                                                            | `Chat.tsx:1027-1057`                         |
| Modal overlay pattern              | `ConfirmModal`, `DraftModal`, `ScheduleModal`, `Queue`, `FolderBrowser`, `SlashCommandsModal` | Same 10-line style block in **6 components** |
| Worktree path computation          | `frontend/src/components/BranchSelector.tsx:72-76`                                            | `backend/src/utils/git.ts:233-240`           | Client-side preview computes path independently from backend -- can diverge |

### Cross-Boundary Duplications (Backend <-> Frontend)

Every shared type is manually duplicated with no single source of truth:

| Type                                     | Backend                                   | Frontend                                 | Divergence                                                                                                                 |
| ---------------------------------------- | ----------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DefaultPermissions`                     | `services/claude.ts:75-82`                | `api.ts:68-75` + `localStorage.ts:3-11`  | 3 copies, consistent                                                                                                       |
| `Plugin/PluginCommand/PluginManifest`    | `services/plugins.ts:4-21`                | `api.ts:11-39` + `types/plugins.ts:1-30` | 3 copies                                                                                                                   |
| `Chat`                                   | `chat-file-service.ts:14-22`              | `api.ts:41-51`                           | Frontend has extra fields (`title`, `session_ids`)                                                                         |
| `ParsedMessage`                          | `routes/chats.ts:607-652`                 | `api.ts:42-51`                           | Frontend has `toolUseId`, `isBuiltInCommand`, `teamName`; backend has `tool_name`, `tool_input`, `tool_result`, `thinking` |
| `StoredImage`                            | `image-storage.ts:13-23`                  | `api.ts:157-164`                         | Backend has `chatId`, `sha256` fields frontend omits                                                                       |
| `QueueItem`                              | `queue-file-service.ts:22`                | `api.ts:200`                             | Backend uses `any` for `defaultPermissions`                                                                                |
| `FolderItem/BrowseResult/ValidateResult` | `folder-service.ts:4-36`                  | `api/folders.ts:3-37`                    | Identical copy-paste                                                                                                       |
| `StreamEvent`                            | `services/claude.ts:24-33`                | `hooks/useStream.ts:4-8`                 | Frontend missing 5 fields                                                                                                  |
| `SlashCommand`                           | `services/slashCommands.ts:5-10`          | `api.ts:3-9`                             | Identical                                                                                                                  |
| `BranchConfig`                           | Expected by `routes/stream.ts` (req.body) | `api.ts:283-287`                         | Frontend-only type, no backend definition                                                                                  |

---

## 3. Inefficient Code

### Backend Performance Issues

| Issue                                              | File:Line                                              | Severity | Detail                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Blocking `execSync`** for chat listing           | `routes/chats.ts:70`                                   | **HIGH** | `find \| xargs \| ls` shell pipeline runs synchronously, blocking the Node event loop                                                                        |
| **Exponential `projectDirToFolder()`**             | `utils/paths.ts:13-36`                                 | **HIGH** | Tries `2^(n-1)` path combinations for directory names with `n` dashes, each calling `existsSync()`. Called per-session in chat listing.                      |
| **Full directory scan per image retrieval**        | `image-storage.ts:116`                                 | MEDIUM   | `readdirSync` + `find()` on every `getImage()` call; also recomputes SHA256 hash every time                                                                  |
| **No caching in ChatFileService**                  | `chat-file-service.ts:27-53`                           | MEDIUM   | `getAllChats()` reads+parses every JSON file from disk on every request                                                                                      |
| **No caching in slashCommands**                    | `slashCommands.ts`                                     | LOW      | Reads/writes JSON file synchronously on every call                                                                                                           |
| **O(n\*m) scan to remove one image**               | `routes/images.ts:235-266`                             | MEDIUM   | `removeImageFromAllChats()` reads ALL chat files, parses ALL metadata                                                                                        |
| **O(n) fallback in `getChat()`**                   | `chat-file-service.ts:56-87`                           | LOW      | Falls back to reading every JSON file if filename lookup fails                                                                                               |
| **Queue self-HTTP calls**                          | `queue-processor.ts:55-62` & `routes/queue.ts:180-212` | MEDIUM   | Makes HTTP requests to localhost instead of calling service functions directly                                                                               |
| **Synchronous `appendFileSync` debug logging**     | `services/claude.ts:11-22`                             | LOW      | Blocks I/O; runs in production                                                                                                                               |
| **Synchronous `execSync` for git info**            | `utils/git.ts:31-52`                                   | LOW      | Two synchronous process spawns with 5s timeouts; cached in only 1 of 5 call sites                                                                            |
| **`getRecentFolders()` full scan with `statSync`** | `folder-service.ts:194-281`                            | MEDIUM   | Reads all `.jsonl` files + `statSync` per file + `existsSync` per folder (may trigger exponential `projectDirToFolder`). 2-min cache mitigates repeat calls. |
| **`browseDirectory()` per-file `statSync`**        | `folder-service.ts:104-137`                            | LOW      | Synchronous `statSync` for up to 500 entries, blocking event loop                                                                                            |

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
| **Queue processor bypasses auth**                                 | `queue-processor.ts:58` -- has explicit TODO acknowledging this                                   | **HIGH**         |
| ~~**`removeWorktree` uses `JSON.stringify` for shell escaping**~~ | `utils/git.ts`                                                                                    | ~~MEDIUM~~       | **FIXED** -- now uses `execFileSync` (bypasses shell entirely)                                                                                                                       |
| **Missing `secure` flag on session cookie**                       | `auth.ts:54-59` -- cookie sent over HTTP too                                                      | MEDIUM           |
| **Rate limit map grows unbounded**                                | `auth.ts:17-19` -- entries never cleaned up                                                       | LOW              |
| **Server filesystem paths leaked in API responses**               | `image-storage.ts:92` -- `storagePath` returned to client                                         | LOW              |
| **No body size limit explicitly set**                             | `index.ts:24` -- relies on Express 100KB default                                                  | LOW              |
| **Image ID not sanitized before filesystem lookup**               | `image-storage.ts:118` -- potential directory traversal                                           | LOW              |
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

### No Shared Types Package

The single biggest architectural issue. Every type is manually duplicated between `frontend/` and `backend/` with no shared `types/` or `shared/` package. This is the root cause of at least **11 type inconsistencies** (including the new `BranchConfig` type).

### Inconsistent Data Directory Resolution

| Service                | Strategy                                                  | Risk                                                   |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `sessions.ts`          | `__dirname + '../../../data'` -> project root `/data/`    | Different root than other services                     |
| `chat-file-service.ts` | `__dirname + '../../data/chats'` -> `backend/data/chats/` | OK                                                     |
| `slashCommands.ts`     | `process.cwd() + '/data'` -> depends on working dir       | **Fragile** -- depends on working directory at startup |

### Debug Logging in Production

- `backend/src/services/claude.ts:11-22`: Writes to `logs/slash-commands-debug.log` with synchronous `appendFileSync` unconditionally
- `backend/src/routes/stream.ts`: 8 `console.log('[DEBUG]...')` statements (lines 248, 252, 262, 266, 269, 275, 282, 287) including full request body dumps
- `backend/src/services/image-storage.ts`: 5 `console.log('[DEBUG]...')` lines in `getImage()` -- including `console.log('[DEBUG] All files in directory:', files)` which dumps full directory listings

### New Architectural Concerns

- **`projectDirToFolder()` exponential complexity** (`utils/paths.ts:13-36`): Generates `2^(n-1)` path candidates for directory names with `n` dash-separated segments. Lossy fallback converts ALL dashes to slashes (e.g., `/home/my-app` -> `/home/my/app`).
- **`swagger.ts` computes `__dirname` independently** (line 5) despite `utils/paths.ts` existing for shared path constants.
- **`index.ts` computes `__dirname`/`__rootDir` twice** (lines 7 and 95) for different purposes.
- **`folder-service.ts` cache stores heterogeneous types via unsafe double cast** (`cached.data as unknown as RecentFolder[]` at line 199 and `results as unknown as BrowseResult` at line 274).
- **`switchBranch()` doesn't verify directory is a git repo** (`utils/git.ts:281-296`) unlike `getGitInfo()` which checks for `.git`.
- **Hardcoded `"main"` fallback branch** (`utils/git.ts:56,63`): Returns `"main"` for detached HEAD instead of `undefined` or `"HEAD (detached)"` -- misleading for repos using `master` or other default branches.
- **`getGitBranches()` shell quoting fragility** (`utils/git.ts:84`): Single quotes in format string are shell-interpreted. Output stripping (line 95) confirms quotes leak into results.
- **`prebuild` script creates hard dependency on swagger generation** (`package.json:10`): If swagger generation fails, the entire build fails -- making a docs tool a build blocker.

---

## 7. Styling Issues

### Undefined CSS Variables

These are referenced in inline styles but **never defined** in `index.css`:

| Variable           | Files Using It                                     | Impact                                            |
| ------------------ | -------------------------------------------------- | ------------------------------------------------- |
| `--bg-secondary`   | **12 files** (incl. new `BranchSelector.tsx`)      | All backgrounds using this resolve to transparent |
| `--font-mono`      | 3 files                                            | Falls through to browser default                  |
| `--error`          | PermissionSettings                                 | **No fallback** -- property invalid               |
| `--border-light`   | PermissionSettings                                 | **No fallback** -- property invalid               |
| `--text-secondary` | Chat.tsx (line 836)                                | No fallback                                       |
| `--text-muted`     | BranchSelector.tsx (lines 139, 161, 169, 205, 258) | **NEW** -- 5 references with no fallback          |

### Other Styling Issues

- **6 modal components** each re-implement the same fullscreen overlay pattern (~10 lines each) -- no shared `<ModalOverlay>` component
- **4 different monospace font stacks** used across components
- **Identical `.hljs` media query rules** for dark and light mode in `index.css` (lines 136-154)
- **All inline `style={{}}`** -- new objects created on every render, no hover/focus pseudo-class support, no reuse
- **BranchSelector.tsx has ~20 inline style objects** that are all recreated every render

---

## 8. Type Safety Issues

- **`any` types** used in 20+ locations across frontend and backend (API return types, catch blocks, request bodies). Notable new instances:
  - `routes/chats.ts:185,193` -- `fileChats: any[]`, `fileChatsBySessionId: Map<string, any>`
  - `routes/chats.ts:413` -- `findChat(id: string): any | null`
  - `routes/chats.ts:476,523,554` -- `findChat(...) as any` casts
  - `routes/stream.ts:30` -- `findChatForStatus(id: string): any | null`
  - `routes/queue.ts:185` -- `requestBody: any`
  - `Chat.tsx:518` -- `const requestBody: any = { folder, prompt, defaultPermissions }`
- **Non-null assertions (`!`)**: 12+ instances of `streamChatId!` and `id!` in Chat.tsx
- **`addToBacklog()` is a trivial wrapper** around `createDraft()` with misleading naming (`api.ts:261-264`)
- **`BranchConfig` interface** defined only in frontend (`api.ts:283-287`) with no backend counterpart
- **`getGitBranches` return type** is an inline object (`Promise<{ branches: string[] }>`) rather than a named interface
- **`formatRelativeTime()` silently returns `'just now'`** for invalid dates and future timestamps (`dateFormat.ts:2-4`) -- no error indication
- **`getCachedGitInfo()` and 4 other git call sites** silently swallow all errors with empty `catch {}` blocks

---

## 9. Configuration Issues

| Issue                                        | File                     | Detail                                                                             |
| -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| **Wrong hardcoded path**                     | `ecosystem.config.cjs:6` | `cwd: '/home/exedev/claude-code-ui'` -- should be `/home/cybil/`                   |
| **start-server.js ignores ecosystem.config** | `start-server.js`        | Runs `pm2 start` with inline args, bypassing the config file entirely              |
| **`@types/multer` in dependencies**          | `package.json:26`        | Should be in `devDependencies`                                                     |
| ~~**Redundant root `tsc` in build script**~~ | ~~`package.json:8`~~     | **FIXED** -- build script is now `npm run build:backend && npm run build:frontend` |
