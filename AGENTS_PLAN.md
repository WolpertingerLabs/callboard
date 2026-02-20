# Agents Plan

Autonomous agent management within claude-code-ui — agents with personalities, memory, scheduled tasks, heartbeats, and event-driven behavior that programmatically create and control Claude Code sessions.

**Core insight**: Each agent's workspace directory (`~/.ccui-agents/{alias}/`) is a real Claude Code project. Identity is injected via two complementary layers:
1. **`CLAUDE.md` in the workspace** — Contains the behavioral/workspace protocol (memory rules, safety, heartbeats, group chat etiquette). Auto-loaded by the Claude Code SDK via `settingSources: ["project"]`. This is a copy of the AGENTS.md scaffold template.
2. **`systemPrompt.append` via the SDK** — The agent's structured identity (name, emoji, role, tone, guidelines, user context) is compiled into a markdown string and appended to Claude Code's preset system prompt via `{ type: 'preset', preset: 'claude_code', append: compiledIdentity }`.

This two-layer approach gives clean separation: workspace protocol lives in files the agent can read and reference, while structured identity is injected at the SDK level from form-editable settings.

**Identity model**: Agent identity lives as structured fields in `agent.json` (stored in `data/agents/{alias}/`) — editable via dashboard form fields. No separate `IDENTITY.md` file. The backend compiles these settings into a system prompt append string, giving users a form-based editing experience while producing the rich context the agent needs.

**Connections & triggers model**: External service connections (Discord, GitHub, Slack, Stripe, etc.) and real-time event ingestion are handled entirely by `mcp-secure-proxy` — a separate MCP server that runs as a plugin. The proxy manages authenticated API access, secret storage, and event buffering (WebSocket, webhooks, polling). Agents access these capabilities via MCP tools (`secure_request`, `poll_events`, `list_routes`, `ingestor_status`) that are automatically available when the plugin is enabled. **claude-code-ui does NOT duplicate this infrastructure** — it stores lightweight references to proxy connections (for display/trigger matching), not credentials or connection state.

---

## Current State (Phase 1 + Early Phase 2 — In Progress)

Phase 1 established the foundation: agent CRUD, the full dashboard UI shell, and navigation. Early Phase 2 work has added workspace scaffolding, identity compilation, system prompt injection, and the agent chat flow from the main chat list.

### What Exists Today

**Shared Types** (`shared/types/`)
- `agent.ts` — `AgentConfig` interface with full identity fields:
  ```typescript
  export interface AgentConfig {
    // Core
    name: string;
    alias: string;
    description: string;
    systemPrompt?: string;
    createdAt: number;
    workspacePath?: string; // Resolved server-side, present in API responses

    // Identity (compiled into systemPrompt append)
    emoji?: string;
    personality?: string;
    role?: string;
    tone?: string;
    pronouns?: string;
    languages?: string[];
    guidelines?: string[];

    // User context (compiled into systemPrompt append)
    userName?: string;
    userTimezone?: string;
    userLocation?: string;
    userContext?: string;
  }
  ```
- `agentFeatures.ts` — `CronJob`, `CronAction`, `ActivityEntry` interfaces (ChatMessage, Connection, MemoryItem, Trigger removed — see §2.4)

**Backend** (`backend/src/`)
- `services/agent-file-service.ts` — File-based agent persistence. Stores configs at `data/agents/{alias}/agent.json`. Exports: `isValidAlias`, `agentExists`, `createAgent`, `getAgent`, `listAgents`, `deleteAgent`
- `services/claude-compiler.ts` — Identity compilation and workspace scaffolding:
  - `compileIdentityPrompt(config: AgentConfig): string` — Builds markdown identity string from structured settings (name, emoji, role, personality, tone, pronouns, languages, user context, guidelines). Omits sections with no data.
  - `scaffoldWorkspace(workspacePath: string): void` — Copies all 6 scaffold template files + creates CLAUDE.md (from AGENTS.md) + `memory/` subdirectory. Skips files that already exist.
  - `readWorkspaceFile(workspacePath: string, filename: string): string | undefined` — Helper to read workspace files.
- `services/claude.ts` — Claude Code SDK integration:
  - `sendMessage(opts)` — Creates/resumes Claude sessions via `@anthropic-ai/claude-agent-sdk`
  - `SendMessageOptions` — `{ prompt, chatId?, folder?, defaultPermissions?, maxTurns?, activePlugins?, imageMetadata?, systemPrompt? }`
  - When `systemPrompt` is provided, passes it to the SDK as `{ type: 'preset', preset: 'claude_code', append: systemPrompt }` — appending agent identity to Claude Code's built-in system prompt
  - Returns an `EventEmitter` that emits `StreamEvent`s
  - `respondToPermission(chatId, approved)` — Resolves pending permission requests
  - `getActiveSession(chatId)` / `stopSession(chatId)` — Session lifecycle
- `routes/agents.ts` — Express Router with full CRUD + identity:
  - `GET /api/agents` — List all agents with resolved `workspacePath`
  - `POST /api/agents` — Create agent + scaffold workspace with template files
  - `GET /api/agents/:alias` — Get single agent with `workspacePath`
  - `GET /api/agents/:alias/identity-prompt` — Returns compiled identity prompt string
  - `PUT /api/agents/:alias` — Partial update for all config fields (identity, user context, etc.)
  - `DELETE /api/agents/:alias` — Delete agent + clean up workspace directory
  - Workspace path resolved via `CCUI_AGENTS_DIR` env var (default: `~/.ccui-agents`)
  - Auto-heals missing workspace dirs on GET requests
- `routes/stream.ts` — SSE streaming:
  - `POST /api/stream/new/message` — Start new chat session (accepts optional `systemPrompt` in request body)
  - `POST /api/stream/:chatId/message` — Send message to existing session
  - `GET /api/stream/:chatId/events` — SSE event stream

**Scaffold Templates** (`backend/src/scaffold/`)
- `AGENTS.md` (7.4KB) — Workspace behavioral protocol: session startup sequence, memory protocol (daily journals + MEMORY.md), safety rules, group chat etiquette, heartbeat strategy, platform formatting, memory maintenance
- `SOUL.md` — Personality foundation: core truths, boundaries, vibe, continuity
- `USER.md` — Human context placeholder (name, timezone, location, free-form context)
- `TOOLS.md` — Environment-specific notes placeholder (cameras, SSH, TTS, devices)
- `HEARTBEAT.md` — Empty heartbeat task file (agent populates as needed)
- `MEMORY.md` — Empty curated long-term memory placeholder

On agent creation, all 6 files are copied to the workspace, plus AGENTS.md → CLAUDE.md (the SDK-loaded file).

**Frontend** (`frontend/src/pages/`)
- `ChatList.tsx` — Main chat list with "Claude Code | Agent" mode toggle:
  - Full-width grouped button toggle in the new chat panel
  - Claude Code mode: unchanged (PermissionSettings, recent dirs, FolderSelector)
  - Agent mode: lazily-fetched agent list with selectable cards, "Start Chat" button
  - On agent chat start: fetches compiled identity prompt → navigates to `/chat/new?folder={workspacePath}` with `{ defaultPermissions: allAllow, systemPrompt }` in location state
