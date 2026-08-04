# Cline SDK as a native Callboard agent provider

> **Read `plans/cline-spike-findings.md` first.** It records the *shipped type
> declarations* of `@cline/sdk` 0.0.69, which correct several assumptions below
> (lifecycle mapping, the two-layer event stream, a tenth built-in tool,
> per-turn tool policies). The scope and phasing here still stand; specific
> lines in the adapter files do not.

## Context

Callboard runs chats through four harnesses today — Claude Code, OpenRouter, Codex, and the ACP family (OpenCode). Each is an implementation of the two ports in `backend/src/agents/ports/`: `AgentProvider` (execution) and `SessionProvider` (discovery/history). Adding a harness is a well-worn path, not new architecture.

Cline shipped `@cline/sdk` (v0.0.69, Apache-2.0, Node ≥22) — the same runtime behind its VS Code extension, CLI and Kanban, extracted as an embeddable TypeScript library. It is the first non-Anthropic harness that is *simultaneously* in-process (like the OpenRouter harness) and a full coding agent with its own built-in tool suite, session persistence, checkpoints, plugins, subagents and scheduling (like Claude Code). That combination is what makes it worth a native adapter rather than a vendor preset.

Cline also speaks ACP (`cline --acp`), which Callboard could have adopted as a data-only preset in `acp/vendors.ts` for a fraction of the cost. We are deliberately not doing that. The SDK path buys three things the ACP path cannot: (1) **no Cline account** — the SDK takes raw provider keys (Anthropic/OpenAI/Google/Bedrock/Mistral/OpenAI-compatible) whereas `cline --acp` wants `cline auth` or `CLINE_API_KEY`; (2) **in-process Callboard tools** — no MCP stdio shim and private socket, the way `acp/mcp-server-shim.ts` and its Codex twin are forced to work; (3) **a real permission gate and real forking**, because `Agent` accepts `initialMessages` and `restore(messages)`, so Callboard can both seed and fork a Cline conversation — the two things `AcpSessionProvider` documents as impossible over the wire.

Target is **full parity**: the adapter ships with permissions, tools, models, cost, cancel, resume, transcript, search, `forkSession`, `seedSession` (cross-harness handoff), model aliases, job/cron routing, and the API + Model Aliases settings pages — one landing.

## What we know about `@cline/sdk` (verified from docs + npm)

