# Plan: agent-abstraction-layer

An in-process ports-and-adapters seam that decouples callboard's backend from `@anthropic-ai/claude-agent-sdk`, so the agent engine can later be swapped for another harness (OpenCode, Codex SDK, Mastra, raw Vercel AI SDK + MCP) without rewriting callers.

Status: **Phases 1–4 landed; real second adapter (OpenCode) deferred.**

**Progress:**

- ✅ Phase 1 — ports + Claude adapter pass-through ([commit fd24b75](../) · [PR #125](https://github.com/WolpertingerLabs/callboard/pull/125))
- ✅ Phase 2 — ToolDefinition / ToolServerSpec port + four tool files refactored (commit f28b08b)
- ✅ Phase 3 — AgentEvent stream + ToolPermissionPolicy (commit e730f00)
- ✅ Phase 4 — MockAgentProvider + integration test proving the seam
- ⏳ Phase 4 (future) — real OpenCode adapter (~1 sprint; separate PR)

---

## Why This Matters

Callboard currently embeds the Claude Agent SDK directly. Every assumption about message shape, tool authoring, hooks, permission callbacks, and session resumption lives in backend service code that imports from `@anthropic-ai/claude-agent-sdk`. That's fine today because Claude Code is the best coding harness available — but it creates portability debt if any of the following happen:

- Anthropic pricing or rate-limit posture changes materially
- A credible open-source harness closes the quality gap (OpenCode, Codex open core, Mastra + MCP)
- Callboard's roadmap starts including agents whose workload isn't coding-centric
- A provider has a bad quality week and we want to fail over without rewriting

This plan establishes the seam now, while the scope is still manageable, so later migration is a _sprint_, not a _rewrite_.

Companion research report: [`deep-research-claude-agent-sdk-alternatives.md`](../deep-research-claude-agent-sdk-alternatives.md).

---

## Current Claude Agent SDK Surface in Callboard

The codebase uses a narrow, well-scoped subset of the SDK. Audited files:

**Core imports:**

- `backend/src/services/claude.ts` — `query`, plus types `PermissionResult`, `HookEvent`, `HookCallbackMatcher`, `HookCallback`, `HookInput`, `HookJSONOutput`
- `backend/src/services/agent-tools.ts` — `tool`, `createSdkMcpServer`
- `backend/src/services/callboard-tools.ts` — `tool`, `createSdkMcpServer`
- `backend/src/services/proxy-tools.ts` — `tool`, `createSdkMcpServer`
- `backend/src/services/quick-completion.ts` — `query`, `tool`, `createSdkMcpServer`
- `backend/src/services/sdk-info.ts` — `query`

**Call-site patterns (three distinct):**

1. **Main session** (`claude.ts:846`) — full interactive agent. Options used: `cwd`, `pathToClaudeCodeExecutable`, `settingSources`, `maxTurns`, `resume`, `plugins`, `mcpServers`, `allowedTools`, `hooks`, `systemPrompt` (preset "claude_code" + append), `canUseTool`, `stderr`, `env`, `abortController`.
2. **Quick completion** (`quick-completion.ts:135`) — one-shot structured return. Options used: `model`, `cwd`, `tools: []`, `allowedTools`, `mcpServers`, `maxTurns: 10`, `persistSession: false`, `settingSources: []`, `effort`, `systemPrompt` (string), `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions`, `env`.
3. **SDK info** (`sdk-info.ts:60`) — diagnostic introspection. Options used: `cwd`, `tools: []`, `maxTurns: 1`, `persistSession: false`, `settingSources: ["user"]`, `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions`, `env`. Also calls `conversation.accountInfo()`, `conversation.supportedModels()`, `conversation.close()`.

**Message consumption** (narrow): branches on `message.type === "result"` (with `subtype` for success/error/max_turns/max_budget), `message.slash_commands`, `message.session_id`, `message.type === "system" && subtype === "compact_boundary"`, plus content blocks of type `text` / `thinking` / `tool_use` / `tool_result`.

**MCP tool servers defined in-process** (via `createSdkMcpServer`):

- `callboard` — agent orchestration, cron, triggers, activity, themes
- `callboard-tools` — render_file, canvas, chat session management, find_chats, wait
- `mcp-proxy` — secure_request, list_routes, poll_events, ingestor control
- `qc` — quick-completion return_result

**Hooks** — registered via `options.hooks` from plugin-provided command strings, wrapped by `createCommandHookCallback` (hooks run as bash commands). Supports `hookAskOverride` flag to force user prompts.

**Subagents** — _not_ via `agents: {}` option. Callboard stores agent definitions in `~/.claude/agents/*.json`, selects per-session via `agentAlias`, and compiles identity into `systemPrompt` via `compileIdentityPrompt()`. This is callboard's own concept, not a Claude SDK concept.

**Auth** — direct Anthropic API (not Bedrock/Vertex). `ANTHROPIC_API_KEY` from env, overridable via Settings → API with key aliases and model-route overrides through `getApiEnvOverrides()`.

**Harness-specific features wired in:** session resumption (`resume: sessionId` with async session_id arrival → chat record migration), plugins (`{type: "local", path, name}` arrays, per-directory merged with app-wide), slash commands captured from system init, plan mode exit detected via `ExitPlanMode` tool, `canUseTool` permission callback with category-based auto-approve falling back to user prompt via `permission_request` event.

**SDK features NOT used** (worth noting — smaller blast radius): `forkSession`, `streamInput`, `fallbackModel`, `outputFormat`, `includePartialMessages`, `sandbox`, `disallowedTools`.

---

## Design Principles

1. **Ports & adapters, not a pure factory.** Factory alone selects which implementation you get; it doesn't define the seam. The value is in the interface callers depend on — the factory is a construction detail.
2. **Adapter hosts all SDK knowledge.** After this is done, `@anthropic-ai/claude-agent-sdk` imports should appear in _exactly one directory_: `adapters/claude-code/`.
3. **Normalize events, not APIs.** Callers consume a canonical `AgentEvent` stream; adapter-specific events ride through an explicit escape hatch rather than polluting the core type.
4. **Capability flags over lowest-common-denominator.** Some Claude Code features (plugins, specific hook events, Skills auto-discovery) won't exist in other adapters. Expose a capability matrix and let callers branch rather than pretending every adapter has everything.
5. **Strangler migration.** Introduce ports in parallel with existing code, cut over one caller at a time, never break main while in-flight.
6. **Don't over-abstract.** Worktrees, git, filesystem paths, zod schemas, and callboard's own agent-identity concept stay exactly as they are. The seam is only around the engine.

---

## Decisions (locked in)

1. **Quick-completion and sdk-info paths reuse the main `AgentProvider` interface** with a `oneShot: true` config flag — less surface area now. Revisit if quick-completion grows meaningfully.
2. **Permission policy becomes a provider-neutral `PermissionPolicy` class** (category mapping for `fileRead`/`fileWrite`/`codeExecution`/`webAccess` lives there). The adapter wires it into whatever native shape it needs (`canUseTool` for Claude).
3. **Capability branching is compile-time**, not runtime. When code needs Claude-specific behaviour, it branches on `provider instanceof ClaudeCodeAdapter` (or a discriminated-union tag), not on a runtime capability flag. More honest about which adapter you're actually targeting.

---

## Architecture

```
backend/src/agents/
├── ports/                       # The seam — no SDK imports anywhere under here
│   ├── AgentProvider.ts         # start/resume/info/close + AgentRun
│   ├── events.ts                # canonical AgentEvent union
│   ├── tools.ts                 # ToolDefinition + ToolServer (zod-based)
│   ├── hooks.ts                 # neutral HookEvent subset + callback shape
│   └── permissions.ts           # PermissionPolicy + decision types
├── adapters/
│   └── claude-code/             # All SDK-specific code lives here
│       ├── ClaudeCodeAdapter.ts
│       ├── toolAdapter.ts       # ToolDefinition[] → createSdkMcpServer
│       ├── hookAdapter.ts       # neutral hooks → SDK hooks
│       ├── messageAdapter.ts    # SDKMessage → AgentEvent
│       └── optionsAdapter.ts    # neutral config → SDK Options
└── factory.ts                   # config → AgentProvider (manual DI, no container)
```

Existing MCP tool authors (`agent-tools.ts`, `callboard-tools.ts`, `proxy-tools.ts`, `quick-completion.ts`) move from `createSdkMcpServer` to returning `ToolDefinition[]`. The adapter wraps them at registration.

### Port sketch

```ts
interface AgentProvider {
  readonly kind: "claude-code" | "opencode" | "codex" | "mock";
  start(req: StartRequest): AgentRun;
  resume(req: ResumeRequest): AgentRun;
  info(): Promise<AdapterInfo>;
  close(): Promise<void>;
}

interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
}

type AgentEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_use"; toolName: string; input: unknown; callId: string }
  | { type: "tool_result"; callId: string; content: unknown; isError?: boolean }
  | { type: "permission_request"; toolName: string; input: unknown; suggestions?: unknown }
  | { type: "slash_commands"; commands: string[] }
  | { type: "compaction_boundary" }
  | { type: "result"; status: "success" | "max_turns" | "max_budget" | "error"; reason?: string }
  | { type: "adapter_specific"; adapter: string; payload: unknown };

interface ToolDefinition<In = unknown, Out = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<In>;
  handler: (input: In, ctx: ToolContext) => Promise<Out>;
}
```

Event shape matches the five branches the code actually consumes today (`result`, `session_id`, `text`, `thinking`, `tool_use`, `tool_result`), plus the one-off status/slash/compaction events. `adapter_specific` is the deliberate escape hatch.

---

## Migration Plan (strangler, four phases)

### Phase 1 — Introduce ports, no behaviour change

Create `backend/src/agents/ports/` with the interfaces. Create `backend/src/agents/adapters/claude-code/` and move SDK-specific logic from `claude.ts`, `quick-completion.ts`, `sdk-info.ts` into it _unchanged_. Have the Claude adapter implement the port. Rewrite the three call sites to go through the port. Pure refactor — behaviour must match byte-for-byte. Risk: session/message/permission hotpath. Mitigation: land behind a feature flag, run both paths in parallel for a day, diff outputs on a handful of real sessions.
**Estimated effort:** ~1 sprint.

### Phase 2 — Decouple the four MCP tool files

Convert `agent-tools.ts`, `callboard-tools.ts`, `proxy-tools.ts`, and quick-completion's `qc` server to return `ToolDefinition[]` instead of calling `createSdkMcpServer` directly. The Claude adapter wraps them at registration time (in `toolAdapter.ts`). After this, those four files have zero Claude-SDK imports.
**Estimated effort:** 2–4 days.

### Phase 3 — Capability audit + neutral hook/permission wiring

Walk every call site that touches a Claude-specific feature (plugins, `settingSources`, specific hook events, slash commands, plan mode, `ExitPlanMode` detection). Move adapter-specific handling into the adapter; leave compile-time branches on `provider.kind === 'claude-code'` at the few call sites that genuinely need it. `canUseTool` policy moves into `PermissionPolicy`; the adapter wires it.
**Estimated effort:** 3–5 days.

**Phase 3 exit criterion:** `@anthropic-ai/claude-agent-sdk` imports exist only in `backend/src/agents/adapters/claude-code/`.

### Phase 4 — Prove the seam with a second adapter

Build a `MockAdapter` first (for tests — drives the events stream from fixtures). Then build a real second adapter; first pick is **OpenCode** per the research — it has an OpenAPI server + generated TS SDK, MIT license, 75+ providers including local, and matches callboard's coding-agent use case structurally. Don't start this until phases 1–3 are stable.
**Estimated effort:** Mock ~1–2 days; OpenCode adapter ~1 sprint.

**Phase 4 landed:**

- `backend/src/agents/adapters/mock/MockAgentProvider.ts` — fully-functional test double with scriptable event arrays, per-call event scripts, `accountInfo`/`supportedModels` stubs, and `buildToolServer` that captures specs for assertion
- `setAgentProviderForTesting()` in `backend/src/agents/factory.ts` — test-only injection hook (single line; prod callers still go through lazy-default `getAgentProvider()`)
- `backend/src/agents/agents.integration.test.ts` — 10 new tests covering factory injection, event iteration (incl. close() short-circuit), accountInfo/supportedModels, tool-server translation (including handler execution), and `ToolPermissionPolicy` decision matrix. All 152/162 tests pass.

**Deferred:** OpenCode adapter. Requires running an OpenCode server to translate against and ~1 sprint of option/event translation work (session resumption, permission prompts, its specific MCP wiring). Separate PR when the business case matures.

---

## Non-Goals

- Not building a universal agent framework. Just an adapter seam for callboard's specific usage.
- Not abstracting Claude Code plugins into a neutral concept. Plugins stay Claude-specific; callers check the adapter kind at compile time if they need them.
- Not trying to run without Claude on day one. Goal is _optionality_, not immediate portability.
- Not introducing a DI container. Manual constructor injection through the factory is sufficient at this scale.
- Not abstracting worktrees, git, or filesystem paths. Those are infrastructure, not agent concerns.
- Not abstracting callboard's `~/.claude/agents/*.json` identity-compilation concept. It happens to live under `~/.claude/` by convention but is callboard's own data model.

---

## Open Questions / Follow-Ups

- **Hook event subset.** Which Claude hook events should be promoted to the neutral `HookEvent` subset and which should stay adapter-specific? Likely core: `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`. Likely adapter-specific: `PreCompact`, `WorktreeCreate`/`Remove`, `ConfigChange`, `TeammateIdle`. Decide during Phase 3.
- **`session_id` arrival timing.** Claude Code emits the session ID asynchronously as a system event. Some adapters may emit it synchronously or not at all. The port models it as an event (`session_started`), which handles both — but callers that today assume async arrival and perform chat-record creation on that event will need to be checked for adapters that emit synchronously.
- **Second-adapter choice.** OpenCode is the current first pick for Phase 4, but if OpenAI ships first-class Claude support in `@openai/codex-sdk` before we get there, Codex may be a stronger candidate — it already has a published TS SDK surface structurally equivalent to Claude Agent SDK.
- **`@openrouter/agent` + `@openrouter/sdk` as a future adapter candidate** _(user-suggested; not surfaced by the initial research sweep)._ OpenRouter publishes a TS agent toolkit (`@openrouter/agent`, Apache-2.0, created 2026-04-01, currently v0.4.x) on top of its typed API client (`@openrouter/sdk`, Apache-2.0, v0.12.x, still beta). It routes to 300+ models through OpenRouter's unified API, which aligns directly with this plan's stated motivation — if Anthropic gets expensive or open-source models get cheaper, flipping the adapter and keeping the same API surface is attractive. Three caveats to weigh before picking it: (1) the README does not document MCP support, so Callboard's four in-process MCP tool servers would need to be re-wrapped as plain Zod function tools — feasible since they're already Zod-schema-based, but not free; (2) routing via OpenRouter adds a middleman (extra vendor, typical small markup vs direct provider pricing, additional uptime dependency); (3) the agent package is ~3 weeks old with no subagent/handoff or hook primitives documented, and the underlying SDK explicitly warns of breaking changes between versions — too immature to commit to in Q2 2026. Current position: **watch for Phase 4, behind OpenCode and Codex**; promote if it stabilizes and adds MCP.
- **Feature-flag rollout mechanism.** Phase 1 cutover should run both paths in parallel briefly. Do we want a proper feature flag (env var + config) or is a short-lived branch switch sufficient?

---

## Companion Context

- Research report: [`deep-research-claude-agent-sdk-alternatives.md`](../deep-research-claude-agent-sdk-alternatives.md) (full 100-source analysis)
- Research citations: [`deep-research-claude-agent-sdk-alternatives-citations.md`](../deep-research-claude-agent-sdk-alternatives-citations.md)
- Related plans: [`mcp-memory-server.md`](mcp-memory-server.md), [`mcp-channel-bridge.md`](mcp-channel-bridge.md)