- `Chat.tsx` — Reads `systemPrompt` from location state, includes it in the new chat stream request body so the backend passes it to the SDK
- `agents/AgentList.tsx` — Agent list page with create/delete, navigation to chat view
- `agents/CreateAgent.tsx` — Agent creation form (name, alias auto-gen, description, system prompt)
- `agents/AgentDashboard.tsx` — Dashboard layout with sidebar nav (desktop) / bottom tab bar (mobile)
- `agents/dashboard/` — Overview, Chat, CronJobs, Connections, Events (was Triggers), Activity, Memory sub-pages (using mock data, to be wired in §2.7)
- `agents/dashboard/mockData.ts` — Mock data powering dashboard pages (to be replaced)
- `api.ts` — Agent API functions: `listAgents`, `getAgent`, `createAgent`, `updateAgent`, `deleteAgent`, `getAgentIdentityPrompt`

**Routing** — Agent routes in `App.tsx`:
```
/agents                    → AgentList
/agents/new                → CreateAgent
/agents/:alias             → AgentDashboard
/agents/:alias/chat        → Chat
/agents/:alias/cron        → CronJobs
/agents/:alias/connections → Connections
/agents/:alias/triggers    → Events (to be renamed)
/agents/:alias/activity    → Activity
/agents/:alias/memory      → Memory
```

**Navigation** — Symmetrical icon buttons: ChatList header has a Bot icon → `/agents`, AgentList header has a MessageSquare icon → `/`

**Data Directory** — `data/agents/` for agent config storage; `~/.ccui-agents/` for agent workspaces

**CSS Variables** — `--success` and `--warning` added for dashboard status indicators

### How Agent Chat Works (End-to-End Flow)

1. User clicks "+" to open new chat panel
2. Toggles to "Agent" mode → sees agent list
3. Selects an agent → clicks "Start Chat"
4. Frontend fetches `GET /api/agents/:alias/identity-prompt` → gets compiled identity string
5. Navigates to `/chat/new?folder={workspacePath}` with `{ defaultPermissions: allAllow, systemPrompt: identityString }` in location state
6. User types a message → `POST /api/chats/new/message` with `{ folder, prompt, defaultPermissions, systemPrompt }`
7. Backend calls `sendMessage({ folder, prompt, defaultPermissions, systemPrompt })` → SDK receives `systemPrompt: { type: 'preset', preset: 'claude_code', append: identityString }`
8. SDK starts session in agent's workspace → auto-loads `CLAUDE.md` (behavioral protocol) via `settingSources: ["project"]` → identity appended to system prompt
9. Agent has full personality: Claude Code tools + identity + workspace protocol + SOUL.md/TOOLS.md etc. in the workspace for reference
10. Chat appears in main chat list like any other chat

---

## mcp-secure-proxy: What It Provides (and What We Don't Need to Build)

`mcp-secure-proxy` is a companion project (`../mcp-secure-proxy`) that runs as an MCP plugin alongside Claude Code sessions. It provides:

### Deployment Model

mcp-secure-proxy runs as a **two-server system**:

1. **Local MCP Proxy** (runs on the same machine as claude-code-ui):
   - Spawned as a stdio child process by Claude Code sessions
   - Holds only its own Ed25519 + X25519 keypair — **no secrets**
   - Encrypts requests, forwards to the remote server via HTTP
   - Auto-discovered via `.mcp.json` in the proxy repo, or installed as a plugin

2. **Remote Secure Server** (runs on a separate machine / cloud VM):
   - Express HTTP server (default port 9999, configurable)
   - Holds all API secrets in environment variables — **secrets never leave this server**
   - Authenticates callers via Ed25519 signature verification
   - Manages ingestors (Discord WebSocket, GitHub webhooks, etc.)
   - Rate-limited per session (default 60 requests/min, configurable via `rateLimitPerMinute`)
   - Session TTL: 30 minutes (auto-reestablishes on 401)

**Security model**: Mutual authentication via Ed25519 signatures (Noise NK-inspired handshake), AES-256-GCM encrypted channel with session keys derived via X25519 ECDH + HKDF-SHA256. Monotonic counters prevent replay/reorder attacks.

### Per-Caller Access Control

Each caller is defined in `remote.config.json` with:
- **`peerKeyDir`**: Path to the caller's Ed25519 public key (for authentication)
- **`connections`**: Array of connection aliases the caller can access (e.g., `["github", "discord-bot"]`)
- **`env`**: Optional per-caller environment variable overrides — allows different secrets for the same connection across callers (e.g., Alice uses her GitHub token, Bob uses his)
- **`ingestorOverrides`**: Per-caller ingestor configuration:
  - `guildIds`, `channelIds`: Filter events to specific Discord guilds/channels
  - `eventFilter`: Only receive specific event types (e.g., `["MESSAGE_CREATE", "REACTION_ADD"]`)
  - `bufferSize`: Override ring buffer capacity (default 200, max 1000)
  - `disabled`: Disable ingestor entirely for this caller

### Already Built — Available via MCP Tools

**Authenticated API Access** (`secure_request` tool):
- 15 pre-configured connection templates: Discord Bot, Discord OAuth, GitHub, Slack, Stripe, Notion, Linear, Trello, Google, Google AI, OpenAI, Anthropic, OpenRouter, Hex, Devin
- Each template defines: allowed endpoint patterns (globs), auto-injected auth headers, required secret names
- Secrets never leave the remote server — zero-knowledge proxy architecture
- Custom connectors can be defined in `remote.config.json`
- The agent calls `secure_request({ method, url, body })` and auth is handled transparently

**Real-Time Event Ingestion** (ingestors):
- **WebSocket ingestors**: Discord Gateway (full implementation with heartbeat, resume, reconnect), Slack Socket Mode
- **Webhook ingestors**: GitHub (HMAC-SHA256), Stripe (with timestamp replay protection), Trello
- **Poll ingestors**: Notion, Linear (interval-based with deduplication)
- Per-caller ring buffers (default 200 events, max 1000) with cursor-based consumption
- Configurable event filtering per caller (by guild, channel, user, event type)
- **Ring buffer eviction**: When full, oldest events are silently evicted on new push. High-traffic sources (e.g., busy Discord guild) can evict events in seconds if the buffer is too small or consumers poll too infrequently.

**Event Consumption** (`poll_events` tool):
- `poll_events(connection?, after_id?)` → returns `IngestedEvent[]`
- Each event has the structure:
  ```typescript
  interface IngestedEvent {
    id: number;           // Monotonically increasing per ingestor (survives evictions)
    receivedAt: string;   // ISO-8601 timestamp
    source: string;       // Connection alias (e.g., "discord-bot", "github")
    eventType: string;    // Source-specific type (e.g., "MESSAGE_CREATE", "push")
    data: unknown;        // Raw payload from external service (structure varies by source)
  }
  ```