| Concern | Cline SDK surface | Maps to |
|---|---|---|
| Entry | `ClineCore.create({ clientName, backendMode: "local", capabilities, toolPolicies })` | `ClineAdapter` construction |
| Turn | `start({ prompt, config })` → `{ sessionId, manifest }`; `send()` to continue | `AgentQuery.query()` |
| Stream | `subscribe()` → `content_start` / `content_update` / `content_end` / `iteration_start` / `iteration_end` / `usage` / `notice` / `done` / `error` (`CoreSessionEvent` adds `sessionId`) | `AgentEvent` union |
| Permissions | `toolPolicies: { [tool]: { enabled?, autoApprove? } }` **plus** `capabilities.requestToolApproval(req) → { approved }` | `ToolPermissionPolicy` + `canUseTool` |
| Built-in tools | `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit` | permission categorizer + `toolFormatting.ts` |
| Callboard tools | `config.extraTools` (or an `AgentPlugin` with `api.registerTool`) — in-process | `buildToolServer` |
| Models | `DefaultGateway().listProviders()` / `getModelsForProvider()` from `@cline/llms` | `supportedModels()`, model picker |
| Cost | `usage` event: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost`, cumulative; `getAccumulatedUsage()` | `TokenUsage` |
| History | `initialMessages` seeds, `restore(messages)` replaces, `readMessages()` reads | `forkSession` / `seedSession` |
| Cancel | `abort()` / `stop()` / `dispose()` | `AgentQuery.close()` |

**The trap to close first.** Cline's docs state: *"Tool names not listed in `toolPolicies` default to enabled and auto-approved."* Left alone, Callboard would render its four-axis permission UI over a harness that never asks — exactly the decorative-gate failure `acp/vendors.ts` documents as disqualifying. The adapter must therefore enumerate policies explicitly **and** install `requestToolApproval` as a fail-closed backstop, so a tool name Callboard has never seen prompts rather than runs.

## Design

**One new adapter kind, `"cline"`, 1:1 with the engine** — not a member of the ACP family. Files mirror the Codex/ACP layout under `backend/src/agents/adapters/cline/`.

**Callboard owns the transcript.** `SessionProvider`'s methods are all *synchronous* (`discoverSessions`, `parseSessionMessages`, `searchSessions`…) while ClineCore's history API (`readMessages`, `listHistory`) is async, and its on-disk format is undocumented and pre-1.0. So the adapter appends already-normalized `AgentEvent`s to `<DATA_DIR>/cline-sessions/<sessionId>.jsonl`, exactly as `adapters/acp/transcript.ts` does and for the same reasons — reading stays independent of the SDK pin, and `CALLBOARD_DATA_DIR` moves it. ClineCore's own store remains the engine's resume state; Callboard's transcript is the render/search state.

**Fork and seed are implementable here** (unlike ACP) because `initialMessages` / `restore(messages)` let Callboard hand Cline a conversation it did not have. `forkSession` truncates the Callboard transcript at the cutoff; `seedSession` writes a transcript from `HandoffTurn[]` (`backend/src/agents/handoff.ts`) and the adapter replays it into `initialMessages` on the next turn.

## Phase 0 — Bring-up and pin

- Add `"@cline/sdk": "0.0.69"` to `backend/package.json` — **exact pin, no caret**, matching the `@agentclientprotocol/sdk: "1.3.0"` precedent. Pre-1.0 packages move.
- Write a throwaway live harness (not committed) against a real Anthropic key that answers, in order: does `requestToolApproval` fire for *every* built-in tool including `run_commands` inside subagents; what `CoreSessionConfig` actually accepts (`cwd`, `env`, `maxIterations`, `extraTools`, MCP enablement); where ClineCore persists; whether `send()` accepts streaming/mid-turn input; what `done`/`error` look like on abort.
- Record answers in `plans/cline-spike-findings.md`, in the shape of `plans/codex-spike-findings.md`. Any answer that contradicts the table above changes the adapter, not the plan's scope.

## Phase 1 — AgentProvider (execution)

New files under `backend/src/agents/adapters/cline/`:

- **`ClineAdapter.ts`** — `AgentProvider` with `kind = "cline"`. Config-free construction; per-call config rides in on `AgentQueryRequest.options.cline`, populated by `claude.ts:sendMessage` from `getAgentSettings()`, same as the OpenRouter/Codex blocks around `claude.ts:1480–1580`.
- **`ClineAgentQuery.ts`** — bridges `ClineCore.subscribe()` (push) to `AsyncIterable<AgentEvent>` (pull) via a bounded queue. Follow `OpenRouterAgentQuery`'s deferred-construction pattern: `query()` returns synchronously, async setup happens on first iteration, and `close()` aborts whatever exists (`abort()` → `dispose()`).
- **`messageAdapter.ts`** — Cline events → `AgentEvent`. `content_start/update/end` split by content kind into `text` / `thinking` / `tool_use` / `tool_result`; `usage` → `TokenUsage` (`cost` → `costUsd`); `done.reason` → `AgentResultStatus` (`completed`→`success`, `max_iterations`→`max_turns`, everything else →`error` with `reason`); `notice` → `adapter_specific`.
- **`optionsAdapter.ts`** — Callboard options → `CoreSessionConfig`: provider id, model, apiKey/baseUrl, `cwd`, `maxIterations`, `extraTools`. Reuse `resolveSessionModel` from `services/agent-settings.ts` so per-chat model and cross-harness aliases resolve the same way they do for Codex/ACP.
- **`permissionAdapter.ts`** — two halves, both required:
  - `categorizeClineToolName()` → `read_files`/`search_codebase`→`fileRead`; `editor`/`apply_patch`→`fileWrite`; `run_commands`/`skills`→`codeExecution`; `fetch_web_content`→`webAccess`; `ask_question`/`submit_and_exit`→`null`.
  - `buildToolPolicies(permissions)` → an **explicit, exhaustive** `toolPolicies` map (`autoApprove` only where the axis says `allow`, `enabled:false` where it says `deny`), plus a `requestToolApproval` bridge that consults the live `ToolPermissionPolicy` and returns `{approved:false}` for any unrecognised name.
- **`toolAdapter.ts`** — `ToolServerSpec` → Cline `AgentTool[]`. Same two impedance mismatches `openrouter/toolAdapter.ts` already solves: wrap `ZodRawShape` in `z.object()`, and flatten `ToolContentBlock[]` to Cline's result shape. **No shim, no socket** — handlers keep live backend state because everything is in one process.
- **`modelCatalog.ts`** — `DefaultGateway.listProviders()` + `getModelsForProvider()`. Unlike ACP, no harvesting from past sessions is needed; the catalog is queryable offline.

## Phase 2 — SessionProvider (history, fork, handoff)

- **`transcript.ts`** — append-only JSONL at `<DATA_DIR>/cline-sessions/<sessionId>.jsonl`, header line carrying `cwd`. Copy the *shape* of `acp/transcript.ts`, including `resolveClineSessionsRoot()` as a **function** (not a module const) so `CALLBOARD_DATA_DIR` set per-test is honoured.
- **`sessionParser.ts`** — transcript → `ParsedMessage[]`; first-user-message preview.
- **`ClineSessionProvider.ts`** — `SessionProvider` with `kind = "cline"`. Discovery/resolve/search/delete follow `AcpSessionProvider` closely, including its `isSafePathSegment` path-traversal guard. Additionally implements:
  - `forkSession(sessionIds, cutoffTimestamp, newSessionId)` — copy transcript lines at/before the cutoff into a new file.
  - `seedSession(turns, { folder, newSessionId })` — write a transcript from neutral `HandoffTurn[]`; the adapter replays it as `initialMessages`. This is what makes Cline a valid *target* for cross-harness handoff.
- Register in `factory.ts`: `constructProvider` case `"cline"` → `new ClineAdapter()`, and push `new ClineSessionProvider()` into `getSessionProviders()`.

## Phase 3 — Backend plumbing

Each of these is a named, mechanical edit — the OpenCode landing (#307/#308/#311/#315) touched the same set:

- `backend/src/agents/ports/AgentProvider.ts` — add `"cline"` to `AgentProviderKind` and `ROUTABLE_PROVIDER_KINDS` (the exhaustiveness check in `constructProvider` will point at anything missed).
- `backend/src/agents/permissions/categorizers.ts` — `TOOL_CATEGORIZERS.cline = categorizeClineToolName`. The `Record<AgentProviderKind, …>` makes this a compile error until done.
- `backend/src/services/claude.ts` — a `providerKind === "cline"` settings block alongside the existing OpenRouter/Codex ones; pin `provider: "cline"` and `model` into new-chat metadata around lines 1046–1066.
- `backend/src/routes/stream.ts` — admit `provider: "cline"` (covered by `isRoutableProvider`).
- `backend/src/routes/cline.ts` (new) — `GET /api/cline/models`, mirroring `routes/acp.ts` but backed by the gateway rather than a harvested catalog, with swagger annotations (`publish:dry-run` parses these — see #303).
- `backend/src/services/agent-settings.ts` — `resolveModel` case for `"cline"`.
- `shared/types/agentSettings.ts` — `clineProviderId`, `clineModel`, `clineApiKey`, `clineBaseUrl`, `clineMaxIterations`, plus `clineUseOpenRouter` / `clineOpenRouterApiKey` / `clineOpenRouterModel` following the `codex*` pattern (Cline reaches OpenRouter through its `openai-compatible` provider + `baseUrl`).
- `shared/types/providers.ts` — `UiAgentProviderKind` += `"cline"`; `shared/types/modelAlias.ts` — `HARNESS_PROVIDERS` += `"cline"`.
- Jobs/cron need no change: they route on `ProviderRunConfig`, which widens automatically.

**Wire compatibility.** No new `stream.ts` `type` value is introduced, so no capability gate is needed. The one new enum value crossing the boundary is `provider: "cline"` on chat metadata, and `ProviderBadge` already documents its fallback ("anything else … renders nothing"), so an older tab degrades to an unbadged chat rather than dropping events. Re-run `shared/types/stream.test.ts`; if the snapshot moves, read the rules at the top of `shared/types/stream.ts` before regenerating.

## Phase 4 — Frontend

- `components/ProviderConfigPicker.tsx` — Cline button + model sub-picker fed by `/api/cline/models` (pattern: the `codexControls` / `acpControls` blocks).
- `components/ProviderBadge.tsx` — `"CL"` tag; add `--badge-provider-cline-bg` to **both** `:root` and `[data-theme="light"]` in `frontend/src/index.css`.
- `components/toolFormatting.ts` — display formatting for Cline's nine built-in tool names, so `run_commands` renders like `Bash` does rather than as a raw key.
- `pages/settings/ApiSettings.tsx` — Cline section (provider, key, base URL, default model, max iterations, OpenRouter toggle).
- `pages/settings/ModelAliasesSettings.tsx` — Cline column.
- `utils/localStorage.ts` — last-used provider includes `"cline"`.

## Phase 5 — Tests

Unit tests beside each adapter file, mirroring the Codex/ACP suites: `messageAdapter.test.ts`, `permissionAdapter.test.ts` (**including the fail-closed unknown-tool case**), `toolAdapter.test.ts`, `optionsAdapter.test.ts`, `sessionParser.test.ts`, `transcript.test.ts`, `ClineSessionProvider.test.ts` (fork + seed), `modelCatalog.test.ts`. Plus:

- A fake-Cline fixture under `__fixtures__/` so the adapter is exercised without a network, as `acp/__fixtures__/fake-acp-agent.ts` does.
- `backend/src/agents/agents.integration.test.ts` — extend the cross-provider matrix.
- `ClineAdapter.live.test.ts` — opt-in, real key, modelled on `AcpAdapter.opencode.live.test.ts`. This is the file that proves the permission gate is real; the OpenCode landing found several defects only a live agent could expose.
- Guard: the ACP suite once wrote fake sessions into the developer's real chat list (#302) — set `CALLBOARD_DATA_DIR` in every test that touches the transcript.

## Verification

1. `npm run dev` (background, per project convention), open a new chat, pick **Cline**, pick a model.
2. Flip each permission axis to `ask` and confirm the matching tool prompts — `read_files`, `editor`, `run_commands`, `fetch_web_content`. Set an axis to `deny` and confirm the tool is invisible to the model. **A turn that runs `run_commands` with no prompt is a failed gate, not a passing test.**
3. Confirm a Callboard MCP tool (e.g. `set_chat_title`) is callable from a Cline chat and mutates real backend state.
4. Cancel mid-turn; confirm the process stops and the chat is not left "in progress" (the failure mode of #313/#318).
5. Send a follow-up to confirm resume; reload the page to confirm the transcript renders from disk.
6. Fork a Cline chat; hand off a Claude Code chat *into* Cline and confirm the new chat has context on its first reply.
7. Confirm cost appears on the chat (parity with #312), and that a job/cron step with `provider: "cline"` runs.
8. `npm run lint:all` and the full `vitest` run, including `shared/types/stream.test.ts`.

## Risks

- **Pre-1.0 dependency.** `@cline/sdk` is at 0.0.69. Pinned exactly; every event/type touch point is behind `messageAdapter`/`optionsAdapter` so a bump is a contained edit.
- **Default auto-approve.** Addressed above, and it is the single thing the live test exists to prove.
- **Undocumented persistence.** Sidestepped by owning the transcript; ClineCore's store is treated as opaque engine state.
- **`backendMode`.** `"local"` explicitly, never `"auto"` — `"auto"` prefers a local hub, which would silently move execution off-process and out from under Callboard's tool and permission wiring.

## Sources

- [Cline SDK overview](https://docs.cline.bot/sdk/overview) · [ClineCore](https://docs.cline.bot/sdk/clinecore) · [Agent reference](https://docs.cline.bot/sdk/reference/agent) · [Events](https://docs.cline.bot/sdk/reference/events) · [Tools](https://docs.cline.bot/sdk/tools) · [Permission handling](https://docs.cline.bot/sdk/guides/permission-handling) · [Model providers](https://docs.cline.bot/sdk/model-providers) · [ACP mode](https://docs.cline.bot/usage/acp)
- [`@cline/sdk` on npm](https://www.npmjs.com/package/@cline/sdk) · [cline/cline](https://github.com/cline/cline)
