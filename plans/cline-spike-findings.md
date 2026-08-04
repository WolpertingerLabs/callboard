# Cline SDK spike findings

Read against the **shipped type declarations** of `@cline/sdk` / `@cline/core` /
`@cline/shared` **0.0.69**, not the published docs. Where the two disagree, this
file is the one to trust — several of the docs' summaries are one layer off from
the real surface.

Companion to `plans/cline-adapter.md`. Everything here is a fact about the
package; the adapter design that follows from it lives in the plan.

---

## 1. The event stream is two layers, not one

`ClineCore.subscribe(listener)` yields **`CoreSessionEvent`**, a wrapper union
(`core/dist/types/events.d.ts`):

```ts
type CoreSessionEvent =
  | { type: "chunk";                   payload: SessionChunkEvent }
  | { type: "agent_event";             payload: { sessionId, event: AgentEvent, teamAgentId?, teamRole?: "lead" | "teammate" } }
  | { type: "team_progress";           payload: SessionTeamProgressEvent }
  | { type: "pending_prompts";         payload: SessionPendingPromptsEvent }
  | { type: "pending_prompt_submitted"; payload: SessionPendingPromptSubmittedEvent }
  | { type: "session_snapshot";        payload: SessionSnapshotEvent }
  | { type: "ended";                   payload: SessionEndedEvent }
  | { type: "hook";                    payload: SessionToolEvent }
  | { type: "status";                  payload: { sessionId, status: string } };
```

The stream the docs describe is the **inner** `AgentEvent` from `@cline/shared`
(`shared/dist/agents/types.d.ts:28`), reached via `agent_event.payload.event`:

```ts
type AgentEvent =
  | AgentContentStartEvent | AgentContentUpdateEvent | AgentContentEndEvent
  | AgentIterationStartEvent | AgentIterationEndEvent
  | AgentNoticeEvent | AgentUsageEvent | AgentDoneEvent | AgentErrorEvent;
```

Consequences for `messageAdapter`:

- **One subscription is process-wide.** `subscribe()` hangs off `ClineCore`, not
  off a session, and every payload carries `sessionId`. The adapter must filter
  by its own session id — two concurrent Callboard chats otherwise cross-feed.
- **Content is discriminated by `contentType: "text" | "reasoning" | "tool"`**,
  not by event type. So `text` ← `content_*` with `contentType:"text"`,
  `thinking` ← `"reasoning"`, and `tool_use`/`tool_result` are the *start* and
  *end* of `"tool"`. `content_end` for a tool carries `output`, `error` and
  `durationMs` — everything `AgentEvent.tool_result` needs, `isError` included.
- **Subagents are labelled, not separated.** `teamAgentId` / `teamRole` ride on
  the wrapper, and `parentAgentId` on the inner event. Subagent traffic arrives
  interleaved on the same subscription.

## 2. The auto-approve trap is real, and it is in the types

`shared/dist/llms/tools.d.ts`:

```ts
export interface ToolPolicy {
  /** @default true */ enabled?: boolean;
  /** @default true */ autoApprove?: boolean;
}
```

Both default `true`. An unlisted tool is enabled and auto-approved — confirming
the docs' warning at the type level. The gate:

```ts
export interface RuntimeCapabilities {
  toolExecutors?: Partial<ToolExecutors>;
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalResult> | ToolApprovalResult;
}
```

`ToolApprovalRequest` carries `sessionId`, `agentId`, `conversationId`,
`iteration`, `toolCallId`, `toolName`, `input`, and the resolved `policy`.
`ToolApprovalResult` is `{ approved: boolean; reason?: string }`.

**Better than the plan assumed:** both `capabilities` and `toolPolicies` exist on
`StartSessionInput` as well as on `ClineCoreOptions`. Per-start wins, so the
policy map is rebuilt from the live permission axes **per turn** rather than
frozen at construction — closing the "policy baked in at spawn time" gap that
`acp/vendors.ts` documents as an accepted cost for OpenCode and that
`optionsAdapter` accepts for Codex. Callboard's Cline gate reads the axes at
decision time, like Claude Code's.

## 3. Ten built-in tools, not nine

Confirmed by scanning `@cline/core/dist/index.js`:

```
apply_patch  ask_question  editor      fetch_web_content  read_files
run_commands search_codebase  skills   spawn_agent        submit_and_exit
```

`spawn_agent` does **not** appear in the docs' tool table. It spawns subagents,
so it must be categorized deliberately rather than fall through the categorizer
to `null` (which `decidePermission` reads as `ask`, but which would also mean no
axis governs delegation).

## 4. Session config — what we can and cannot set

`CoreSessionConfig` (`core/dist/types/config.d.ts`) is large. The fields that
matter here:

| Field | Note |
|---|---|
| `sessionId?: string` | **Callboard can supply its own id.** "When provided, this becomes the host-owned id for persistence, hub subscriptions, send/abort/stop, and approval routing." Transcript keying becomes trivial — no id translation table. |
| `systemPrompt: string` | **Required.** `getClineDefaultSystemPrompt` (alias of `buildClineSystemPrompt`) is exported from `@cline/sdk` for the default. |
| `extraTools?: AgentTool[]` | In-process Callboard tools. Confirms no MCP shim is needed. |
| `cwd?` / `workspaceRoot?` | `ClineCoreStartConfig` makes `cwd` optional; omitting **both** assigns a shared chat workspace, which is not what a Callboard chat wants. Always set `cwd`. |
| `enableTools`, `enableSpawnAgent`, `enableAgentTeams` | Required booleans on `CoreRuntimeFeatures`. |
| `yolo?: boolean` | Exists. Must never be set true — it is the permission bypass. |
| `toolPolicies?: Record<string, ToolPolicy>` | Also settable here (via `SessionExecutionConfig`). |
| `checkpoint?: { enabled?: boolean }` | **Opt-in, defaults to `false`.** The git stash/ref snapshot. |
| `compaction?`, `skills?`, `pluginPaths?`, `extensions?`, `hooks?` | Available; out of scope for the first landing. |
| `apiKey`, `baseUrl`, `headers`, `providerId`, `modelId` | On `CoreModelConfig`. `baseUrl` is how OpenRouter is reached, via an OpenAI-compatible provider. |
| `thinking`, `reasoningEffort`, `thinkingBudgetTokens` | Reasoning knobs exist — so Callboard's `effort` axis *can* be wired for Cline, unlike the plan's assumption that it could not. |

## 5. Lifecycle — `abort` ≠ `stop` ≠ `dispose`

From `ClineCore.d.ts`, and this distinction is load-bearing:

- `abort(sessionId)` — "Aborts an in-flight tool execution **without stopping the
  session**." The session stays alive and can continue.
- `stop(sessionId)` — ends the session; it "cannot be resumed after stopping".
- `dispose()` — tears down the **whole ClineCore instance**, every session with
  it. "After calling dispose, the instance cannot be reused."

So the plan's `close() → abort() → dispose()` is wrong twice. Correct mapping:

- `AgentQuery.close()` → `stop(sessionId)`.
- A user pressing stop mid-tool → `abort(sessionId)`.
- **One `ClineCore` per process**, memoized like the other adapters, disposed
  only at backend shutdown. A per-query instance would make `dispose()` kill
  every other live Cline chat.

## 6. History, fork and handoff are all reachable

- `StartSessionInput.initialMessages?: Message[]` — seeding confirmed, so
  `seedSession` (cross-harness handoff *into* Cline) works.
- `readMessages(sessionId)` / `readLiveMessages(sessionId)` → `Message[]`. The
  live variant matters: "the persisted transcript only catches up at
  assistant-message/turn boundaries, so `readMessages` can miss an in-flight (or
  just-aborted) turn."
- `restore({ sessionId, checkpointRunCount, start?, restore? })` is a **native
  fork**: it starts a new session forked and trimmed to a checkpoint, optionally
  also rolling back workspace files from the git snapshot. Requires
  `checkpoint.enabled = true` at start.
- `start()` returns `{ sessionId, manifest, manifestPath, messagesPath }` — the
  on-disk artifact paths are handed back, so Cline's own store is *locatable*.

## 7. Storage is not relocatable through a public option

There is no public "data dir" option. `ClineCoreOptions.sessionService?:
SessionBackend` can replace persistence wholesale but is marked `@internal`.
Cline writes under the user's `~/.cline`, and `distinctId` defaults to a machine
id persisted at `~/.cline/data/machine-id`.

This **confirms the plan's decision** to own the transcript rather than read
Cline's: `SessionProvider`'s methods are synchronous while every Cline read is
async, the format is undocumented and pre-1.0, and the location cannot be moved
under `CALLBOARD_DATA_DIR` for tests. Two follow-on consequences to accept
openly:

1. Cline sessions accumulate in `~/.cline` alongside the user's own Cline usage.
   `ClineSessionProvider.deleteSessionFiles` should call `cline.delete(sessionId)`
   as well as removing Callboard's transcript, or deleting a chat leaks state.
2. Tests must not touch the real `~/.cline`. The fake-Cline fixture has to stand
   in for `ClineCore` itself, not merely for the network.

## 7a. OpenRouter is a first-class provider (docs say otherwise)

`docs.cline.bot/sdk/model-providers` lists six providers — Anthropic, OpenAI,
Google, AWS Bedrock, Mistral, OpenAI-compatible — and makes "no mention of
[…] supporting OpenRouter". The plan was written against that and routed
OpenRouter through `openai-compatible` + a base URL.

The installed SDK disagrees. `BUILT_IN_PROVIDER_IDS` returns **190+ ids**, and
`getLocalProviderModels("openrouter")` answers with **270 models**. Measured
against 0.0.69 through `GET /api/cline/providers` and `/api/cline/models`, not
inferred:

```
$ curl .../api/cline/providers
{"providers":["anthropic","claude-code","cline","openai-compatible","openai-native",
  "openai-codex","opencode","bedrock","vertex","gemini","ollama","lmstudio","deepseek",
  "xai","together","fireworks","groq","cerebras","mistral","moonshot","openrouter", …]}
```

So Cline needs **no `clineUseOpenRouter` toggle** of the kind Codex and ACP have.
Those exist because routing those harnesses means rewriting a config file or
injecting an environment variable; here OpenRouter is just a value of
`clineProviderId` with its key in `clineApiKey`. The base-URL field stays, for
self-hosted and OpenAI-compatible endpoints, but it is not the OpenRouter route.

The general lesson for the next bump: **the published provider list is a subset
of the shipped one.** `routes/cline.ts` serves the SDK's own list rather than a
table for exactly this reason.

## 8. Corrections this makes to `plans/cline-adapter.md`

| Plan said | Reality |
|---|---|
| `close()` → `abort()` then `dispose()` | → `stop(sessionId)`; `dispose()` is instance-wide, one instance per process |
| Events are a single flat union | Two layers; unwrap `agent_event`, filter by `sessionId` |
| Nine built-in tools | Ten — `spawn_agent` is undocumented |
| `toolPolicies` fixed at construction | Also per-`start()`, so the gate reads live axes per turn |
| No effort/reasoning knob for Cline | `thinking` / `reasoningEffort` / `thinkingBudgetTokens` exist |
| `usage` maps straight to `TokenUsage` | Also has `aggregateUsage` (includes subagents) via `getAccumulatedUsage`; pick deliberately |
| `systemPrompt` unmentioned | Required field; use the exported `getClineDefaultSystemPrompt` |

None of these change the plan's scope or phasing — they change specific lines in
`ClineAgentQuery`, `messageAdapter`, `optionsAdapter` and `permissionAdapter`.

## 9. The prompt is not a string (found by running it)

The adapter's first cut treated a non-string `AgentQueryRequest.prompt` as a
caller error and threw. The first real chat through `POST /api/chats/new/message`
disproved that in one line:

```
data: {"type":"message_error","content":"Cline adapter requires a string prompt;
        streaming-input mode is not supported by ClineCore.send()"}
```

Everything upstream was correct — the settings block ran, the provider resolved,
the model was pinned into metadata — and the turn still could not start.
`services/claude.ts` sends the Claude-SDK streaming form
(`AsyncIterable<SDKUserMessage>`) for multimodal input **and whenever MCP servers
are present**, which for callboard is nearly always. So the streaming form is the
normal path, not an edge case.

`promptAdapter.ts` now flattens it, splitting text from images because
`StartSessionInput` / `SendSessionInput` take `prompt: string` beside a separate
`userImages: string[]`. Same job `acp/AcpAgentQuery.resolveAcpPrompt` does for
ACP — which is where the shape should have been read from in the first place.

**The lesson worth keeping:** every claim in §1–§8 came from type declarations,
and the types were right about everything they described. This one was about a
*caller* the types say nothing about, and only running the thing found it.

## 10. Verified end to end (no credential needed)

Against a real backend on a scratch data dir:

- `GET /api/cline/providers` → 190+ ids from the SDK.
- `GET /api/cline/models?providerId=anthropic` → the live catalog; `openrouter`
  → 270 models. Missing `providerId` → 400.
- `POST /api/chats/new/message` with `provider: "cline"` → chat created with
  `{"provider":"cline","model":"claude-haiku-4-5"}` in metadata, prompt
  flattened, transcript written to
  `<DATA_DIR>/cline-sessions/<chatId>.jsonl` with header, `user_message`,
  `session_started` and a terminal `result`.
- With no key configured, the turn ends with Cline's own provider error
  (`"Anthropic API key is missing…"`) surfaced as `message_error` — which is the
  designed behaviour: no pre-flight check, the provider's own message reaches
  the user.

## 11. Still unverified (needs a live model credential)

Neither the type declarations nor a keyless run can answer these. They are what
`ClineAdapter.live.test.ts` is for:

1. Does `requestToolApproval` actually fire for **every** built-in tool,
   including inside a `spawn_agent` subagent? (The OpenCode landing found
   exactly this class of bug — a child session whose permission requests never
   reached the wire. It is the single most important thing left to prove, since
   a gate that does not fire is worse than no gate.)
2. Does `enabled: false` remove a tool from the model's tool list, or does the
   model still call it and get an error?
3. What `done` / `ended` / `error` sequence follows `abort()` vs `stop()`?
4. Does `send()` with `delivery: "steer"` interrupt an in-flight turn?
5. Real token/cost accuracy of the `usage` event vs `getAccumulatedUsage`.