- Cursor-based — consumers track their own `after_id` and retrieve only events with `id > after_id`

**Status Monitoring** (`list_routes`, `ingestor_status` tools):
- `list_routes()` → all available connections with endpoint patterns, docs URLs, secret placeholder names (not values), and auto-injected header names
- `ingestor_status()` → live state of all ingestors (connected/reconnecting/error, buffer sizes, total event counts, last event timestamps)

### Wire Protocol (Important for Event Watcher)

The MCP proxy communicates with the remote server via standard HTTP — **not** via the MCP stdio transport. The protocol is:

1. **Handshake**: `POST /handshake/init` → `POST /handshake/finish` (establishes encrypted session)
2. **Requests**: `POST /request` with encrypted body (`ProxyRequest` → `ProxyResponse`)
3. **Session management**: `X-Session-Id` header, 401 on expiry → re-handshake

This means **any process** with the right keypair can talk to the remote server — it doesn't need to be inside a Claude Code session. The event watcher can use the same handshake + encrypted request protocol directly. See Phase 4.3 for details.

### What This Means for the Agents Plan

**ELIMINATED from claude-code-ui (mcp-secure-proxy handles these):**
- ❌ `agent-connections.ts` service — no CRUD for connections in our data layer
- ❌ `connections.json` per agent — no credential storage or connection state
- ❌ `agent-connections.ts` routes — no connection management API
- ❌ `Connection` interface — not our data to model; we query the proxy live
- ❌ OAuth flows & encrypted credential storage — proxy handles all auth securely
- ❌ Connection health monitoring — `ingestor_status` provides this live
- ❌ Custom event ingestion (`event-poller.ts` with its own WebSocket/webhook/poll infrastructure) — proxy already buffers events from all sources; event watcher just calls `poll_events`

**SIMPLIFIED:**
- **Connections page** → becomes a **read-only status view** that calls `list_routes` and `ingestor_status` via the proxy to show which external services are available and their live status. No CRUD — connections are configured in `mcp-secure-proxy`'s `remote.config.json`.
- **Events** → simplified: the event watcher polls `poll_events`, finds agents with subscriptions matching the event source, and wakes them via `executeAgent()`. No condition matching — the agent decides. No need to build our own event ingestion pipeline — we consume the proxy's buffer.
- **Connection type in `AgentConfig`** → not needed. The agent simply has the mcp-secure-proxy plugin enabled, which gives it access to all connections configured for that caller.

**KEPT (still needed in claude-code-ui):**
- ✅ Cron job CRUD — scheduled tasks independent of external events
- ✅ Activity logging — recording what happened (event wakeups, cron executions, sessions)
- ✅ Event watcher — the backend loop that calls `poll_events` and wakes agents that have new events
- ✅ Event subscriptions on `AgentConfig` — lightweight declarations of which connections an agent monitors
- ✅ Dashboard UI for viewing connection status (read-only, from proxy)
- ✅ Dashboard UI for managing cron jobs (CRUD) and event subscriptions (settings)

**REVISED — Triggers eliminated as a CRUD concept:**
- ❌ `Trigger` interface — replaced by lightweight event subscriptions on `AgentConfig`
- ❌ `triggers.json` per agent — no separate trigger storage
- ❌ `agent-triggers.ts` service — no trigger CRUD
- ❌ `agent-triggers.ts` routes — no trigger REST API
- ❌ Triggers dashboard page as CRUD — becomes an event activity/monitoring view
- ❌ Trigger condition language — the **agent** decides how to respond to events via its personality/guidelines, not a condition matcher

**Why**: mcp-secure-proxy is the authoritative source for what events exist. The user configures connections and ingestors in the proxy's `remote.config.json`. claude-code-ui's job is simply to wake agents when new events arrive and let the agent decide what to do. The agent's behavioral response is defined by its personality, guidelines, and HEARTBEAT.md — not by CRUD trigger objects with hardcoded conditions and actions.

---

## Phase 2: Agent Workspace & Memory (Remaining Work)

**Goal**: Complete the workspace-based architecture. Early Phase 2 items (workspace scaffolding, identity compilation, system prompt injection) are done. Remaining work: operational data services, workspace file editing, and wiring the dashboard to real APIs.

### 2.1 — Workspace Directory Structure ✅

Each agent gets a full workspace directory at `~/.ccui-agents/{alias}/`:

```
~/.ccui-agents/{alias}/
├── CLAUDE.md           # Copy of AGENTS.md scaffold — behavioral/workspace protocol
│                       #   Auto-loaded by SDK via settingSources: ["project"]
├── AGENTS.md           # Source behavioral protocol (memory rules, safety, heartbeats, etc.)
├── SOUL.md             # Personality, values, tone, boundaries — who the agent IS
├── USER.md             # Info about the human (name, timezone, preferences)
├── TOOLS.md            # Environment-specific notes (devices, SSH hosts, API keys context)
├── HEARTBEAT.md        # Fluid checklist for heartbeat polls (see Phase 4)
├── memory/
│   ├── YYYY-MM-DD.md   # Daily journals — raw logs of what happened each day
│   └── ...
└── MEMORY.md           # Curated long-term memory — distilled from daily journals
```

**Key principles**:
- **Identity is structured, not markdown.** Agent name, emoji, description, etc. live as fields in `data/agents/{alias}/agent.json`, editable via dashboard form fields. No `IDENTITY.md`.
- **`CLAUDE.md` is a workspace protocol file**, not a compiled identity dump. It contains the behavioral instructions (memory protocol, safety, heartbeats) from the AGENTS.md scaffold. Identity is injected separately via the SDK's `systemPrompt.append`.
- **Workspace markdown files are the agent's own.** `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, and daily journals are read and written by the agent during sessions. The agent maintains its own memory.

### 2.2 — Agent Config & Identity ✅

The `AgentConfig` interface holds comprehensive structured identity settings alongside core fields. See "What Exists Today" above for the full interface.

**What goes where?**
- **Structured settings** (`agent.json` → form fields): Anything that has a clear shape — name, emoji, tone, role, timezone, guidelines. Users shouldn't have to write markdown for these.
- **Free-form markdown** (workspace files → markdown editor): Anything that benefits from narrative or open-ended expression — personality depth (SOUL), extended notes (USER, TOOLS), memory.

### 2.3 — Identity Compilation ✅

**`backend/src/services/claude-compiler.ts`** — Already implemented:
- `compileIdentityPrompt(config)` builds the identity string from structured AgentConfig fields
- `scaffoldWorkspace(workspacePath)` copies template files on agent creation
- Identity is injected via SDK `systemPrompt: { type: 'preset', preset: 'claude_code', append }` — not written to CLAUDE.md

### 2.4 — Revised Shared Types (Partially Complete — Needs Second Pass)

