# Plan: Codex Adapter

Add OpenAI Codex as the second agent provider in callboard, building on the AgentProvider (PR #125) and SessionProvider (PR #126) abstractions.

Status: **Not started.** Prerequisites landed.

---

## Prerequisites (done)

- AgentProvider port + ClaudeCodeAdapter (PR #125)
- SessionProvider port + ClaudeCodeSessionProvider (PR #126)
- `AgentProviderKind` already includes `"codex"`
- Factory supports multi-provider session discovery

## Package

- `@openai/codex-sdk` (v0.128.0+, Apache-2.0, Node 18+)
- Wraps the `codex` Rust CLI binary — spawns as subprocess, exchanges JSONL over stdin/stdout
- Thread/Turn model with streaming via `thread.runStreamed()`

## Architecture

```
backend/src/agents/adapters/codex/
  CodexAdapter.ts               # AgentProvider — thread management + query
  CodexSessionProvider.ts       # SessionProvider — scans ~/.codex/sessions/
  messageAdapter.ts             # Codex stream events → AgentEvent union
  sessionParser.ts              # Codex session files → ParsedMessage[]
  optionsAdapter.ts             # Callboard options → ThreadOptions/TurnOptions
  permissionAdapter.ts          # Codex item types → PermissionCategory
  toolAdapter.ts                # ToolServerSpec → MCP stdio server for Codex
```

## Phase 1: CodexAdapter (agent execution)

### Codex SDK Integration

```ts
import { Codex } from "@openai/codex-sdk";

class CodexAdapter implements AgentProvider {
  readonly kind = "codex" as const;
  private codex: Codex;

  constructor(opts: { apiKey?: string; baseUrl?: string; env?: Record<string,string> }) {
    this.codex = new Codex({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      env: opts.env,
      skipGitRepoCheck: true,
    });
  }

  query(req: AgentQueryRequest): AgentQuery {
    // Start or resume thread, return CodexAgentQuery wrapper
  }

  buildToolServer(spec: ToolServerSpec): unknown {
    // Build MCP stdio server config for Codex to connect to
  }
}
```

### Event Translation (messageAdapter.ts)

| Codex Event | AgentEvent |
|-------------|------------|
| `ThreadStartedEvent` | `{ type: "session_started", sessionId: threadId }` |
| `ItemUpdatedEvent` (agentMessage delta) | `{ type: "text", content: delta }` |
| `ItemStartedEvent` (reasoning) | `{ type: "thinking", content }` |
| `ItemStartedEvent` (commandExecution) | `{ type: "tool_use", toolName: "Bash" }` |
| `ItemCompletedEvent` (commandExecution) | `{ type: "tool_result", content: output }` |
| `ItemStartedEvent` (fileChange) | `{ type: "tool_use", toolName: "Edit" }` |
| `ItemCompletedEvent` (fileChange) | `{ type: "tool_result", content: diff }` |
| `ItemStartedEvent` (mcpToolCall) | `{ type: "tool_use", toolName: server__tool }` |
| `ItemCompletedEvent` (mcpToolCall) | `{ type: "tool_result" }` |
| `ItemStartedEvent` (webSearch) | `{ type: "tool_use", toolName: "WebSearch" }` |
| `ItemCompletedEvent` (webSearch) | `{ type: "tool_result" }` |
| `contextCompaction` | `{ type: "compaction_boundary" }` |
| `TurnCompletedEvent` | `{ type: "result", status: "success", usage, durationMs }` |
| `TurnFailedEvent` | `{ type: "result", status: "error", reason }` |

### Options Translation (optionsAdapter.ts)

| Callboard Option | Codex ThreadOption |
|------------------|--------------------|
| `cwd` / folder | `working_directory` |
| `systemPrompt` | `model_instructions_file` (write temp file) |
| `maxTurns` | `max_threads` (approximate) |
| DefaultPermissions | `sandbox_mode` + `approval_policy` mapping (see below) |
| `model` | `model` |
| `resume: sessionId` | `codex.resumeThread(threadId)` |

### Permission Mapping

| Callboard Permissions | Codex Sandbox | Codex Approval |
|-----------------------|---------------|----------------|
| All deny | `read-only` | `on-request` |
| fileRead allow | `read-only` | varies |
| fileWrite allow | `workspace-write` | varies |
| codeExecution allow + fileWrite allow | `danger-full-access` | varies |
| Any permission is "ask" | (as above) | `on-request` |
| All permissions allow | (as above) | `never` |

### MCP Tool Exposure (toolAdapter.ts)

Codex is an MCP *client* — it connects to external MCP servers. Callboard's tools (callboard-tools, agent-tools, proxy-tools) need to be served as MCP stdio servers that Codex can connect to.

Approach: Build a thin Node script launcher from `ToolServerSpec`. For each spec, spawn a child process that serves the tools over MCP stdio protocol. Return a config object pointing Codex to the spawn command.

```ts
// Codex config shape for MCP servers
{
  mcp_servers: {
    "callboard-tools": {
      command: "node",
      args: ["/path/to/mcp-server-shim.js", "--spec=callboard-tools"],
      env: { ... }
    }
  }
}
```

### Session Close / Abort

Codex SDK currently lacks `abort()` (GitHub issue #5494). Two options:
1. Use the app-server's `turn/interrupt` call at the protocol level
2. Kill the Codex subprocess (less graceful but works)

Start with option 2; upgrade when the SDK adds native abort.

## Phase 2: CodexSessionProvider (session discovery)

### Storage Location

Codex stores threads in `~/.codex/sessions/`. The exact format needs investigation — it may be JSONL, SQLite, or JSON files.

### Implementation

```ts
class CodexSessionProvider implements SessionProvider {
  readonly kind = "codex" as const;

  discoverSessions(opts) {
    // Scan ~/.codex/sessions/, stat files, sort by mtime
  }

  resolveSession(sessionId) {
    // Find session file by threadId
  }

  findSubagentFiles(sessionId) {
    // Codex has collabToolCall items for multi-agent;
    // check if they create separate session files
  }

  parseSessionMessages(sessionIds) {
    // Read Codex session format, translate to ParsedMessage[]
    // Map: agentMessage → text, commandExecution → tool_use/tool_result,
    //       fileChange → tool_use/tool_result, etc.
  }

  getSessionPreview(logPath, maxLength?) {
    // Extract first user message from session file
  }

  searchSessions(filters) {
    // Search session files by folder/content
  }

  deleteSessionFiles(sessionId) {
    // Remove session file from ~/.codex/sessions/
  }
}
```

## Phase 3: Shared Types + Settings

### AgentSettings Extension

```ts
// shared/types/agentSettings.ts additions
provider?: "claude-code" | "codex";
codexApiKey?: string;       // OPENAI_API_KEY
codexBaseUrl?: string;      // openai_base_url config override
codexModel?: string;        // default model (e.g. "gpt-5.5", "o3")
codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
```

### Chat Metadata

Store `provider: "codex"` in chat metadata when creating Codex sessions. Used by the messages endpoint to route to the correct SessionProvider.

### Factory Changes

```ts
export function getAgentProvider(kind?: AgentProviderKind): AgentProvider {
  // Returns per-kind singleton
  // sendMessage resolves kind from chat metadata or settings
}
```

## Phase 4: Frontend UI

### ApiSettings.tsx — Provider Configuration

Add a provider selector toggle at the top. Conditionally render:
- Claude Code fields (API key, auth token, model overrides)
- Codex fields (OpenAI API key, base URL, model, sandbox mode)

### NewChatPanel.tsx — Per-Chat Provider Override

Optional provider selector in the collapsible settings, below permissions. Default inherits from ApiSettings.

### Chat.tsx — Provider Badge

Small badge in chat header showing which provider the chat uses. Read from chat metadata.

### MessageBubble.tsx / ToolCallBubble.tsx

No changes needed — the messageAdapter normalizes Codex item types to the same tool_use/tool_result events that Claude produces. Tool names may differ (commandExecution vs Bash) but the adapter normalizes them.

## Phase 5: Quick Completions

Two options:
1. **Keep Claude for quick completions** regardless of session provider (simpler, lower latency)
2. **Use Codex's `output_schema`** for structured output (title generation, branch names)

Start with option 1. Codex structured output can be explored later.

## Implementation Order

| Step | What | Est. |
|------|------|------|
| 1 | Install `@openai/codex-sdk`, verify it works standalone | 1h |
| 2 | `CodexAdapter` skeleton (kind, query stub) | 2h |
| 3 | `messageAdapter.ts` — event translation + tests | 4h |
| 4 | `optionsAdapter.ts` — permission/option mapping + tests | 2h |
| 5 | `toolAdapter.ts` — MCP stdio server launcher | 4-8h |
| 6 | Wire `CodexAdapter.query()` end-to-end | 4h |
| 7 | `CodexSessionProvider` — discover + parse | 4-8h |
| 8 | Factory multi-provider wiring | 2h |
| 9 | `sendMessage()` provider selection | 2h |
| 10 | Store provider in chat metadata | 1h |
| 11 | Frontend: ApiSettings provider selector | 4h |
| 12 | Frontend: NewChatPanel provider override | 2h |
| 13 | Frontend: Chat header provider badge | 1h |
| 14 | Frontend: shared types update | 1h |
| 15 | Integration testing | 4h |

## Key Risks

1. **MCP tool server exposure** (Step 5): Highest-risk piece. Codex needs to *connect* to MCP servers, not have them injected in-process. Start with a single tool, test connectivity before wiring all 48.

2. **No abort()**: SDK lacks native cancel. Kill subprocess as workaround. Monitor GitHub issue #5494.

3. **Session format instability**: Codex's `~/.codex/sessions/` format may change between versions. Keep the SessionProvider thin and version-check on startup.

4. **Codex requires git repo**: Default behavior requires a git repo. Pass `skipGitRepoCheck: true` when needed.

5. **Quick completion path**: Different cost profile. Keep on Claude initially.

## References

- `@openai/codex-sdk` npm: https://www.npmjs.com/package/@openai/codex-sdk
- Codex SDK docs: https://developers.openai.com/codex/sdk
- Codex app-server protocol: https://developers.openai.com/codex/app-server
- Codex config reference: https://developers.openai.com/codex/config-reference
- Codex agent approvals: https://developers.openai.com/codex/agent-approvals-security
- Abort feature request: https://github.com/openai/codex/issues/5494
