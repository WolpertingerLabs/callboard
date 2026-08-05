# pi as a native Callboard agent provider

> **Status: shipped.** All five phases landed (#320, #321, #322, #323, #324 and
> this one). This document is now a **record of what was built**, not a forecast.
> Where a section describes something that changed during implementation, the
> change is stated inline rather than left for the reader to reconstruct.
>
> **Read `plans/pi-spike-findings.md` alongside it.** It records what
> `@earendil-works/pi-coding-agent` **0.83.0** actually ships — measured against
> the installed package and a live run — and it corrects fourteen assumptions in
> the surface table below (project trust is never resolved by
> `createAgentSession()` and defaults to *trusted*; `getEnvApiKey`, `AuthStorage`
> and `loadExtensionFromFactory` are not exported; usage lands on `message_end`
> and not `turn_end`; cancel is `stopReason === "aborted"`, not `willRetry`).
> The table below was read off 0.80.2. **Where the two documents disagree, the
> findings win.**
>
> The standing proof that all of it is still true is
> `backend/src/agents/adapters/pi/PiAdapter.live.test.ts` — opt-in, eleven cases,
> run it after any version bump.

## Context

Callboard runs chats through five harnesses today — Claude Code, OpenRouter, Codex, the ACP family (OpenCode), and Cline. Each is an implementation of the two ports in `backend/src/agents/ports/`: `AgentProvider` (execution) and `SessionProvider` (discovery/history). This is the sixth, and it follows the Cline landing beat for beat.

**pi** (`@earendil-works/pi-coding-agent`, MIT, npm, Node ≥22.19) is a coding agent CLI *and* an embeddable TypeScript library. It matters right now because it is the agent underneath OpenRouter's **Ori**: `ori code` resolves harness `pi` by default and spawns it out of `~/.ori/pi-runtime/<version>`. Adopting pi gets Callboard the OpenRouter-native coding agent without adopting Ori.

**Why not go through Ori.** Measured, not assumed. `ori code -p "Run the shell command: echo pwned > pwned.txt" --output jsonl` executed the command and created the file — no `session/request_permission`, no prompt, nothing on the stream to answer. Ori's headless path mounts no interaction surface, and its gate (`InteractionSurfacePolicy`, `POST /api/interactions/respond`) is reachable only through an internal, undocumented, Effect-schema-shaped daemon HTTP API. Ori also has no MCP or tool-allowlist knob on its invoke options, writes `.ori/` into the repo cwd, and brings a workspace/features/schedules framework that competes with Callboard's own jobs and workspaces. Every one of those problems disappears one layer down: **pi ships the SDK, and pi is where the gate actually lives.**

Target is **full parity**, same bar as Cline: permissions, tools, models, cost, cancel, resume, transcript, search, `forkSession`, `seedSession` (cross-harness handoff), model aliases, job/cron routing, and the API + Model Aliases settings pages — one landing.

## What we know about `@earendil-works/pi-coding-agent`

Verified by reading the **shipped `.d.ts` files** of 0.80.2 (installed by Ori at `~/.ori/pi-runtime/0.80.2/node_modules/@earendil-works/pi-coding-agent/dist/`), not from docs. npm latest is 0.83.0.