**First pass (done):** Removed `ChatMessage`, `MemoryItem`, `Connection` from shared types. Added `TriggerAction`. Updated `CronJob` with `action`. Updated `ActivityEntry` with `metadata`. Updated frontend mock data with local types.

**Second pass (needed):** Remove `Trigger` and `TriggerAction` from shared types entirely. Triggers are eliminated as a CRUD concept — replaced by event subscriptions on `AgentConfig`.

Changes needed:
- **Remove** `Trigger` interface — no longer a first-class entity
- **Remove** `TriggerAction` interface — cron jobs use a simpler `CronAction` instead
- **Add** `EventSubscription` to `AgentConfig`:
  ```typescript
  export interface EventSubscription {
    connectionAlias: string;    // mcp-secure-proxy connection (e.g., "discord-bot")
    enabled: boolean;           // toggle without removing
  }

  export interface AgentConfig {
    // ... existing fields ...
    eventSubscriptions?: EventSubscription[];
  }
  ```
- **Revise** `CronJob.action` to use a simpler inline type:
  ```typescript
  export interface CronAction {
    type: "start_session" | "send_message";
    prompt?: string;
    folder?: string;
    maxTurns?: number;
  }
  ```
- **Update** `shared/types/index.ts` exports
- **Update** `frontend/.../mockData.ts` — remove mock triggers, update mock cron jobs

**Frontend dashboard components** — Already updated to use local mock types (`MockChatMessage` in `Chat.tsx`, `MockConnection` in `Connections.tsx`). Mock triggers page will be revised in §2.7 to become an event monitoring view.

### 2.5 — Backend Services for Operational Data

Minimal scope — no connections or triggers services needed:

```
data/agents/{alias}/
├── agent.json         # AgentConfig (already exists — now includes eventSubscriptions)
├── cron-jobs.json     # CronJob[]
├── activity.jsonl     # ActivityEntry[] (append-only log)
└── sessions/          # Links to Claude Code sessions
    └── {chatId}.json  # { chatId, startedAt, triggeredBy, status }
```

Create file-based services following the existing `chat-file-service.ts` pattern:

| New File | Responsibility |
|---|---|
| `backend/src/services/agent-cron-jobs.ts` | CRUD for agent cron jobs |
| `backend/src/services/agent-activity.ts` | Append-only activity log (JSONL) |

**Removed:** `agent-connections.ts` — connections are managed by mcp-secure-proxy, not us.
**Removed:** `agent-triggers.ts` — triggers eliminated as CRUD entities. Event subscriptions are stored in `agent.json` as part of `AgentConfig`, managed via the existing `PUT /api/agents/:alias` endpoint.

### 2.6 — Backend Routes (Remaining)

Mount sub-routes under the existing agents router:

| New File | Endpoints |
|---|---|
| `backend/src/routes/agent-workspace.ts` | `GET/PUT /api/agents/:alias/workspace/:filename` — read/write markdown files |
| `backend/src/routes/agent-memory.ts` | `GET /api/agents/:alias/memory` — list dates + read daily/long-term memory; `PUT` to update |
| `backend/src/routes/agent-cron-jobs.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/cron-jobs` |
| `backend/src/routes/agent-activity.ts` | `GET /api/agents/:alias/activity` (with type filter) |

**Removed:** `agent-connections.ts` routes — connections managed by mcp-secure-proxy.
**Removed:** `agent-triggers.ts` routes — triggers eliminated. Event subscriptions are part of `AgentConfig`, managed via `PUT /api/agents/:alias`.

**New proxy passthrough route** (optional, for dashboard convenience):

| New File | Endpoints |
|---|---|
| `backend/src/routes/agent-proxy-status.ts` | `GET /api/proxy/routes` — proxies `list_routes` from mcp-secure-proxy; `GET /api/proxy/ingestors` — proxies `ingestor_status` |

This is optional — the frontend could also call the proxy MCP tools directly via the existing plugin infrastructure. But a thin REST passthrough makes the dashboard simpler (no MCP session needed for read-only status checks).

### 2.7 — Frontend: Dashboard Overhaul

The dashboard sub-pages need significant rework to match the new model:

**Overview page** → Agent identity + settings form + stats:
- Agent header: display name + emoji + role from `AgentConfig`
- **Settings section**: Form fields for all identity settings:
  - Name, emoji picker, description, role, personality, tone (dropdown + custom), pronouns, languages
  - User context: userName, userTimezone (dropdown), userLocation, userContext (textarea)
  - Guidelines: list editor (add/remove/reorder bullet points)
  - Execution: defaultFolder, maxTurns, defaultPermissions, activePlugins
- Saves to `PUT /api/agents/:alias` → updates `agent.json`
- Stat cards: active event subscriptions, cron jobs (from real APIs), proxy connections (from proxy status)
- Recent activity from real activity log

**Memory page** → Becomes a **workspace file editor**:
- Left sidebar: list of workspace files (`SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`)
- Main area: markdown editor for selected file
- Saving a file calls `PUT /api/agents/:alias/workspace/:filename`
- Below or in a tab: daily memory timeline (`memory/YYYY-MM-DD.md`) — read-only viewer with date picker
- `MEMORY.md` section: editable curated long-term memory

**Connections page** → **Read-only proxy status view**:
- Fetches available connections from `list_routes` (via proxy passthrough or MCP)
- Shows live ingestor status from `ingestor_status` (connected/reconnecting/error, buffer sizes, last event time)
- Each connection card: name, description, docs link, allowed endpoints, ingestor state
- No create/edit/delete — connections are configured in mcp-secure-proxy's `remote.config.json`
- Helper text explaining where to configure new connections

**Triggers page → Event Subscriptions & Activity view**:
- Replace trigger CRUD with a two-part page:
  1. **Event subscriptions** — toggle which proxy connections this agent listens to (checkboxes mapped to `AgentConfig.eventSubscriptions[]`). Source list populated from `list_routes`. Saves via `PUT /api/agents/:alias`.
  2. **Event activity feed** — read-only log of recent events received from subscribed connections (filtered view of agent activity where `type === "event"`). Shows source, event type, timestamp, and what the agent did (if anything).
- No condition builder, no action config — the agent's personality/guidelines define how it responds to events.

**CronJobs, Activity** → Wire to real APIs:
- Replace mock data imports with `useEffect` + `useState` API calls
- Wire create/update/delete buttons to real API calls for cron jobs
- Add loading spinners and error states

**Chat page** → Stays mock for now (wired in Phase 3)

**CreateAgent page** → Expanded form:
- Current fields: name, alias, description, system prompt
- Replace "system prompt" textarea with structured identity fields: personality, role, tone, emoji
- Add optional "User context" section: userName, userTimezone
- Keep it simple for creation — full settings editing is on the Overview page after creation

Remove `mockData.ts` when all pages are wired up.

### 2.8 — Verification

