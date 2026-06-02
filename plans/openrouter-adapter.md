# Plan: OpenRouter Adapter

Add `openrouter-agent-harness` as callboard's first alternative `AgentProvider` + `SessionProvider`, alongside the in-tree `claude-code` adapter. Claude Code stays the default for every code path; OpenRouter is opt-in per chat once an API key is configured.

Status: **Not started.** Prerequisites landed.

---

## Why this and not Codex first

Both adapters are scoped in the abstraction-layer plan as ~40h Phase-2 work. OpenRouter goes first because:

- **The library is finished.** `openrouter-agent-harness` (in this user's tree at `/home/cybil/openrouter-agent-harness`) shipped Phases 0–1 of `plans/callboard-compatibility.md` — 18 PRs, 166 tests, ~97% coverage. Its public surface (`OpenRouterAgentRun`, `tool()`, `createSdkMcpServer`, `accountInfo`, `supportedModels`) was deliberately shaped to drop in where `@anthropic-ai/claude-agent-sdk` does.
- **No subprocess shell-out.** Unlike Codex (which spawns a Rust CLI binary and exchanges JSONL), OR runs in-process — same model as Claude Code SDK in callboard. MCP tool exposure collapses into a same-process Zod re-wrap; no MCP stdio server launcher to write.
- **Single-key, 300+ models.** Replaces "pay Anthropic / use Claude binary" with "pay OpenRouter / pick from anyone" while keeping every Claude-style feature (subagents, skills, slash commands, plugins, MCP, compaction, checkpointing, forking, streaming input).

Codex remains queued behind this in `plans/codex-adapter.md`.

---

## Prerequisites (done)

- `AgentProvider` port + `ClaudeCodeAdapter` (PR #125, commit `fd24b75`)
- `SessionProvider` port + `ClaudeCodeSessionProvider` (PR #126)
- `factory.ts` already supports multi-provider session discovery (`getSessionProviders()` iterates)
- `routes/chats.ts:826` already reads `meta.provider` to route session-message parsing
- `ToolDefinition` / `ToolServerSpec` ports — Claude-tools, callboard-tools, proxy-tools, qc all already author against the neutral spec

## Library being integrated

- **Name:** `openrouter-agent-harness`
- **Source:** `/home/cybil/openrouter-agent-harness` (Apache-2.0, library-only)
- **Version target:** 0.2.x (current); pin exact version, treat upgrades as adapter PRs not casual bumps
- **Packaging decision:** _open question — see below_. Initial cycle: vendor the dist via local `file:` reference; switch to npm publish once the integration stabilizes.

## Default behavior (preserved)

- Existing chats with no `provider` in metadata: route to `claude-code` (the explicit fallback already in `routes/chats.ts:826`).
- New chats from the UI: default `provider: "claude-code"` in chat metadata.
- Cron triggers / agent heartbeats / event watchers that fire `sendMessage`: default `claude-code` unless the originating chat metadata says otherwise.
- Quick-completion (`quick-completion.ts`) and sdk-info (`sdk-info.ts`): stay on `claude-code` for v1, regardless of chat provider (matches the codex-adapter §Phase 5 decision — different cost profile, latency-sensitive).
- The OpenRouter provider toggle in the New Chat panel is **disabled** until the user enters an `OPENROUTER_API_KEY` in Settings → API.

---

## Architecture

Mirror the `claude-code` and (planned) `codex` adapter shapes:

```
backend/src/agents/adapters/openrouter/
  OpenRouterAdapter.ts             # AgentProvider — query() wraps OpenRouterAgentRun
  OpenRouterSessionProvider.ts     # SessionProvider — scans <logsRoot>/<sessionId>/
  messageAdapter.ts                # AgentCoreEvent (OR) → AgentEvent (callboard)
  sessionParser.ts                 # <logsRoot>/<id>/*/response.json → ParsedMessage[]
  optionsAdapter.ts                # Claude-SDK-shaped options → OpenRouterAgentRunOptions
  permissionAdapter.ts             # canUseTool wrapper preserving callboard's PermissionPolicy
  toolAdapter.ts                   # ToolServerSpec → openrouter-agent-harness createSdkMcpServer
  hookAdapter.ts                   # neutral hook events → onHook callback
  types.ts                         # Shared adapter-local types
```

Tests sit alongside (`*.test.ts`) using the same vitest setup the claude-code adapter uses.

### Port re-fitting (small, mechanical)

Two single-line ports need to learn about the new provider kind:

1. `ports/AgentProvider.ts:52` — extend the `AgentProviderKind` union: `"claude-code" | "openrouter" | "codex" | "mock"`.
2. `factory.ts` — `getAgentProvider()` becomes `getAgentProvider(kind?: AgentProviderKind)` returning a per-kind singleton from a small `Map<kind, AgentProvider>`. Default remains `claude-code` when `kind` is omitted. `getSessionProviders()` returns both providers' SessionProviders.

Per-call sites that need the provider:
- `claude.ts:sendMessage` → resolve kind from chat metadata (`meta.provider`), default `"claude-code"`, fetch `getAgentProvider(kind)`.
- `claude.ts` `buildToolServer` call sites (lines 621, 642, 675) → must use the **same** provider as the query call. Pass a single resolved `provider` reference down.
- `quick-completion.ts`, `sdk-info.ts` → keep pinning `"claude-code"` for v1.

---

## Phase 1: OpenRouterAdapter (agent execution)

### Library integration

```ts
import { OpenRouterAgentRun } from "openrouter-agent-harness";

class OpenRouterAdapter implements AgentProvider {
  readonly kind = "openrouter" as const;

  query(req: AgentQueryRequest): AgentQuery {
    const orOpts = translateOptions(req.options, req.prompt);
    const run = new OpenRouterAgentRun(orOpts);
    return new OpenRouterAgentQuery(run);
  }

  buildToolServer(spec: ToolServerSpec): unknown {
    return buildOpenRouterToolServer(spec);
  }
}

class OpenRouterAgentQuery implements AgentQuery {
  constructor(private readonly run: OpenRouterAgentRun) {}

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return translateOpenRouterEvents(this.run)[Symbol.asyncIterator]();
  }

  async accountInfo() {
    return accountInfo({ apiKey: getOpenRouterApiKey() });
  }
  async supportedModels() {
    return supportedModels({ apiKey: getOpenRouterApiKey() });
  }
  async close() {
    this.run.abort();
  }
}
```

### Event translation (`messageAdapter.ts`)

`AgentCoreEvent` (OR) → `AgentEvent` (callboard `ports/events.ts`):

| OR `AgentCoreEvent`                          | callboard `AgentEvent`                                                | Notes                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `session_started { sessionId, parent? }`     | `session_started { sessionId }`                                       | Drop `parentSessionId` — callboard owns its own subagent lineage.                      |
| `text_delta { content }`                     | `text { content }`                                                    | One-to-one. Frontend already coalesces.                                                |
| `turn_start { turnNumber }`                  | _(drop)_                                                              | Callboard has no per-turn UI event.                                                    |
| `tool_call { callId, name, input }`          | `tool_use { callId, toolName: name, input }`                          | Field rename.                                                                          |
| `tool_result { callId, output, isError }`    | `tool_result { callId, content: stringify(output), isError }`         | Stringify per port shape (`events.ts:33`).                                             |
| `turn_end { turnNumber, usage, costUsd }`    | _(accumulate)_                                                        | Track running totals; emitted only on final `result`.                                  |
| `stream_complete { status, reason, usage… }` | `result { status, reason, usage: { inputTokens, outputTokens, cost }, durationMs }` | Direct map; OR statuses (`success`/`max_turns`/`max_budget`/`error`) match.            |
| `error { message, cause? }`                  | _(swallow)_                                                           | Always followed by `stream_complete { status: "error" }`; that becomes the AgentEvent. |
| _(nothing — OR has no reasoning event yet)_  | `thinking { content }`                                                | Never emitted; revisit if OR adds reasoning deltas.                                    |
| _(nothing)_                                  | `slash_commands { commands }`                                         | Adapter emits a synthetic one-shot at session start using `commandLoader.list()` (see below). |
| _(no wire event for compaction yet)_         | `compaction_boundary`                                                 | Not surfaced in v1. Documented limitation — "Conversation compacted" banner won't render for OR chats. |
| anything else                                | `adapter_specific { adapter: "openrouter", payload }`                 | Escape hatch.                                                                          |

`PreCompact` / `Notification` / `McpServerStart` / `SubagentStart` etc. fire via OR's `onHook`, not the event stream — wired through `hookAdapter.ts`, not `messageAdapter.ts`.

### Synthetic `slash_commands` event

Claude Code emits `slash_commands` on its init payload, which callboard consumes at `claude.ts:794` (`setSlashCommandsForDirectory(folder, event.commands)`) to populate the slash menu. OR has no equivalent wire event but does support discovered commands via `createCommandLoader`. Adapter solution:

1. On `OpenRouterAgentQuery` construction, call `createCommandLoader({ cwd: folder }).list()` once.
2. Emit a synthetic `slash_commands` AgentEvent before the first `text` event.
3. Result: existing UI works unchanged.

### Options translation (`optionsAdapter.ts`)

`claude.ts:712-745` builds a Claude-SDK-shaped `queryOpts.options` blob. The adapter consumes that loose `Record<string, unknown>` (per `AgentProvider.AgentQueryRequest.options`) and maps fields to `OpenRouterAgentRunOptions`:

| Claude-shaped option                                | OR `OpenRouterAgentRunOptions`                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                                               | `cwd`                                                                                                                                   |
| `pathToClaudeCodeExecutable`                        | _(drop — no subprocess)_                                                                                                                |
| `settingSources: ["user","project","local"]`        | `settingSources: ["user","project","local"]` (same enum values; OR auto-loads CLAUDE.md too)                                            |
| `maxTurns`                                          | `maxTurns`                                                                                                                              |
| `resume: sessionId`                                 | `sessionId` (OR resumes by re-using the same sessionId; on-disk `state.json` + `previousResponseId` chain do the rest)                  |
| `plugins`                                           | `plugins: await loadPlugins({ pluginDirs })` — translate Claude's `{type:"local", path, name}[]` into OR's `loadPlugins({ pluginDirs })` invocation |
| `mcpServers` (record)                               | `mcpServers` (array) — values are already in-process `SdkMcpServer` bundles (output of `buildToolServer`); reshape record → array       |
| `allowedTools`                                      | `allowedTools` (OR's rule grammar is a superset)                                                                                        |
| `hooks` (Claude-shaped event matchers)              | `onHook` (single callback) — `hookAdapter.ts` fan-out (see below)                                                                       |
| `systemPrompt: { type:"preset", preset, append }`   | `instructions: composeInstructions(append, settingSources)` — drop preset (Claude-specific); use OR's default identity + append        |
| `systemPrompt: string`                              | `instructions: string`                                                                                                                  |
| `env`                                               | _(applied at adapter init: `process.env` override for OR's tool subprocesses; OR doesn't take an `env` constructor opt — passthrough to tool ctx)_ |
| `canUseTool`                                        | `canUseTool` (identical Claude-SDK-shape signature — drop in)                                                                           |
| `abortController`                                   | `signal: abortController.signal`                                                                                                        |
| `stderr` (callback)                                 | `logger: (level, msg) => stderr(msg)`                                                                                                   |
| _(none)_                                            | `apiKey: getAgentSettings().openRouterApiKey` (required)                                                                                |
| _(none)_                                            | `baseUrl: getAgentSettings().openRouterBaseUrl` (optional)                                                                              |
| _(none)_                                            | `model: getAgentSettings().openRouterModel ?? "~anthropic/claude-sonnet-latest"`                                                        |
| _(none)_                                            | `appTitle: "callboard"`                                                                                                                 |
| _(none)_                                            | `logsRoot: <home>/.openrouter-agent-harness/logs` (XDG-tolerant resolution; see SessionProvider §logsRoot below)                          |

### Permission system (`permissionAdapter.ts`)

Callboard already builds a `canUseTool` callback at `claude.ts:740` from a `ToolPermissionPolicy` (category → allow/ask/deny). The OR library accepts the **same callback shape** (`{ behavior: "allow" | "deny", reason?, updatedInput? }`). The adapter wires it through unchanged.

One asymmetry: callboard's `categorizeClaudeTool` is keyed on Claude SDK tool names (`Read`, `Edit`, `Bash`, …). OR's built-in tools use snake_case (`read_file`, `edit_file`, `run_command`). Two options:

- **A (recommended):** Extend `categorizeClaudeTool` into `categorizeTool(toolName, kind)` that branches on adapter kind. Cleanest, surfaces the asymmetry honestly.
- **B:** Pre-normalize OR tool names to Claude-style at the bridge edge. Simpler diff but loses information.

Option A — branch on `kind` in the policy factory, single-file change in `claude.ts`.

**Server-side tools caveat:** OR's `web_search`, `web_fetch`, `datetime` execute on OpenRouter's backend and **cannot be gated by canUseTool**. Document in the OR adapter README. Callboard's web-access permission category becomes "include or omit" for these specifically. Workaround: when `webAccess: "deny"`, register OR with a custom `tools: allTools({...}).filter(t => !ORServerSideToolNames.has(t.name))`.

### Tool exposure (`toolAdapter.ts`)

Callboard's 4 in-process tool servers (`callboard`, `callboard-tools`, `mcp-proxy`, `qc`) are authored as `ToolServerSpec { name, version, tools: ToolDefinition[] }`. OR's `createSdkMcpServer` accepts an identical shape — re-export and bridge:

```ts
import { createSdkMcpServer, tool } from "openrouter-agent-harness";
import type { ToolServerSpec, AnyToolDefinition } from "../../ports/tools.js";

export function buildOpenRouterToolServer(spec: ToolServerSpec): unknown {
  return createSdkMcpServer({
    name: spec.name,
    version: spec.version,
    tools: spec.tools.map(translateToolDef),
  });
}

function translateToolDef(def: AnyToolDefinition) {
  return tool({
    name: def.name,
    description: def.description,
    inputSchema: z.object(def.inputSchema),
    execute: async (args) => {
      const result = await def.handler(args);
      // Flatten ToolContentBlock[] → string for OR's execute return contract
      const text = result.content
        .map((b) => (b.type === "text" ? b.text : `[image:${b.mimeType}]`))
        .join("\n");
      return result.isError ? { isError: true, content: text } : text;
    },
  });
}
```

**Zod-version gotcha:** `openrouter-agent-harness` pins `zod/v4`; callboard imports `zod` as a peer dep. Lock callboard's `zod` to the same major; CI check verifies. The codex-adapter plan has the same constraint.

**Image content blocks:** Callboard's `ToolContentBlock` union includes `{ type: "image", data, mimeType }`. OR's execute return doesn't support image attachments; stringify as `[image:<mime>]` placeholder for v1. Bug-bash later if image-returning tools become important.

### Hook adapter (`hookAdapter.ts`)

OR exposes a **single** `onHook(event, payload)` callback covering `Setup`, `SessionStart`, `PreToolUse`, `PostToolUse`, `SessionEnd`, `Stop`, `Notification`, `PreCompact`, `McpServerStart`, `McpServerStop`, `SubagentStart`, `SubagentEnd`, `PluginStart`, `PluginStop`. Callboard's `claude.ts:612` builds Claude-shaped `hooks: { PreToolUse: [{ matcher, hooks: [...] }], … }` from plugin-provided command strings via `createCommandHookCallback`.

Adapter strategy:

1. Wrap callboard's existing hook builder output into a single `onHook` callback that pattern-matches on `event` and fans out to the matching list.
2. Skip events callboard doesn't subscribe to (no-op).
3. Surface `hookAskOverride.reason` on the OR `canUseTool` deny path the same way it works for Claude today.

### AbortSignal

`OpenRouterAgentRun` accepts `signal` directly. Adapter takes the existing `AbortController` from `claude.ts:715` and passes `signal: abortController.signal`. Existing `Stop` button code at `claude.ts:912` continues to work — already routes through the same `AbortController`.

---

## Phase 2: OpenRouterSessionProvider (session discovery)

### `logsRoot` resolution

OR writes session logs under `<logsRoot>/<sessionId>/{state.json, session.json, req_*/, gen_*/}`. The constructor option defaults to `<cwd>/logs`, but callboard needs a stable absolute path that survives directory changes. Resolution order:

1. `getAgentSettings().openRouterLogsRoot` if set.
2. `${XDG_DATA_HOME}/openrouter-agent-harness/logs` if `XDG_DATA_HOME` is set.
3. `<os.homedir()>/.openrouter-agent-harness/logs` (default).

This mirrors `~/.claude/projects/` and `~/.codex/sessions/`.

### Implementation

```ts
class OpenRouterSessionProvider implements SessionProvider {
  readonly kind = "openrouter" as const;

  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult {
    // readdir <logsRoot>/, stat <id>/session.json, sort by mtime DESC, paginate.
    // session.json (Phase 1.6 in OR repo) carries `cwd` — feeds folder/displayFolder.
  }

  resolveSession(sessionId: string): ResolvedSession | null {
    // Read <logsRoot>/<id>/session.json; return { logPath, folder, displayFolder }.
  }

  findSubagentFiles(sessionId: string): SubagentFile[] {
    // OR subagent sessionIds follow "<parent>:sub:<uuid>" convention.
    // Glob <logsRoot>/<sessionId>:sub:*/state.json.
  }

  parseSessionMessages(sessionIds: string[]): ParsedMessage[] {
    // Walk <logsRoot>/<id>/req_*/gen_*/response.json in chronological order.
    // Translate OR Responses-API output[] items → ParsedMessage[].
  }

  getSessionPreview(logPath: string, maxLength = 100): string | null {
    // Read first req_*/request.json's user prompt, truncate.
  }

  searchSessions(filters): SessionSearchResponse {
    // Grep across <logsRoot>/**/{session,request,response}.json constrained
    // by folder/grep/date filters.
  }

  deleteSessionFiles(sessionId: string): void {
    // rm -rf <logsRoot>/<sessionId>/ AND <logsRoot>/<sessionId>:sub:*/.
  }
}
```

### Message translation (`sessionParser.ts`)

| OR log shape                                                   | `ParsedMessage` shape                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `request.input[]` `{ role: "user", content }`                  | `{ type: "user", content }`                                 |
| `response.output[]` `{ type: "message", role: "assistant" }`   | `{ type: "assistant", content }`                            |
| `response.output[]` `{ type: "function_call", name, args, id }` | `{ type: "tool_use", callId: id, toolName: name, input }`   |
| `response.output[]` `{ type: "function_call_output", id, output }` | `{ type: "tool_result", callId: id, content, isError? }`    |

Mirrors codex-adapter `sessionParser.ts`. The codex one is 305 lines; OR's is likely smaller because OR's log format is the OpenAI Responses API shape directly (less translation).

---

## Phase 3: Routing — chat metadata + factory

### Chat metadata field

Extend chat metadata (currently a free-form JSON blob serialized into `chats.json`) with one new optional field:

```ts
// shared/types/chat.ts (or wherever metadata is typed loosely today)
provider?: "claude-code" | "openrouter";
```

- New chats from the UI write the field at creation time (default `"claude-code"`).
- Existing chats with the field absent: treated as `"claude-code"` (preserves all current behavior).
- The OR session's `state.json` is the source of truth for OR sessionIds; the chat-metadata `provider` field tells callboard which `SessionProvider` to ask.

### Factory

```ts
// backend/src/agents/factory.ts
const _providers = new Map<AgentProviderKind, AgentProvider>();

export function getAgentProvider(kind: AgentProviderKind = "claude-code"): AgentProvider {
  if (!_providers.has(kind)) {
    _providers.set(kind, kind === "openrouter" ? new OpenRouterAdapter() : new ClaudeCodeAdapter());
  }
  return _providers.get(kind)!;
}

export function getSessionProviders(): readonly SessionProvider[] {
  // Returns both ClaudeCodeSessionProvider + OpenRouterSessionProvider when OR is configured.
}
```

### sendMessage wiring (`claude.ts`)

Three changes to `sendMessage` (the file is misnamed for legacy reasons — it dispatches to whatever provider the chat uses):

1. **At top:** resolve `providerKind` from `initialMetadata.provider ?? "claude-code"`. Store on the closure.
2. **Lines 621, 642, 675** (`buildToolServer` calls): use `getAgentProvider(providerKind).buildToolServer(spec)` instead of the default.
3. **Line 771** (`query` call): use `getAgentProvider(providerKind).query(queryOpts)` instead of the default.

Critical invariant: **the same provider is used for `buildToolServer` and `query` in a single sendMessage call**. The `buildToolServer` output is an opaque adapter-specific object; passing a Claude-MCP-server bundle into an OR query will not work.

### Quick completion + sdk-info

Stay on `claude-code` for v1 (see "Default behavior" above). Both files are < 200 lines, both import the SDK directly via `quickCompletionProvider = getAgentProvider("claude-code")`. Document the deferral; revisit when OR chats outnumber Claude chats and the cost asymmetry of title-generation becomes meaningful.

---

## Phase 4: Settings + AgentSettings extension

### `shared/types/agentSettings.ts`

Add a new section, parallel to the existing Anthropic block:

```ts
// ── OpenRouter ─────────────────────────────────────────────────────
/** OPENROUTER_API_KEY — required to enable the OpenRouter provider. */
openRouterApiKey?: string;
/** OPENROUTER_BASE_URL — override the OR API endpoint. */
openRouterBaseUrl?: string;
/** Default model alias for new OR chats. Defaults to ~anthropic/claude-sonnet-latest. */
openRouterModel?: string;
/** Absolute path to write OR session logs into. Defaults to ~/.openrouter-agent-harness/logs. */
openRouterLogsRoot?: string;
```

API-env override builder (the existing `getApiEnvOverrides` in `claude.ts`) doesn't need to know about OR — the OR adapter reads from `getAgentSettings()` directly and passes values through OR's constructor opts.

### Provider-availability gate

Add a single derived helper:

```ts
// backend/src/services/agent-settings.ts
export function isOpenRouterConfigured(): boolean {
  return Boolean(getAgentSettings().openRouterApiKey?.trim());
}
```

The frontend reads this via a new `GET /system/info` field (`openRouterConfigured: boolean`) and uses it to enable/disable the provider toggle in the New Chat panel.

---

## Phase 5: UI

### ApiSettings.tsx — new "OpenRouter" section

Add a new section card below the existing Anthropic API block. Same component patterns (`SecretField`, `sectionStyle`):

```
┌─ OpenRouter (alternative provider) ─────────────────┐
│ Provide a key to enable OpenRouter as an option     │
│ when starting a new chat. Existing chats continue   │
│ to use Claude Code SDK.                             │
│                                                     │
│ ┌─ API Key  OPENROUTER_API_KEY ────────────────────┐│
│ │ sk-or-...           [Show] [Save]                ││
│ └──────────────────────────────────────────────────┘│
│                                                     │
│ ┌─ Base URL (optional)  OPENROUTER_BASE_URL ───────┐│
│ │ https://openrouter.ai/api/v1                     ││
│ └──────────────────────────────────────────────────┘│
│                                                     │
│ ┌─ Default model ──────────────────────────────────┐│
│ │ ~anthropic/claude-sonnet-latest             [▼]  ││
│ └──────────────────────────────────────────────────┘│
│  Populated from accountInfo()'s supportedModels()   │
│  when API key is set; free-text otherwise.          │
│                                                     │
│ Account status:  Label: …  Usage: $12.34 / $100     │
└─────────────────────────────────────────────────────┘
```

Account status row uses `OpenRouterAdapter.query(...).accountInfo()` already exposed.

### NewChatPanel.tsx — Provider toggle

The component already has a `chatMode: "claude-code" | "agent"` state at line 50 — this is **unrelated** (mode = "raw chat vs. saved agent"). The new toggle is provider-only and lives at the top of the collapsible settings area, above PermissionSettings.

```
┌─ New Chat ─────────────────────────────────────────┐
│ Working folder: [/path/...                     ▼]  │
│                                                    │
│ Provider:  ( ) Claude Code   ( ) OpenRouter        │
│                                                    │
│ ▼ Settings (permissions, …)                        │
│   ┌──────────────────────────────────────────────┐ │
│   │ Permissions: …                               │ │
│   │ Model: … (only shown when OpenRouter chosen) │ │
│   └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

Behavior:

- Default selection: `"claude-code"`. Persists via the same `localStorage` channel `getDefaultPermissions` uses (new key `defaultProvider`).
- When `!systemInfo.openRouterConfigured`, the OpenRouter radio is **disabled** with hover-tooltip "Configure your OpenRouter API key in Settings → API to enable this provider" and a small inline link to `/settings/api`.
- When OpenRouter is selected, an additional Model dropdown appears (populated from `supportedModels()` once, cached for the session). Selection writes to chat metadata as `model` override.
- Selected provider is passed through `navigate(...)` state and lands in chat metadata at creation time (the existing flow at `handleCreate`).

### Chat.tsx — Provider badge

Tiny badge next to the chat title showing the active provider — read from chat metadata, render as `Claude` (default styling) or `OR` (different `--badge-*` CSS var). Hover shows the model name for OR chats. No behavior change.

### MessageBubble.tsx / ToolCallBubble.tsx

**No changes.** The `messageAdapter` normalizes OR's event types to the same `tool_use` / `tool_result` events Claude produces. Tool names may differ (`run_command` vs `Bash`) but UI already treats `toolName` as opaque.

---

## Phase 6: Tests

Mirror the claude-code adapter's test set:

- `messageAdapter.test.ts` — translation table coverage (all 8 AgentCoreEvent variants → AgentEvent or drop)
- `optionsAdapter.test.ts` — every option from the Phase 1 table
- `permissionAdapter.test.ts` — allow/deny/ask round-trip, server-side tool gap
- `toolAdapter.test.ts` — Zod schema round-trip with a fixture tool, error path returns `isError: true`
- `OpenRouterSessionProvider.test.ts` — fixture `<logsRoot>/<id>/...` tree, parse + discover + search + delete
- `OpenRouterAdapter.integration.test.ts` — end-to-end against a recorded OR response stream (or a mocked `OpenRouterAgentRun`)

Add OR provider to the existing `agents.integration.test.ts` parameterized-by-kind sweep.

---

## Implementation order

| Step | What                                                                                                                                                                                                                                | Est. |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1    | Install `openrouter-agent-harness` (vendor via `file:` or local link initially), pin exact version, verify build                                                                                                                  | 1h   |
| 2    | Extend `AgentProviderKind` union (`AgentProvider.ts:52`) — single-line                                                                                                                                                            | 15m  |
| 3    | Refactor `factory.ts` to per-kind singleton map; preserve no-arg behavior (default `claude-code`)                                                                                                                                  | 1h   |
| 4    | `OpenRouterAdapter.ts` skeleton + `query()` stub returning an empty async-iterable                                                                                                                                                  | 1h   |
| 5    | `messageAdapter.ts` — translation table + tests (15-ish cases)                                                                                                                                                                     | 4h   |
| 6    | `optionsAdapter.ts` — option mapping + tests                                                                                                                                                                                       | 3h   |
| 7    | `toolAdapter.ts` — `buildOpenRouterToolServer`, Zod re-wrap, image placeholder, isError pass-through                                                                                                                                | 4h   |
| 8    | `permissionAdapter.ts` — extend `categorizeTool(name, kind)` in PermissionPolicy; server-side-tool filter helper                                                                                                                    | 3h   |
| 9    | `hookAdapter.ts` — single-callback fan-out wrapping callboard's existing Claude-shaped hooks                                                                                                                                       | 2h   |
| 10   | Wire OR adapter end-to-end inside `claude.ts:sendMessage` behind a provider-kind branch                                                                                                                                            | 3h   |
| 11   | `OpenRouterSessionProvider.ts` — discover + resolve + delete + subagent files                                                                                                                                                     | 4h   |
| 12   | `sessionParser.ts` — OR log → `ParsedMessage[]`                                                                                                                                                                                    | 4h   |
| 13   | `searchSessions` implementation + tests                                                                                                                                                                                            | 2h   |
| 14   | Extend `AgentSettings` type + backend persistence + `isOpenRouterConfigured` helper                                                                                                                                                | 2h   |
| 15   | Chat metadata field (`provider`) write at creation; default `"claude-code"`; routing in `claude.ts` and `routes/chats.ts:826`                                                                                                       | 2h   |
| 16   | Synthetic `slash_commands` event from `createCommandLoader` at session start                                                                                                                                                       | 1h   |
| 17   | Frontend: ApiSettings OpenRouter section                                                                                                                                                                                          | 4h   |
| 18   | Frontend: NewChatPanel provider toggle + disabled state when unconfigured + model picker                                                                                                                                            | 3h   |
| 19   | Frontend: Chat header provider badge                                                                                                                                                                                              | 1h   |
| 20   | Frontend: shared types update (`AgentSettings`, `SystemInfo.openRouterConfigured`)                                                                                                                                                | 1h   |
| 21   | Integration tests against recorded OR stream + parameterize `agents.integration.test.ts` over both kinds                                                                                                                            | 4h   |

**Total: ~50h** (~1.25 sprints). Slightly above the 40h estimate in `openrouter-agent-harness/plans/callboard-compatibility.md` because that estimate omitted Step 16 (synthetic slash commands), Step 9 (hook adapter — they assumed pass-through), and the search/delete portions of Step 11/13.

Land in 4 PRs to keep diffs reviewable:

- **PR A** (Steps 1–3, ~2h): Package install + port/factory ground work. No behavior change. Hard prereq for everything else.
- **PR B** (Steps 4–10, ~20h): OpenRouterAdapter agent-execution path, end-to-end. Gated by a feature flag (`getAgentSettings().openRouterApiKey` presence). Existing chats unaffected.
- **PR C** (Steps 11–13, ~10h): SessionProvider. Without this, OR chats run but you can't browse history.
- **PR D** (Steps 14–21, ~18h): Settings + UI + chat-routing + tests. The user-visible toggle PR.

---

## Key Risks

1. **Zod version drift.** `openrouter-agent-harness` pins `zod/v4`; callboard's `package.json` should be aligned before Step 1. Lock both sides; CI verifies via a `zod` peer-dep check in the adapter.

2. **MCP image content blocks lose information.** Callboard's `ToolContentBlock.image` becomes `[image:<mime>]` string under OR. Acceptable for v1 because no callboard tool currently returns image content (all 48 tools return text/JSON). Add a TODO + ratchet a vitest assertion against `ToolDefinition`s if image content gets added later.

3. **Server-side tool permission gap.** `web_search` / `web_fetch` / `datetime` cannot be gated by `canUseTool` because they execute on OR's backend. Workaround for `webAccess: "deny"`: filter them out of the OR `tools` array at registration. Document as a known limitation in the new ApiSettings section.

4. **OR library version churn.** `openrouter-agent-harness` is v0.2.x; even though the public API is well-shaped, minor versions may rev. Pin exact version (`^0.2.x` → `0.2.x`) and treat upgrades as adapter-update PRs.

5. **No `compaction_boundary` wire event.** OR handles compaction internally and exposes `PreCompact` via `onHook`, but doesn't emit a stream-level boundary event. Callboard's "Conversation compacted" banner won't render for OR chats in v1. Workaround: synthesize from the `PreCompact` hook into an `adapter_specific` event the frontend filters on. Defer to a follow-up PR.

6. **Subagent cost-tracking double-count risk.** Callboard has its own subagent concept (compiled into `systemPrompt` via `compileIdentityPrompt()`). With OR's own `spawn_subagent` opt-in, two distinct subagent paths exist. v1: keep OR's `enableSubagents: false` (default), let callboard's subagent path handle everything. Revisit if a use case wants OR's deeper recursion.

7. **`logsRoot` collision.** If two callboard processes run on the same machine (worktrees), they share `<home>/.openrouter-agent-harness/logs/`. OR session IDs are UUIDs so no actual collision, but discovery returns all sessions across worktrees. Same behavior as `~/.claude/projects/` today — fine.

---

## Open Questions

- **Packaging.** Vendor (`file:../openrouter-agent-harness`) for the initial integration cycle, or npm publish the OR library first? Vendoring is faster for PR A but means callboard pins to a specific git revision. Decide before Step 1. **Recommendation:** vendor for PRs A–C; switch to npm by PR D.

- **Per-chat model override storage.** Where does the per-chat model selection from NewChatPanel actually go — chat metadata (`model: "google/gemini-2.0-flash"`)? AgentSettings (one default per provider)? **Recommendation:** chat metadata, with AgentSettings holding the default. Mirrors how `agentAlias` flows today.

- **OR `quick-completion` path.** Title generation runs ~once per chat. OR cost would be slightly different from Claude. Keep on Claude for v1 (simpler, established). Revisit if OR chats dominate.

- **Subagent provider routing.** When a callboard agent (subagent) is spawned from a Claude-Code chat, should it inherit `provider: "claude-code"`, or can the user set a different provider per subagent? **Recommendation v1:** inherit from parent — keeps cost-tracking and conversation-history routing predictable.

- **Provider switching for existing chats.** Once a chat has a provider, it can't switch (the session log lives in one provider's storage). Make this explicit in the UI — toggle is **read-only** on existing chats, only writable when creating new ones.

---

## Companion Context

- This repo: [`plans/agent-abstraction-layer.md`](agent-abstraction-layer.md) — defines the ports this plan implements against
- This repo: [`plans/codex-adapter.md`](codex-adapter.md) — the worked example with the same shape
- `openrouter-agent-harness` repo: [`plans/callboard-compatibility.md`](file:///home/cybil/openrouter-agent-harness/plans/callboard-compatibility.md) — the library-side prerequisite, already shipped
- `openrouter-agent-harness` repo: [`README.md`](file:///home/cybil/openrouter-agent-harness/README.md) — public API surface and feature reference