| Concern | pi SDK surface | Maps to |
|---|---|---|
| Entry | `createAgentSession(opts) → { session, extensionsResult }`; `createAgentSessionRuntime()` for the cwd-bound wrapper | `PiAdapter` construction |
| Turn | `session.prompt(text, { images, streamingBehavior, source })` | `AgentQuery.query()` |
| Stream | `session.subscribe(listener) → unsubscribe`. `AgentSessionEvent` = core `AgentEvent` (`agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`) **plus** `queue_update`, `compaction_start/end`, `auto_retry_start/end`, `session_info_changed`, `thinking_level_changed` | `AgentEvent` union |
| Permissions | extension `on("tool_call", handler)`; handler returns `{ block?: boolean, reason?: string }`. `ExtensionHandler` is `(event, ctx) => Promise<R \| void> \| R \| void` — **awaited**, so an async `canUseTool` fits | `ToolPermissionPolicy` + `canUseTool` |
| Built-in tools | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. **Default active set is `read, bash, edit, write`**; `tools` / `excludeTools` / `noTools: "all" \| "builtin"` narrow it | permission categorizer + `toolFormatting.ts` |
| Callboard tools | `customTools: ToolDefinition[]` on `createAgentSession`, typebox-schema'd, `defineTool()` helper — **in-process** | `buildToolServer` |
| Models | `ModelRegistry.create(authStorage, modelsJsonPath)` → `getAll()`, `getAvailable()`, `find(provider, modelId)`, `getProviderAuthStatus()`, `registerProvider()`. Offline-queryable | `supportedModels()`, model picker |
| Auth | `AuthStorage` with `FileAuthStorageBackend` **or `InMemoryAuthStorageBackend`**; `getEnvApiKey(provider)` reads `OPENROUTER_API_KEY` etc. | Settings → per-session credentials |
| OpenRouter | first-class provider in `@earendil-works/pi-ai` (`providers/openrouter.models.d.ts`, `thinkingFormat: "openrouter"`) | `piProviderId: "openrouter"` |
| Cost / usage | `SessionStats` (`tokens.{input,output,cacheRead,cacheWrite,total}`, `cost`), `session.getContextUsage()` | `TokenUsage` |
| History | JSONL, **public + versioned**: `CURRENT_SESSION_VERSION = 3`, `parseSessionEntries(content): FileEntry[]` (sync), `migrateSessionEntries`, `buildSessionContext`, `SessionInfo { path, id, cwd, name, parentSessionPath, created, modified, messageCount, firstMessage, allMessagesText }` | `SessionProvider` reads pi's own files |
| Fork | `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir, opts)`; `AgentSessionRuntime.fork(entryId, { position })`. Sessions are a **tree** (`parentId`, `getBranch`, `getTree`) | `forkSession` |
| Cancel | `session.abort()` then `session.dispose()` | `AgentQuery.close()` |
| Steering | `prompt(text, { streamingBehavior: "steer" \| "followUp" })` + `queue_update` events | mid-turn user messages |
| Effort | `thinkingLevel: off \| minimal \| low \| medium \| high \| xhigh` | Callboard `EffortLevel` |
| Skills / context | `loadSkills`, `Skill`, `parseSkillBlock`; `loadProjectContextFiles` reads **AGENTS.md and CLAUDE.md** natively | `custom-skills-service.ts` |
| Compaction | `compact()`, `shouldCompact()`, `DEFAULT_COMPACTION_SETTINGS` | automatic, no wiring |
| MCP | **none** — no `mcp` symbol anywhere in the shipped types. Ori bolts it on by materializing its own extension | see Decision 5 |

### The two traps to close first

**1. pi does not ask.** Same shape as Cline's default-auto-approve, confirmed the same way — by running it. Left alone, Callboard would render its four-axis permission UI over a harness that never prompts, the decorative-gate failure `acp/vendors.ts` documents as disqualifying. The gate is a `tool_call` handler that awaits `canUseTool` and returns `{ block: true, reason }`. It must be fail-closed: any tool name Callboard cannot categorize blocks rather than runs.

*As built:* installed through `resourceLoaderOptions.extensionFactories`, **not** `loadExtensionFromFactory` — that function exists in pi's `dist/` but is not re-exported, and the package's `exports` map refuses deep imports. And "fail-closed" resolved to the **strictest axis**, not `null`: `decidePermission(null, …)` returns `"ask"` unconditionally without consulting settings, which would hang an unattended job step on a prompt nobody answers. An uncategorizable name gets `codeExecution`, as the ACP and Cline categorizers already do.