- Creating an agent produces a full workspace directory with CLAUDE.md + all scaffold files
- `GET /api/agents/:alias/identity-prompt` returns compiled identity from structured settings
- Starting an agent chat injects identity via SDK systemPrompt.append
- Updating agent settings via PUT persists changes; next chat uses updated identity
- All workspace files are readable/editable via API and dashboard
- Overview page shows all identity fields in form format, saves correctly
- Daily memory files can be viewed by date
- Connections page shows live status from mcp-secure-proxy (routes + ingestors)
- Event subscriptions toggle on/off per connection, persist in `agent.json`
- Cron jobs persist via JSON API (CRUD)
- Activity log records entries and displays correctly with type filters
- `mockData.ts` is fully removed
- Deleting an agent removes both workspace and data directories

---

## Phase 3: Agent Execution Engine

**Goal**: Agents can programmatically create and manage Claude Code sessions. The execution model: compile identity → inject via `systemPrompt.append` → set `folder` to workspace → call `sendMessage()`.

### 3.1 — Agent Executor Service

**New file: `backend/src/services/agent-executor.ts`**

The bridge between agent config and the existing `sendMessage()` function:

```typescript
export interface AgentExecutionOptions {
  agentAlias: string;
  prompt: string;
  folder?: string;              // Override — defaults to agent's workspace path
  triggeredBy?: { type: "cron" | "event" | "heartbeat" | "manual"; id?: string };
  chatId?: string;              // Resume existing session
}

export async function executeAgent(opts: AgentExecutionOptions): Promise<{
  chatId: string;
  emitter: EventEmitter;
}>
```

Key responsibilities:
1. Load the agent's config from `data/agents/{alias}/agent.json`
2. Call `compileIdentityPrompt(config)` to build the identity string
3. Determine `folder` — use override, or agent's `defaultFolder`, or fall back to workspace path
4. Call `sendMessage()` with `{ prompt, folder, defaultPermissions, maxTurns, activePlugins, systemPrompt: identityString }` from agent config
5. Link the created session to the agent in `data/agents/{alias}/sessions/`
6. Log lifecycle events to the agent's activity feed
7. On session complete: append a summary entry to today's `memory/YYYY-MM-DD.md`

**What the executor does NOT do** (because the two-layer prompt handles it):
- ~~Manually build prompts by concatenating personality + context~~ → `compileIdentityPrompt()` builds the identity string, SDK's `systemPrompt.append` injects it
- ~~Write to CLAUDE.md~~ → CLAUDE.md is the static workspace protocol, not dynamically compiled
- ~~Format memory items~~ → Agent reads `MEMORY.md` and daily journals itself per workspace protocol in CLAUDE.md

**mcp-secure-proxy in agent sessions**: The executor ensures `activePlugins` includes the mcp-secure-proxy plugin so agents can call `secure_request`, `poll_events`, etc. during their sessions. The agent gets the same external service access as a regular Claude Code session — no special wiring needed.

Plugin loading for agents:
- mcp-secure-proxy is auto-discovered via `.mcp.json` in its repo, or installed globally as a plugin (`/plugin install mcp-secure-proxy`)
- The SDK spawns the local MCP proxy as a stdio child process when the session starts
- The proxy handles handshake + encrypted communication to the remote server transparently
- All 4 proxy tools (`secure_request`, `poll_events`, `list_routes`, `ingestor_status`) become available in the agent's tool palette
- The agent's identity prompt can reference these tools (e.g., guidelines like "Check Discord for new messages using poll_events")

### 3.2 — Agent Chat Routes

**New file: `backend/src/routes/agent-chat.ts`**

```
POST   /api/agents/:alias/chat/new             — Start new agent session
POST   /api/agents/:alias/chat/:chatId/message  — Send message to existing session
GET    /api/agents/:alias/chat/:chatId/stream    — SSE stream for agent session
GET    /api/agents/:alias/sessions              — List all sessions owned by this agent
```

These routes use `executeAgent()` rather than calling `sendMessage()` directly.

### 3.3 — Frontend Chat Integration

Update `dashboard/Chat.tsx` to replace mock auto-replies with real Claude Code sessions:
- User types message → `POST /api/agents/:alias/chat/new` → streams response via SSE
- Session history pulled from the agent's linked sessions
- Reuse existing SSE consumption patterns from `frontend/src/pages/Chat.tsx`

### 3.4 — Session Ownership

Agent sessions appear in **both** views:
- In the agent's dashboard (under Chat / Sessions) — filtered to that agent's sessions
- In the main chat list (at `/`) — marked with an agent badge so users can see which agent owns which session

Add an `agentAlias` field to the chat metadata so the main ChatList can display ownership.

### 3.5 — Verification

- Start a Claude Code session from the agent dashboard chat
- Agent's identity is injected (verify by checking that it follows personality settings)
- Agent reads its own memory files during the session (per CLAUDE.md workspace protocol)
- Agent can call mcp-secure-proxy tools (secure_request, poll_events) during sessions
- Session appears in both the agent view and the main chat list
- Activity log records session lifecycle events
- Daily memory updated after session completes

---

## Phase 4: Event Watcher & Automation

**Goal**: Agents respond to scheduled tasks, heartbeat polls, and external events without human intervention. External events come from mcp-secure-proxy's ingestors — the **event watcher** polls `poll_events` and wakes agents that have subscriptions to connections with new events. The agent itself decides what to do — no hardcoded conditions or actions.

### 4.1 — Cron Scheduler

**New file: `backend/src/services/cron-scheduler.ts`**

Uses `node-cron` (or similar) to schedule agent executions:

```typescript
export function initScheduler(): void         // On startup: load all active cron jobs
export function scheduleJob(agentAlias: string, job: CronJob): void
export function cancelJob(jobId: string): void
export function pauseJob(jobId: string): void
export function resumeJob(jobId: string): void
```

On fire: calls `executeAgent()` with the job's configured action (folder, prompt template).

Initialize on server startup:
```typescript
import { initScheduler } from "./services/cron-scheduler.js";
initScheduler();
```

### 4.2 — Heartbeat System

**New file: `backend/src/services/heartbeat.ts`**

A heartbeat is a periodic poll that gives the agent a chance to be proactive — check in, review its memory, do background work, or just say "nothing to do." Unlike cron jobs (which execute a specific predefined task), heartbeats are open-ended: the agent reads `HEARTBEAT.md` and decides what to do.

```typescript
export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;      // Default: 30
  quietHoursStart?: string;     // e.g. "23:00" — no heartbeats during quiet hours
  quietHoursEnd?: string;       // e.g. "08:00"
}

export function initHeartbeats(): void           // On startup: load all agents with heartbeats enabled
export function startHeartbeat(agentAlias: string): void
export function stopHeartbeat(agentAlias: string): void
export function updateHeartbeatConfig(agentAlias: string, config: HeartbeatConfig): void
```

On each heartbeat tick:
1. Check quiet hours — skip if in range
2. Call `executeAgent()` with the default heartbeat prompt:
   `"Read HEARTBEAT.md if it exists. Follow it. If nothing needs attention, reply HEARTBEAT_OK."`
