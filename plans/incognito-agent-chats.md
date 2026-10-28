# Incognito agent chats

An "Incognito" toggle on agent chats. While it is on, the agent does not write anything about the conversation into its memory. You can turn it on when you start a chat or partway through one.

## How journals get written today

- Callboard's own code never writes `memory/YYYY-MM-DD.md`. The model writes it with Write/Edit/Bash, because the workspace `CLAUDE.md` (scaffolded from `backend/src/scaffold/CLAUDE.md`) says "Always, and as you go".
- `CLAUDE.md` is loaded natively through `settingSources` (`claude.ts:1810`). The identity and workspace append (`compileSystemPrompt`) is sent only on the first message. The continue route doesn't resend it, so an instruction placed there would be gone after the first turn.
- Per-chat flags such as `modelReview` and `requireExplicitCompletion` live in the chat's `metadata` JSON. They are pinned at creation (`claude.ts:~1116`), recovered when the chat resumes (`claude.ts:~1093`), and toggled mid-chat with `PATCH /api/chats/:id/permissions`. Incognito follows the same pattern.

## Design: three layers

### 1. Persisted flag: `metadata.incognito: true`

- **New chat:** `POST /api/chats/new/message` accepts `incognito?: boolean`. It is threaded through `SendMessageOptions` into `initialMetadata`, stored only when true (`...(opts.incognito === true && { incognito: true })`).
- **Existing chat:** `PATCH /api/chats/:id/permissions` accepts `incognito`, the same way it handles `modelReview`. The key is stored as `true` or deleted. This is how you turn it on or off mid-chat.
- **Each turn:** `sendMessage` reads it again, through `liveChatMetadataReader` / the resumed metadata, so a flip takes effect on the next message.
- **Forks:** `routes/chats.ts` (~1423) copies the flag to the fork. A fork of a private chat stays private.
- **Request field only:** this adds an optional field to the request, not a new stream enum value, so no `CLIENT_CAPS` gate is needed.

### 2. Instruction, injected on the server every turn

When `incognito` is set, `sendMessage` adds an `incognitoInstruction` to `systemPromptAppend` (`claude.ts:1778`), next to `completionInstruction`. Because the server builds it, it survives continue and resume. Draft:

> This is an incognito conversation. Do not record anything from it: do not create or append to `memory/` journals, and do not update MEMORY.md, USER.md, SOUL.md, TOOLS.md or any other workspace file to remember what is said here. This overrides the journaling instructions in CLAUDE.md. You may still read your memory files, and you may edit files when the user explicitly asks you to as part of the task.

Codex receives the append as `model_instructions_file`, and Cline as `systemPrompt`, so every engine gets this layer.

### 3. Hard gate on memory paths

The prompt alone isn't enough, because the scaffold `CLAUDE.md` pushes hard in the other direction.

- **Claude Code:** an in-process SDK `PreToolUse` hook, merged into `hookOpts`. Hooks run even for allow-listed tools; `canUseTool` doesn't, and agent chats default to all-allow. The hook returns `permissionDecision: "deny"` with a reason the model can read ("Incognito: memory writes are disabled") when:
  - `Write`, `Edit`, `MultiEdit` or `NotebookEdit` targets `<workspace>/memory/**` or one of the curated files (`MEMORY.md`, `USER.md`, `SOUL.md`, `TOOLS.md`). Paths are resolved with `realpath`, so `../` and symlinks can't get around the check.
  - `Bash` is best-effort: deny when the command mentions a protected path together with a write operator (`>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `touch`). A determined model can still get around this. That's acceptable because layer 2 is the main control.
  - The hook reads the live flag, so turning incognito off mid-chat takes effect on the next tool call.
- **pi, ACP and Cline:** run the same path check (a shared `isIncognitoProtectedWrite(toolName, input, workspace)` in `agents/permissions/`) before the allow short-circuit in `decidePiToolCall`, `resolveAcpPermission` and `buildRequestToolApproval`.
- **Codex:** it has no per-call hook, so it gets layer 2 only. The UI tooltip says so ("best-effort on Codex").

### Side channels

- **Activity log:** `appendActivity` "Chat session started" (`claude.ts:~2208`) gets no chat title or prompt for incognito chats. Heartbeat sessions can read the activity log through `get_activity`.
- **Other sessions reading the transcript:** `search_chats`, `read_session_messages` and `get_chat_tree` skip incognito chats when the caller is an **agent** session. Otherwise a heartbeat or consolidation run could read the transcript and journal it. Human-driven sessions still see them.
- **Spawned sessions:** `talk_to_agent` and chats spawned from an incognito chat inherit `incognito: true`.
- **Not in scope:** the Claude SDK's own transcript under `~/.claude/projects/...` and Callboard's chat storage. Incognito means "the agent doesn't remember". It does not mean "nothing is stored on disk". The chat still appears in the chat list and can be deleted normally.

## UI

- **New chat** (`NewChatPanel.tsx`, `renderBehaviorSection`, Agent mode only): an "Incognito — don't write to memory or journals" checkbox. It is passed through `ChatRouteState` to `handleSend` → `incognito: true`. The same router state is used by `AgentDashboard.tsx` and `CardDrawer.tsx`.
- **Existing chat:** a menu item in the composer's `PromptInput` menu, next to "Model", calls the PATCH route.
- **Indicator:** an `EyeOff` badge reading "Incognito" in the chat header and composer, driven by `parseChatMeta` (`useChatMeta.ts`). The badge reflects the **persisted** flag, so a stale daemon that ignored the field shows no badge and doesn't give a false sense of privacy. It is styled with existing CSS variables only.

## Tests (vitest)

- Unit tests for `isIncognitoProtectedWrite`: memory paths, curated files, `../` traversal, a symlink, a Bash redirect, and non-protected writes allowed.
- `sendMessage`: the flag persists on a new chat, is recovered on continue, and adds the instruction only when set.
- `PATCH /:id/permissions` round-trips `incognito`, and forks copy it.
- Chat-query tools exclude incognito chats for agent callers.

## Open questions

1. Scope: only `memory/` journals, or also MEMORY.md, USER.md, SOUL.md and TOOLS.md? Recommended: all of them. Otherwise "remember that I…" still lands in USER.md.
2. If incognito is turned **off** mid-chat, can the agent then journal what was said earlier? Recommended: no. When the flag has ever been set, the instruction gains "earlier turns of this chat remain private".