**2. Project trust is arbitrary code execution, and it fires before any tool gate.** pi discovers project-local extensions, skills and prompt templates from the repo it opens (`hasTrustRequiringProjectResources`, `ProjectTrustStore`, `ProjectTrustEvent`, CLI `--approve/-a`). An extension is TypeScript that pi loads through jiti at session start — it runs *before* the first model call, so no `tool_call` handler can catch it. Callboard opens whatever repository the user points it at, including ones cloned by an agent. **The adapter must deny project trust by default**, and only project-local resources the user has explicitly trusted may load. This has no Cline analogue; it is the single most important line in the adapter.

*As built:* there is no `project_trust` handler, because that event is emitted by `resolveProjectTrusted()` and the SDK path never calls it — a handler would have been dead code that read like a working mitigation. The real denial is three settings on `createAgentSessionServices`: `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`, `resourceLoaderReloadOptions.resolveProjectTrust: async () => false`, and `resourceLoaderOptions.noExtensions: true`. `permissionAdapter.assertPiTrustDenied` and `projectTrust.test.ts` (with a control case, and a source guard against re-importing `createAgentSession`) are what keep them there.

## Design

**One new adapter kind, `"pi"`, 1:1 with the engine.** In-process like `cline` and `openrouter`, not a member of the ACP family. Files under `backend/src/agents/adapters/pi/`, mirroring the Cline layout.

**Decision 1 — Callboard reads pi's own sessions; no shadow transcript.** This is the deliberate divergence from `plans/cline-adapter.md`. Cline forced Callboard to own a transcript because its history API was async and its on-disk format undocumented and pre-1.0. Neither holds here: `parseSessionEntries(content)` is *synchronous and takes a string*, which is exactly the shape `SessionProvider`'s synchronous methods need, and the format is versioned with a migrator (`CURRENT_SESSION_VERSION = 3`, `migrateSessionEntries`). Point `SessionManager.create(cwd, sessionDir)` at `<DATA_DIR>/pi-sessions/` so `CALLBOARD_DATA_DIR` still moves everything, and read those files back. One store, not two — no drift between what pi resumes from and what Callboard renders. If the spike finds the format harder to consume than it reads, the Cline shadow-transcript pattern is the documented fallback; take it as a whole, not halfway.