3. The agent decides what to do — check emails, review memory, do background work, or return `HEARTBEAT_OK`
4. If the agent responds `HEARTBEAT_OK`, log it lightly (no full activity entry)
5. If the agent takes action, log to activity feed

**Heartbeat vs Cron**:
- **Cron** = precise schedule, specific task, isolated session ("run this report every Monday at 9am")
- **Heartbeat** = periodic check-in, agent decides what to do, fluid and adaptive ("anything need attention?")

Add `heartbeat` field to `AgentConfig`:
```typescript
export interface AgentConfig {
  // ... existing fields ...
  heartbeat?: HeartbeatConfig;
}
```

### 4.3 — Event Watcher (Consuming mcp-secure-proxy Events)

**New file: `backend/src/services/event-watcher.ts`**

The event watcher is a backend polling loop that periodically calls mcp-secure-proxy's `poll_events` and wakes agents that have subscriptions matching the connection source of new events. **There is no condition matching or action config** — the agent receives the event data and decides what to do based on its personality, guidelines, and HEARTBEAT.md.

**Key insight**: mcp-secure-proxy is the **authoritative source** for what events exist. Users configure connections and ingestors in the proxy's `remote.config.json`. claude-code-ui simply subscribes agents to connections and wakes them when new events arrive. The agent's behavioral response is determined by its personality/guidelines — not by trigger objects with hardcoded conditions.

```typescript
export function initEventWatcher(): void      // On startup: begin polling loop
export function stopEventWatcher(): void
```

**Polling loop** (runs every 5-10 seconds):
1. Call `poll_events(after_id)` via the proxy — gets all new events since last cursor
2. For each event, find agents whose `eventSubscriptions` include the event's `source` (connection alias) and are `enabled: true`
3. For each matching agent: call `executeAgent()` with a prompt containing the event data:
   ```
   New event from {source}:
   Type: {eventType}
   Received: {receivedAt}
   Data: {JSON.stringify(data, null, 2)}

   Respond according to your guidelines. If this event doesn't require action, reply EVENT_NOTED.
   ```
4. Log to the agent's activity feed (type: `"event"`)
5. Update cursor for next poll

**What the event watcher does NOT do** (because the agent handles it):
- ❌ Condition matching (no `contains("urgent")`, `channel("#alerts")`, regex patterns)
- ❌ Action configuration (no prompt templates, folder overrides, maxTurns per trigger)
- ❌ Event type filtering — the agent receives all events from its subscribed connections and decides relevance
- ❌ Trigger CRUD — no create/update/delete triggers, just enable/disable connection subscriptions

**What the agent CAN do in response to events**:
- Read the event data and decide it's not relevant → reply `EVENT_NOTED`
- Post a message to Slack/Discord via `secure_request`
- Start a complex workflow (read files, make API calls, update memory)
- Update its own HEARTBEAT.md with follow-up tasks
- Anything else within its capabilities — it's a full Claude Code session

#### 4.3.1 — How the Event Watcher Talks to the Proxy

The event watcher runs in the Express backend — **outside** of any Claude Code session. It cannot use MCP tools directly (those are only available inside SDK sessions via stdio transport). Instead, it communicates with the proxy's remote server using the **same HTTP wire protocol** that the MCP proxy itself uses:

1. **Handshake**: `POST {remoteUrl}/handshake/init` + `POST {remoteUrl}/handshake/finish` — establishes an encrypted session using Ed25519 + X25519 key exchange
2. **Encrypted requests**: `POST {remoteUrl}/request` with `X-Session-Id` header — sends `ProxyRequest` (tool name + input), receives `ProxyResponse`
3. **Session management**: 30-minute TTL, 401 on expiry → re-handshake automatically

**Implementation**: Import `HandshakeInitiator`, `EncryptedChannel`, and `ProxyRequest`/`ProxyResponse` types from the proxy's shared libraries (or vendor a lightweight client). The event watcher authenticates as its own **dedicated caller** (e.g., `"event-watcher"`) configured in `remote.config.json` with access to all connections that have ingestors.

