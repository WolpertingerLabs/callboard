# Future Work

> Consolidated from `AGENTS_PLAN.md` (Phase 5), `tasks/review.md`, and `tasks/tasklist.md`.
> Last updated: 2025-02-21

---

## 1. Agent Platform — Next Features

Items from the agents roadmap Phase 5. Some are partially started.

### 1.1 Dashboard Real-Time Updates

- [ ] WebSocket or SSE for live activity feed updates
- [ ] Real-time session status across all agents
- [ ] Notification system for pending permission approvals
- [ ] Agent status indicators (idle, running, heartbeat active, waiting for approval)
- [ ] Live proxy ingestor status (event counts updating in real-time)

### 1.2 Agent Templates

- [ ] Pre-built agent configurations for common use cases ("Code Reviewer", "CI Monitor", "Discord Bot", "Documentation Writer")
- [ ] Import/export full agent workspaces as archives

### 1.3 Multi-Session Management

- [ ] Agent can run multiple concurrent sessions
- [ ] Session pool with configurable concurrency limits
- [ ] Queue system for excess requests when at capacity

### 1.4 Advanced Proxy Integration

- [ ] Per-agent proxy caller profiles (different agents get different connection access via separate callers)
- [ ] Per-agent ingestor overrides (different event filters, buffer sizes)
- [ ] Dashboard UI for managing proxy `remote.config.json` (add connections, manage callers)
- [ ] Proxy connection health alerts in agent activity feed (ingestor disconnections, buffer near-full warnings)
- [ ] Proxy rate limit monitoring (track requests/min per session, alert on throttling)

---

## 2. Refactoring — Oversized Files

### 2.1 `Chat.tsx` (~1,420 lines)

- [ ] Extract SSE streaming logic into `hooks/useChatStream.ts`
- [ ] Extract session status polling into `hooks/useSessionStatus.ts`
- [ ] Extract chat header into `components/ChatHeader.tsx`
- [ ] Extract message list rendering into `components/MessageList.tsx`
- [ ] Extract in-flight message display into `components/InFlightMessage.tsx`
- [ ] Extract new-chat welcome screen into `components/NewChatWelcome.tsx`
- [ ] Deduplicate the two in-flight message UI blocks (lines ~956-986 and ~1027-1057)

### 2.2 `routes/chats.ts` (~659 lines)

- [ ] Extract `parseMessages()` into `services/message-parser.ts`
- [ ] Extract `discoverSessionsPaginated()` into `services/session-discovery.ts`
- [ ] Extract `readJsonlFile()` into `utils/jsonl.ts`
- [ ] Move git caching into the git service

### 2.3 `routes/stream.ts` (~587 lines)

- [ ] Extract title generation logic into `services/title-generator.ts`
- [ ] Extract image metadata storage into image-storage service
- [ ] Extract CLI file watcher logic into `services/cli-watcher.ts`
- [ ] Extract SSE helpers

---

## 3. Performance

### 3.1 Backend

- [ ] Replace blocking `execSync` in `routes/chats.ts:70` with async `execFile` or `readdir`
- [ ] Move git info fetching to a service with TTL-based caching
- [ ] Add in-memory cache with TTL to `ChatFileService.getAllChats()` (invalidate on write)
- [ ] Replace `readdirSync` + `find()` in `image-storage.ts:getImage()` with a lookup map
- [ ] Replace synchronous file I/O in `slashCommands.ts` with async equivalents
- [ ] Replace `execSync` in `utils/git.ts` with async `execFile`
- [ ] Replace `statSync` per-file calls in `folder-service.ts` (`browseDirectory()`, `getRecentFolders()`) with async alternatives
- [ ] Create a shared `__dirname` helper for `index.ts` and `swagger.ts`

### 3.2 Frontend

- [ ] Replace full `getMessages()` refetch on every SSE `message_update` with incremental/delta updates
- [ ] Add a batched `/api/sessions/status` endpoint to replace N parallel `getSessionStatus()` calls in ChatList
- [ ] Add debounce to resize listener in `hooks/useIsMobile.ts`
- [ ] Memoize `remarkPlugins`, `rehypePlugins`, `components` arrays in `MarkdownRenderer.tsx`
- [ ] Cache `getValidationMessage()` result in `FolderSelector.tsx` to avoid double-call
- [ ] Implement tiered interval in `useRelativeTime.ts` (5s for <60s, 30s for <60m) to reduce re-renders

---

## 4. Security

### 4.1 Critical

- [ ] Restrict CORS `origin` to specific allowed domain(s) in production (currently `origin: true`) — mitigated by auth requirement
- [ ] Add path allowlist to folder browsing service (currently unrestricted filesystem access) — mitigated by auth requirement

### 4.2 Important

- [ ] Add `secure: true` flag to session cookie in production (`auth.ts`)
- [ ] Remove `storagePath` from API responses in `image-storage.ts` (leaks server paths)
- [ ] Fix `sanitizeBranchForPath()` (`utils/git.ts`) — handle `\`, `?`, `*`, `:` and prevent collision between `feature/foo` and `feature-foo`
- [ ] Fix `ensureWorktree` TOCTOU race condition (`utils/git.ts`) — make check+create atomic

### 4.3 Maintenance

- [ ] Add periodic cleanup or TTL to the rate limit `Map` in `auth.ts`
- [ ] Set explicit body size limit with `express.json({ limit: '1mb' })` in `index.ts`
- [ ] Add JSON schema validation for `metadata` fields parsed via `JSON.parse()`

---

## 5. API Design

- [ ] Define a standard success envelope: `{ success: true, data: T }` and apply across all routes
- [ ] Define a standard error envelope: `{ success: false, error: string, details?: unknown }` and apply across all routes
- [ ] Replace `error: any` in all catch blocks with proper type narrowing (`error instanceof Error`)
- [ ] Add `.catch()` handlers to all fire-and-forget async calls (e.g., `generateAndSaveTitle()`)
- [ ] Make `generateAndSaveTitle()` invocation consistent (fire-and-forget vs await)
- [ ] Audit and remove all empty `catch {}` blocks — log errors or handle them
- [ ] Fix images router double-mount — mount only on `/api/images`

---

## 6. Code Quality & Styling

- [ ] Standardize monospace font stack across all components (currently 4 different stacks)
- [ ] Extract inline `style={{}}` objects to module-level constants or CSS classes (especially `BranchSelector.tsx` with ~20 inline styles)
- [ ] Add comments to `tsconfig.json` files explaining different `target` choices (ES2022 vs ES2020)
- [ ] Narrow lint-staged glob from `*.{ts,tsx}` to `{frontend,backend}/**/*.{ts,tsx}`
- [ ] Evaluate whether `prebuild: npm run swagger` should be a soft dependency
- [ ] Reduce `any` types (20+ locations across frontend and backend)
- [ ] Address non-null assertions (`!`) — 12+ instances of `streamChatId!` and `id!` in `Chat.tsx`