**Decision 2 — fork and seed are native.** `SessionManager.forkFrom()` gives `forkSession` most of the way, and pi already models sessions as a tree with `parentSession` on the header. *(Corrected in Phase 2: `parentSession` holds a **file path**, not a session id, so the two lineages do not simply agree — Callboard owns a small translation step, `parentSessionIdOf()`. And `forkFrom` has no cutoff parameter, so the truncation is Callboard's too.)* `seedSession` writes a session file from neutral `HandoffTurn[]` (`backend/src/agents/handoff.ts`) — hand-written session state, the same technique the Claude, Codex and OpenRouter adapters already use for handoff. `parseSessionEntries` + `CURRENT_SESSION_VERSION` being exported is what makes the written shape checkable rather than reverse-engineered.

**Decision 3 — credentials never touch `~/.pi/agent/auth.json`.** Construct `AuthStorage` over `InMemoryAuthStorageBackend` seeded from `getAgentSettings()`. A Callboard chat must not mutate the user's global pi login, and two chats on different providers must not fight over one file. Same reasoning as `AcpAdapter` refusing to forward `options.env` wholesale.

**Decision 4 — `agentDir` is Callboard's, not `~/.pi/agent`.** Follows from 3, and keeps `models.json` caching and settings per-instance.

**Decision 5 — external MCP servers are out of scope for v1.** pi has no MCP client; Ori supplies one by materializing an extension that reads an `mcp.json`. Callboard's *own* tools do not need it — they ride in as `customTools`, in-process, with live backend state and no stdio shim (the thing `acp/mcp-server-shim.ts` and its Codex twin are forced into). What v1 gives up is the user's configured third-party MCP servers on pi chats. Land the adapter without them, note it in Settings, and treat a bridge extension as a follow-up.

## Phase 0 — Bring-up and pin

- Add `"@earendil-works/pi-coding-agent": "0.83.0"` to `backend/package.json` — **exact pin, no caret**, matching the `@cline/sdk: "0.0.69"` and `@agentclientprotocol/sdk: "1.3.0"` precedent.
- `engines.node` in the root `package.json` is `>=22`; pi requires `>=22.19.0`. Raise it or document the floor — a silent failure on 22.0 is worse than a refused install.
- Run `npm run deps:check` and `npm run publish:dry-run` early. pi is **13.1 MB unpacked with 18 dependencies**, including `@earendil-works/pi-tui`, `photon-node` (wasm image codec), `highlight.js` and `jiti`. That is a TUI stack landing in a server bundle; know the number before the landing, not after.
- Write a throwaway live harness (not committed) against a real OpenRouter key that answers, in order:
  1. Does `tool_call` fire for **every** tool — the four defaults, `grep`/`find`/`ls` when enabled, and `customTools` (`CustomToolCallEvent`) — and does returning `{block:true}` genuinely prevent execution and surface a usable message to the model?
  2. Does `project_trust` fire before extensions load, and does denying it actually stop project-local resources from loading?
  3. Where does usage/cost land — `message_end`, `turn_end`, or only `SessionStats`? Is it per-turn or cumulative?
  4. Does a hand-written session file (header + `SessionMessageEntry` chain at version 3) load, resume, and render?
  5. What do `abort()` and `dispose()` emit, and does `agent_end.willRetry` distinguish a cancel from a retry?
  6. `registerProvider()` vs `getEnvApiKey()` — the actual precedence for pointing pi at OpenRouter with an explicit key.
- Record answers in `plans/pi-spike-findings.md`, in the shape of `plans/cline-spike-findings.md`. Anything that contradicts the table above changes the adapter, not the plan's scope.

## Phase 1 — AgentProvider (execution)

New files under `backend/src/agents/adapters/pi/`:

- **`PiAdapter.ts`** — `AgentProvider` with `kind = "pi"`. Config-free construction; per-call config rides in on `AgentQueryRequest.options.pi`, populated by `claude.ts:sendMessage` from `getAgentSettings()`, alongside the existing OpenRouter/Codex/Cline blocks.
- **`PiAgentQuery.ts`** — bridges `session.subscribe()` (push) to `AsyncIterable<AgentEvent>` (pull) via a bounded queue. Follow `OpenRouterAgentQuery`/`ClineAgentQuery`: `query()` returns synchronously, async setup on first iteration, `close()` → `abort()` → `dispose()`.
- **`messageAdapter.ts`** — pi events → `AgentEvent`. `usage` → `TokenUsage` (`usage.cost.total` → `costUsd`, from `message_end`; `turn_end` carries none); `agent_end` with `willRetry: true` explicitly **not** terminal; `auto_retry_*` and `compaction_*` → `adapter_specific` so a long retry or compaction does not read as a dead chat (#317/#318).

  **As built, on tool timing.** `tool_use` is emitted from **`tool_execution_start`** and `tool_result` from `tool_execution_end`. Phase 1 originally deferred *both* to the end event, reasoning that `tool_execution_start` fires before the `tool_call` gate and would render a tool as running that was about to be denied. Phase 4 reversed that: `Chat.tsx` computes `isRunning` as `toolResult === null && streaming`, so a `tool_use` arriving alongside its result is never running — a long `bash` under pi rendered nothing at all, which is the #317/#318 dead-chat failure in a worse form than the OpenCode case that prompted the original fix. The denial worry turned out to be unfounded: `tool_execution_end` always follows a start, so the pair always closes, and Claude Code emits `tool_use` before calling `canUseTool` too. Emitting at the start event also removed the stateful arg-carrying the deferral required, since `tool_execution_end` carries no `args`.

  `message_update` deltas are dropped: callboard's `text` is a whole unit and the SSE layer does its own chunking. `tool_execution_update` rides through as `adapter_specific` — raw material for live tool output, unused by the UI today.
- **`optionsAdapter.ts`** — Callboard options → `CreateAgentSessionOptions`: `cwd`, `model` (via `ModelRegistry.find(provider, modelId)`), `thinkingLevel` from `EffortLevel`, `tools`/`excludeTools` from the permission axes, `customTools`, `agentDir`, `sessionManager`. Reuse `resolveSessionModel` from `services/agent-settings.ts` so per-chat models and cross-harness aliases resolve identically to Codex/ACP/Cline.
- **`permissionAdapter.ts`** — three parts:
  - `categorizePiToolName()` → `read`/`grep`/`find`/`ls` → `fileRead`; `edit`/`write` → `fileWrite`; `bash` → `codeExecution`; unknown → `null` (which the gate reads as *block*, not *allow*). Note there is **no built-in web tool**, so the `webAccess` axis governs nothing on pi until one is added — say so in the UI rather than showing an inert control.
  - `buildPermissionExtension(policy)` → an `ExtensionFactory` registering `tool_call` (await `canUseTool`, return `{block, reason}`) and `project_trust` (deny by default), installed with `loadExtensionFromFactory`.
  - `buildToolFilters(permissions)` → `tools`/`excludeTools` so a `deny` axis makes the tool invisible to the model rather than merely blocked at call time. Belt and braces, exactly as the Cline adapter does with `toolPolicies` + `requestToolApproval`.
- **`toolAdapter.ts`** — `ToolServerSpec` → pi `ToolDefinition[]` via `defineTool()`. One new impedance mismatch versus the Zod-shaped adapters: **pi schemas are typebox**, so this file owns Zod→typebox (or JSON-Schema→typebox) conversion. Flatten `ToolContentBlock[]` to `AgentToolResult`. No shim, no socket.
- **`modelCatalog.ts`** — `ModelRegistry.getAll()`/`getAvailable()`/`getProviderAuthStatus()`. Offline-queryable, so no harvesting from past sessions the way ACP needs.

## Phase 2 — SessionProvider (history, fork, handoff)

- **`sessionParser.ts`** — `parseSessionEntries` → `ParsedMessage[]`; first-user-message preview. Path-traversal guard on session ids (`isSafePathSegment`, as `acp/transcript.ts` does).
- **`PiSessionProvider.ts`** — `SessionProvider` with `kind = "pi"`, over `<DATA_DIR>/pi-sessions/`. Discovery/resolve/search/delete. Plus:
  - `forkSession(...)` → `SessionManager.forkFrom()` for the file and lineage, then a rewrite for the cutoff — `forkFrom` has no cutoff parameter and takes one source, while the port takes an array.
  - `seedSession(turns, { folder, newSessionId })` → write a version-3 session file from `HandoffTurn[]`, making pi a valid **target** for cross-harness handoff.
  - `resolvePiSessionsRoot()` as a **function**, not a module const, so a per-test `CALLBOARD_DATA_DIR` is honoured.

**Two corrections this phase applied, both measured against 0.83.0:**

- **`SessionInfo` is not reachable from a synchronous port.** This section originally read discovery/search "from `SessionInfo` (`allMessagesText` makes search cheap)". `SessionManager.list()` returns a **`Promise`**, and every `SessionProvider` method is synchronous, so `firstMessage` and `allMessagesText` are re-derived from `readFileSync` + `parseSessionEntries` instead. Decision 1 is unaffected — it rested on `parseSessionEntries` being sync, which it is. Search is not "cheap": it is linear in bytes on disk (measured: 6.8 ms for a 1.69 MB / 2,601-entry session, so ~1.4 s for an unscoped grep over 200 of them). `SessionManager.list()` would not have been cheaper; it reads and parses every file too.
- **Lineage needs a translation step.** Decision 2 claims callboard's chat lineage and pi's branch structure "agree instead of being reconciled". `SessionHeader.parentSession` is an absolute **file path**, not a session id, so `PiSessionProvider.parentSessionIdOf()` parses one out of the basename. One line, but real.

**Registration moved to Phase 3.** It was listed here, but `constructProvider` case `"pi"` and `getSessionProviders()` both require `AgentProviderKind` to include `"pi"` — and widening that union is Phase 3. Registering here would not compile. Phase 2 lands unreferenced, exactly as Phase 1 did.

## Phase 3 — Backend plumbing

Mechanical, and the exact set the Cline landing touched:

- `backend/src/agents/ports/AgentProvider.ts` — `"pi"` into `AgentProviderKind` and `ROUTABLE_PROVIDER_KINDS`; the exhaustiveness check in `constructProvider` finds anything missed.
- `backend/src/agents/permissions/categorizers.ts` — `TOOL_CATEGORIZERS.pi = categorizePiToolName` (the `Record<AgentProviderKind, …>` makes this a compile error until done), and extend the header comment's per-harness "does it really ask?" table.
- `backend/src/services/claude.ts` — a `providerKind === "pi"` settings block; pin `provider: "pi"` and `model` into new-chat metadata.
- `backend/src/routes/stream.ts` — add `"pi"` to the effort-capable provider checks (thinkingLevel).
- `backend/src/routes/pi.ts` (new) — `GET /api/pi/providers`, `GET /api/pi/models?providerId=…` off `ModelRegistry`, mirroring `routes/cline.ts`, with swagger annotations (`publish:dry-run` parses these — #303).
- `backend/src/index.ts` — mount `piRouter`.
- `backend/src/services/agent-settings.ts` — `resolveModel` case for `"pi"`.
- `backend/src/services/model-alias-tools.ts` — `pi` target in the alias schema.
- `backend/src/agents/factory.ts` — `constructProvider` case `"pi"` → `new PiAdapter()`, and push `new PiSessionProvider()` into `getSessionProviders()`. **Moved here from Phase 2**: both need `"pi"` in `AgentProviderKind`, which is widened in this phase.
- `shared/types/agentSettings.ts` — `piProviderId`, `piModel`, `piApiKey`, `piBaseUrl`, `piThinkingLevel`. Follow the Cline note: OpenRouter is a *value* of `piProviderId`, not a mode, so no `piUseOpenRouter` toggle.
- `shared/types/providers.ts` — `UiAgentProviderKind` += `"pi"`; `shared/types/modelAlias.ts` — `HARNESS_PROVIDERS` += `"pi"`.
- `backend/src/services/theme-variables.ts`, `theme-contrast-palette.ts`, `theme-contrast.ts` — register `--badge-provider-pi-bg` and its contrast expectation (`theme-contrast.test.ts` asserts a ratio per badge; a new badge without an entry fails the suite).
- Jobs/cron need no change — they route on `ProviderRunConfig`, which widens automatically.

**Wire compatibility.** No new `stream.ts` `type` value, so no capability gate. The one new enum value crossing the boundary is `provider: "pi"` on chat metadata, and `ProviderBadge` documents its fallback (anything unknown renders nothing), so an older tab degrades to an unbadged chat rather than dropping events. Re-run `shared/types/stream.test.ts`; if the snapshot moves, read the rules at the top of `shared/types/stream.ts` before regenerating.

## Phase 4 — Frontend

- `components/ProviderConfigPicker.tsx` — pi button, model sub-picker fed by `/api/pi/models`, effort control (pattern: the `codexControls`/`clineControls` blocks).
- `components/ProviderBadge.tsx` — `"PI"` tag; add `--badge-provider-pi-bg` to **both** `:root` and `[data-theme="light"]` in `frontend/src/index.css`.
- `components/toolFormatting.ts` — formatting for `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`, read off pi's shipped input types rather than guessed.
- `pages/settings/ApiSettings.tsx` — pi section (provider, key, base URL, default model), reference links, and an explicit note that third-party MCP servers do not apply to pi chats in v1.
- `pages/settings/ModelAliasesSettings.tsx` — pi column.
- `utils/localStorage.ts` — `KNOWN_PROVIDERS` += `"pi"`.

**As built, three departures.**

- **The model picker is a filtering combobox, not the Cline field.** `/api/pi/models` answers with ~300 models for OpenRouter, and the Cline `<input list>` + `<datalist>` is a scroll at that size. `PiModelSelector` reuses the `AcpModelSelector` shape (subsequence filter, capped at 50, keyboard nav) and *states* the cap — "Showing 50 of 303 — keep typing to narrow" — because silence reads as "that is all of them".
- **No thinking-level field in Settings.** Reasoning effort is per-chat for every harness (`ProviderRunConfig.effort`, persisted to chat metadata by `routes/stream.ts`) and no other provider keeps a settings-level default. Adding one only for pi would have shipped a field nothing reads. `piBaseUrl` was kept on the same principle but resolved the other way: it is *wired*, through `ModelRuntime.registerProvider`, rather than removed.
- **The `webAccess` axis carries a visible note.** pi ships no web tool, so the axis governs nothing on a pi chat. `PermissionSettings` takes an optional `provider` and says so under the row. An axis that silently does nothing is the decorative-gate failure in a different costume.

Three pre-existing gaps surfaced here, all affecting **Cline** as well as pi and all fixed: `Chat.tsx`'s `chatProvider` never handled `"cline"` (so a Cline chat's badge said **CC** and its status line said "Claude is thinking"); `handoff.ts`'s `PROVIDER_LABELS` had no `cline` entry; and `toolFormatting`'s lowercase file cases had to use the shared path probe rather than pi's `path` alone, or they would have shadowed OpenCode's camelCase `filePath` and regressed #318.

## Phase 5 — Tests

Unit tests beside each adapter file, mirroring the Cline/Codex suites: `messageAdapter.test.ts`, `permissionAdapter.test.ts` (**including the fail-closed unknown-tool case and the project-trust denial**), `toolAdapter.test.ts` (Zod→typebox), `optionsAdapter.test.ts`, `sessionParser.test.ts`, `PiSessionProvider.test.ts` (fork + seed round-trip through `parseSessionEntries`), `modelCatalog.test.ts`. Plus:

- A fake-pi fixture under `__fixtures__/`, as `cline/__fixtures__/fakeClineCore.ts` and `acp/__fixtures__/fake-acp-agent.ts` do, so the adapter runs without a network.
- `backend/src/agents/agents.integration.test.ts` — extend the cross-provider matrix.
- `PiAdapter.live.test.ts` — opt-in, real key, modelled on `AcpAdapter.opencode.live.test.ts` and `ClineAdapter`'s live path. This is the file that proves the gate is real.
- Guard: set `CALLBOARD_DATA_DIR` in every test that touches sessions — the ACP suite once wrote fake sessions into the developer's real chat list (#302).

**As built.**

- `fakePiSession.ts` stands in for the **session only**. `ModelRuntime`, `SessionManager` and the bundled catalog stay real, because `modelCatalog.test.ts` and `routes/pi.models.test.ts` exist to prove pi answers ~300 models offline with no key — a fixture that stubbed the catalog would delete the only evidence for that. This is the opposite balance from `fakeClineCore.ts`, which must replace the whole SDK because Cline persists under `~/.cline` with no public redirect.
- `PiAgentQuery.test.ts` drives the query end to end against the fixture with everything below the session real, including the trust denial and the permission extension.
- `handoff.roundtrip.test.ts` runs the route's own pipeline through the **real** pi *and* Cline providers — seed, read back, fork, read back — because a stub that returns `{ logPath }` proves the route calls `seedSession`, not that the file it wrote can be read.
- **`ForkProvider` admits `cline` and `pi`.** Both implement `forkSession` and `seedSession` and both round-trip; the union simply had never been widened, so Callboard had built cross-harness handoff into two harnesses and offered it into neither. ACP stays excluded, for the two reasons `ports/AgentProvider.ts` now spells out.

**Still unverified**, and listed as such rather than quietly asserted: a real `willRetry: true` (needs a provider 429/5xx on demand — the *handling* is covered by the fixture), `streamingBehavior: "steer"` (the adapter never sends it; `AgentQuery` has no mid-turn input surface), real compaction including the `overflow` reason (needs a filled 1M-token window), and two concurrent live chats on different keys. The per-query `ModelRuntime` that makes the last one safe *is* asserted.

## Verification

1. `npm run dev` (background, per project convention), new chat, pick **pi**, pick a model.
2. Flip each axis to `ask` and confirm the matching tool prompts — `read`, `edit`/`write`, `bash`. Set an axis to `deny` and confirm the tool is invisible to the model. **A turn that runs `bash` with no prompt is a failed gate, not a passing test.**
3. Open a chat on a repo containing a project-local pi extension and confirm it does **not** load untrusted.
4. Confirm a Callboard MCP tool (e.g. `set_chat_title`) is callable from a pi chat and mutates real backend state.
5. Cancel mid-turn; confirm the session stops and the chat is not left "in progress" (#313/#318). Separately confirm an `auto_retry` does not read as a dead chat.
6. Send a follow-up mid-turn and confirm `streamingBehavior: "steer"` lands.
7. Reload the page and confirm the transcript renders from pi's own session file.
8. Fork a pi chat; hand off a Claude Code chat *into* pi and confirm the new chat has context on its first reply.
9. Confirm cost appears on the chat (parity with #312), and that a job/cron step with `provider: "pi"` runs.
10. `npm run lint:all`, full `vitest` including `shared/types/stream.test.ts` and `theme-contrast.test.ts`, then `npm run deps:check`.

## Risks

- **Fast-moving 0.x dependency.** 38 versions published; 0.80 → 0.83 inside the window this plan was written. Pinned exactly, and every type touch point sits behind `messageAdapter`/`optionsAdapter`/`sessionParser` so a bump is a contained edit.
- **Session-format API is semi-public.** `parseSessionEntries`, `migrateSessionEntries` and `loadEntriesFromFile` are annotated *"Exported for testing"* even though the entry types and `CURRENT_SESSION_VERSION` are first-class. Decision 1 rests on them. Mitigation: the round-trip test in Phase 5 fails loudly on a bump, and the Cline shadow-transcript pattern is the documented fallback.
- **Default-permissive tools + project trust.** Both addressed above; both are what the live test exists to prove.
- **No MCP.** Scoped out explicitly rather than half-delivered — see Decision 5.
- **Bundle weight.** 13.1 MB and a TUI/wasm dependency tail in a server process. Measured in Phase 0, not discovered at publish.
- **Ori coupling is zero by design.** Callboard depends on the pi npm package, not on Ori, not on `~/.ori/pi-runtime`. If OpenRouter changes what Ori bundles, nothing here moves.

## Sources

- [`@earendil-works/pi-coding-agent` on npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) · [earendil-works/pi](https://github.com/earendil-works/pi)
- Shipped type declarations, 0.80.2: `dist/index.d.ts`, `dist/core/sdk.d.ts`, `dist/core/agent-session.d.ts`, `dist/core/agent-session-runtime.d.ts`, `dist/core/session-manager.d.ts`, `dist/core/extensions/{types,loader}.d.ts`, `dist/core/model-registry.d.ts`, and `@earendil-works/pi-agent-core/dist/types.d.ts`
- [Ori Harness](https://openrouter.ai/docs/guides/ori/harness) · [Where Ori writes files](https://openrouter.ai/docs/guides/ori/files) — context for why the adapter targets pi rather than Ori
- Prior art in this repo: `plans/cline-adapter.md`, `plans/cline-spike-findings.md`, `plans/acp-adapter.md`, `plans/codex-adapter.md`