```typescript
// Conceptual: event-watcher.ts
import { HandshakeInitiator, EncryptedChannel } from 'mcp-secure-proxy/shared';

let channel: EncryptedChannel | null = null;

async function pollEvents(afterId?: number): Promise<IngestedEvent[]> {
  if (!channel) channel = await establishChannel(); // handshake
  const request: ProxyRequest = {
    type: 'proxy_request',
    id: crypto.randomUUID(),
    toolName: 'poll_events',
    toolInput: { after_id: afterId },
    timestamp: Date.now(),
  };
  const encrypted = channel.encryptJSON(request);
  const resp = await fetch(`${remoteUrl}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': channel.sessionId },
    body: new Uint8Array(encrypted),
  });
  if (resp.status === 401) { channel = null; return pollEvents(afterId); } // re-auth
  const decrypted = channel.decryptJSON(await resp.arrayBuffer()) as ProxyResponse;
  return decrypted.result as IngestedEvent[];
}
```

**Caller configuration** in `remote.config.json`:
```json
{
  "callers": {
    "event-watcher": {
      "peerKeyDir": "/path/to/keys/peers/event-watcher",
      "connections": ["discord-bot", "github", "slack", "stripe"]
    }
  }
}
```

**Rate limiting**: The event watcher polling loop (every 5-10s) consumes ~6-12 requests/min, well under the default 60/min rate limit. If the watcher also needs to call `ingestor_status` or `list_routes` for dashboard passthrough, that adds a few more but stays well within limits.

#### 4.3.2 — Ring Buffer Eviction & Event Loss

Events can be lost if the event watcher doesn't consume them fast enough:

- Default ring buffer: **200 events** per (caller, connection) pair
- Max configurable: **1000 events** via `ingestorOverrides.bufferSize`
- When the buffer is full, the oldest event is silently evicted on each new push

**Risk scenarios**:
- High-traffic Discord guild: 500+ events/min → buffer fills in <30 seconds at default size
- If event watcher polls every 10 seconds with buffer size 200, it can handle ~20 events/sec safely
- If the watcher stalls for 60+ seconds (e.g., too many agent wake-ups blocking the loop), events may be lost

**Mitigations**:
- Poll every 5 seconds (12 requests/min — well within rate limits)
- Increase `bufferSize` to 500-1000 for high-traffic connections via `ingestorOverrides`
- Wake agents asynchronously (don't block the poll loop waiting for `executeAgent()` to complete)
- Monitor buffer utilization via `ingestor_status` — alert when `bufferedEvents` approaches capacity

#### 4.3.3 — Event Watcher Resilience

When the proxy remote server is unavailable:

- Poll requests fail with network errors or timeouts
- The watcher catches exceptions, logs a warning, and retries on the next cycle
- Events continue buffering on the remote server (if it's running but the event watcher can't reach it)
- If the remote server is actually down, ingestors stop receiving events too — so no data loss from the watcher's perspective

**Degradation behavior**:
- Agent sessions started manually (via dashboard chat) still work — they connect to the proxy independently
- Event-based and heartbeat-based sessions that rely on `poll_events` won't fire during outage
- Cron jobs are unaffected (they don't depend on the proxy)
- On recovery, the watcher resumes from its last cursor — picks up any events still in the buffer

**Monitoring**:
- Log consecutive poll failures; alert after 5+ failures (~25-50 seconds of outage)
- Exponential backoff on repeated failures (5s → 10s → 20s → 60s max)
- Dashboard shows event watcher status (healthy / degraded / disconnected) on the Connections page

### 4.4 — Frontend Wiring

- **CronJobs page**: "New Job" button opens a form to configure schedule, prompt template, folder → calls backend CRUD
- **Event Subscriptions** (on Events page): Toggle switches for each available connection (from `list_routes`), saves to `AgentConfig.eventSubscriptions` via `PUT /api/agents/:alias`
- **Overview page**: Heartbeat toggle + interval config in agent settings section
- CronJobs page shows real-time status (last triggered, next run) from persisted data
- Activity page shows event/cron/heartbeat executions with source and event data

### 4.5 — Verification

- Event watcher authenticates to proxy remote server as its own caller and polls events
- Cron jobs execute on schedule and create Claude Code sessions
- Heartbeat polls fire at configured intervals, agent reads HEARTBEAT.md and acts or replies HEARTBEAT_OK
- Quiet hours respected for heartbeats
- Discord messages (buffered by mcp-secure-proxy) wake agents with Discord event subscriptions
- GitHub webhooks (received by mcp-secure-proxy) wake agents with GitHub event subscriptions
- Agent receives full event data and decides behavioral response (no condition matching)
- Agent can reply EVENT_NOTED for irrelevant events (no full session cost)
- Activity log shows all event/cron/heartbeat executions with event metadata
- Multiple agents can fire concurrently without interference
- Disabling an event subscription stops the agent from being woken for that connection
- Event watcher gracefully handles proxy being unavailable (backoff, resume from cursor)
- Ring buffer eviction doesn't cause silent failures — monitored via ingestor_status
- Rate limiting doesn't throttle the event watcher's polling loop (stays under 60/min)

---

## Phase 5: Advanced Features

Natural extensions once the core pipeline is working.

### 5.1 — Agent Memory Auto-Update
- After sessions complete, agent can update its own `MEMORY.md` and daily journals (it already has write access to its workspace)
- During heartbeats, agent can review recent daily files and curate `MEMORY.md` (like a human reviewing their journal)
- The workspace protocol in CLAUDE.md already includes guidance for memory maintenance

### 5.2 — Agent-to-Agent Communication
- Agents can reference and invoke other agents
- Shared memory pools between related agents
- Agent orchestration workflows (agent A triggers agent B on completion)
- Parent/child agent relationships

### 5.3 — Dashboard Real-Time Updates
- WebSocket or SSE for live activity feed updates
- Real-time session status across all agents
- Notification system for pending permission approvals
- Agent status indicators (idle, running, heartbeat active, waiting for approval)
- Live proxy ingestor status (event counts updating in real-time)

### 5.4 — Agent Templates
- Pre-built agent configurations for common use cases
- "Code Reviewer", "CI Monitor", "Discord Bot", "Documentation Writer"
- Import/export full agent workspaces as archives

### 5.5 — Multi-Session Management
- Agent can run multiple concurrent sessions
- Session pool with configurable concurrency limits
- Queue system for excess requests when at capacity

### 5.6 — Advanced Proxy Integration
- Per-agent proxy caller profiles (different agents get different connection access via separate callers in `remote.config.json`)
- Per-agent ingestor overrides (different event filters, buffer sizes per agent/caller)
- Dashboard UI for managing proxy `remote.config.json` (add connections, manage callers, configure ingestor overrides)
- Proxy connection health alerts in agent activity feed (ingestor disconnections, buffer near-full warnings)
- Proxy rate limit monitoring (track requests/min per session, alert on throttling)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                          │
├───────────────┬──────────────────────────────────────────────────┤
│  Chat View    │              Agent Dashboard                     │
│  (existing)   │  ┌──────────────────────────────────────────┐   │
│               │  │ Overview │ Chat │ Cron │ Connections │ ...│   │
│  /            │  │          │      │      │             │    │   │
│  /chat/:id    │  └──────────────────────────────────────────┘   │
│               │  /agents/:alias/*                                │
│  New chat:    │                                                  │
│  Claude Code  │  Overview page = identity settings form          │
│  | Agent      │  Memory page = workspace file editor             │
│  (toggle)     │  Connections page = read-only proxy status       │
│               │  Events page = subscriptions + event activity    │
│  Agent mode:  │  CronJobs page = CRUD (independent schedules)    │
│  select agent │  Activity page = audit log                       │
│  → Start Chat │                                                  │
├───────────────┴──────────────────────────────────────────────────┤
│                     Express Backend (API)                         │
├──────────────────────────────────────────────────────────────────┤
│  /api/stream/*     │  /api/agents/*         │  /api/agents/:alias│
│  (SSE — accepts    │  (agent CRUD +         │  /identity-prompt  │
│   systemPrompt)    │   PUT updates incl.    │  /workspace/:file  │
│                    │   eventSubscriptions)  │  /memory            │
│                    │                        │  /cron-jobs         │
│                    │                        │  /activity          │
│                    │                        │  /chat              │
│                    │                        │  /sessions          │
│                    │                        │                     │
│  /api/proxy/*      │                        │                     │
│  (passthrough to   │                        │                     │
│   mcp-secure-proxy │                        │                     │
│   for dashboard)   │                        │                     │
├──────────────────────────────────────────────────────────────────┤
│                       Services Layer                              │
├──────────┬───────────┬──────────┬─────────┬──────────────────────┤
│ claude.ts│ agent-    │ claude-  │ cron-   │ event-watcher        │
│ (SDK)    │ executor  │ compiler │ sched.  │                      │
│          │           │          │         │ polls mcp-secure-    │
│ sendMsg()│ identity  │ compile  │ node-   │ proxy poll_events    │
│ SSE      │ + folder  │ Identity │ cron    │ → finds agents with  │
│ perms    │ + config  │ Prompt() │ specific│   matching subs      │
│ system-  │ + plugins │ scaffold │ tasks   │ → executeAgent()     │
│ Prompt   │ → sendMsg │ Wkspace()│→executor│ heartbeat.ts         │
│          │           │          │         │ periodic check-ins   │
│          │           │          │         │ → executeAgent()     │
├──────────┴───────────┴──────────┴─────────┴──────────────────────┤
│                       Storage                                     │
├─────────────────────────────┬────────────────────────────────────┤
│  App Data (data/)           │  Agent Workspaces (~/.ccui-agents/) │
│  ├── chats/ (existing)      │  └── {alias}/                      │
│  └── agents/{alias}/        │      ├── CLAUDE.md  ← AGENTS.md   │
│      ├── agent.json         │      ├── AGENTS.md  (protocol)    │
│      │   (incl. eventSubs)  │      ├── SOUL.md                   │
│      ├── cron-jobs.json     │      ├── USER.md                   │
│      ├── activity.jsonl     │      ├── TOOLS.md                  │
│      └── sessions/          │      ├── HEARTBEAT.md              │
│                             │      ├── MEMORY.md                 │
│                             │      └── memory/                   │
│                             │          └── YYYY-MM-DD.md         │
├─────────────────────────────┴────────────────────────────────────┤
│                     mcp-secure-proxy (MCP Plugin)                 │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Runs as MCP server alongside Claude Code sessions          │ │
│  │  Provides: secure_request, poll_events, list_routes,        │ │
│  │            ingestor_status                                   │ │
│  │                                                              │ │
│  │  Manages (remote server):                                    │ │
│  │  - Authenticated API access (15+ services)                  │ │
│  │  - Secret storage (zero-knowledge, never leaves remote)     │ │
│  │  - Real-time event ingestion:                               │ │
│  │    • WebSocket: Discord Gateway, Slack Socket Mode          │ │
│  │    • Webhooks: GitHub, Stripe, Trello (HMAC verified)       │ │
│  │    • Polling: Notion, Linear (interval + dedup)             │ │
│  │  - Per-caller ring buffers (200-1000 events)                │ │
│  │  - Cursor-based event consumption via poll_events           │ │
│  │  - AUTHORITATIVE source for events — agents subscribe,     │ │
│  │    not define triggers                                      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Two-Layer Prompt Architecture:**
```
                SDK systemPrompt.append              SDK settingSources: ["project"]
                ┌──────────────────────┐             ┌─────────────────────────────┐
                │  Compiled Identity   │             │  CLAUDE.md (workspace)      │
                │  from AgentConfig:   │             │  = AGENTS.md scaffold:      │
                │  - Name, emoji, role │             │  - Session startup sequence │
                │  - Personality, tone │             │  - Memory protocol          │
                │  - User context      │             │  - Safety rules             │
                │  - Guidelines        │             │  - Heartbeat strategy       │
                └──────────┬───────────┘             │  - Group chat etiquette     │
                           │                         └──────────────┬──────────────┘
                           ▼                                        ▼
                ┌──────────────────────────────────────────────────────┐
                │              Claude Code Session                     │
                │  Claude Code preset system prompt                    │
                │  + appended identity (systemPrompt.append)           │
                │  + CLAUDE.md workspace protocol (settingSources)     │
                │  + cwd = ~/.ccui-agents/{alias}/                     │
                │  + mcp-secure-proxy plugin (secure_request,          │
                │    poll_events, list_routes, ingestor_status)        │
                └──────────────────────────────────────────────────────┘
```

**Event Flow (Event Watcher Pipeline):**
```
External Service          mcp-secure-proxy              claude-code-ui
                          (remote server)               (event watcher)

Discord msg ──────────►  Discord Gateway     ──┐
GitHub webhook ────────►  GitHub Webhook      ──┼──► Ring Buffer (per caller)
Stripe event ──────────►  Stripe Webhook      ──┤         │
Notion update ─────────►  Notion Poller       ──┘         │
                                                          │ poll_events(after_id)
                                                          ◄─────────────────────
                                                          │
                                                    IngestedEvent[]
                                                          │
                                              ┌───────────▼───────────┐
                                              │   Event Watcher       │
                                              │   Find agents with    │
                                              │   matching event      │
                                              │   subscriptions       │
                                              └───────────┬───────────┘
                                                          │ subscription match
                                              ┌───────────▼───────────┐
                                              │   executeAgent()      │
                                              │   identity + prompt   │
                                              │   + full event data   │
                                              └───────────┬───────────┘
                                                          │
                                              ┌───────────▼───────────┐
                                              │   Claude Code Session │
                                              │   Agent receives full │
                                              │   event, decides what │
                                              │   to do (or ignores)  │
                                              └───────────────────────┘
```

---

## Implementation Order & Dependencies

```
Phase 1 ✅  Foundation (agent CRUD, dashboard UI, navigation)
    │
    ├── ✅  Agent chat mode (Claude Code | Agent toggle in new chat panel)
    ├── ✅  Workspace path support (resolved server-side, API responses)
    ├── ✅  Scaffold templates (AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, MEMORY.md)
    ├── ✅  Workspace scaffolding on agent creation
    ├── ✅  AgentConfig expanded (identity + user context fields)
    ├── ✅  Identity compilation (compileIdentityPrompt → systemPrompt.append)
    ├── ✅  SDK systemPrompt passthrough (claude.ts → stream.ts → frontend)
    ├── ✅  PUT /api/agents/:alias (partial config update)
    ├── ✅  GET /api/agents/:alias/identity-prompt
    │
    ▼
Phase 2     Workspace & Memory (remaining)
    │       - §2.4: Revised types — second pass (remove Trigger/TriggerAction,
    │         add EventSubscription to AgentConfig, add CronAction)
    │       - §2.5: Operational data services (cron, activity — NO connections or triggers)
    │       - §2.6: Workspace file read/write API endpoints + cron/activity routes
    │       - §2.7: Dashboard: Overview → settings form, Memory → file editor
    │       - §2.7: Dashboard: Connections → read-only proxy status
    │       - §2.7: Dashboard: Events page → subscriptions + event activity feed
    │       - §2.7: Wire dashboard pages to real APIs, remove mockData.ts
    │       - §2.7: CreateAgent form expansion (structured identity fields)
    │
    ▼
Phase 3     Execution Engine
    │       - Thin executor: compileIdentityPrompt() + folder + config → sendMessage()
    │       - Ensures mcp-secure-proxy plugin is active for agent sessions
    │       - Agent chat routes + SSE streaming
    │       - Frontend chat wired to real sessions
    │       - Session ownership (agent badge in main chat list)
    │       Depends on: Phase 2 (workspace, activity logging)
    │
    ▼
Phase 4     Event Watcher & Automation
    │       - Cron scheduler (specific scheduled tasks)
    │       - Heartbeat system (periodic open-ended check-ins)
    │       - Event watcher: dedicated caller in remote.config.json
    │         → authenticates via same HTTP wire protocol as MCP proxy
    │         → polls poll_events(after_id) every 5s
    │         → finds agents with matching event subscriptions
    │         → executeAgent() with full event data — agent decides response
    │       - NO condition language — agent personality defines behavior
    │       - NO trigger CRUD — just enable/disable event subscriptions
    │       - Ring buffer monitoring & resilience (backoff, cursor tracking)
    │       - NO custom event ingestion — mcp-secure-proxy handles all of that
    │       Depends on: Phase 3 (executeAgent)
    │
    ▼
Phase 5     Advanced Features
            - Memory auto-update, agent-to-agent, templates, real-time dashboard
            - Advanced proxy integration (per-agent caller profiles, config UI)
            Depends on: Phase 4 (working automation pipeline)
```

Each phase is independently deployable — the app works after each phase, with progressively more functionality.
