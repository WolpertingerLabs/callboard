# Agents Plan

Autonomous agent management within claude-code-ui — agents with personalities, memory, scheduled tasks, and external triggers that programmatically create and control Claude Code sessions.

---

## Current State (Phase 1 — Complete)

Phase 1 established the foundation: agent CRUD, the full dashboard UI shell, and navigation between the chat and agent views.

### What Exists Today

**Shared Types** (`shared/types/`)
- `agent.ts` — `AgentConfig` interface: `{ name, alias, description, systemPrompt?, createdAt }`
- `agentFeatures.ts` — `ChatMessage`, `CronJob`, `Connection`, `Trigger`, `ActivityEntry`, `MemoryItem` interfaces

**Backend** (`backend/src/`)
- `services/agent-file-service.ts` — File-based agent persistence. Stores configs at `data/agents/{alias}/agent.json`. Exports: `isValidAlias`, `agentExists`, `createAgent`, `getAgent`, `listAgents`, `deleteAgent`
- `routes/agents.ts` — Express Router with CRUD endpoints: `GET /api/agents`, `POST /api/agents`, `GET /api/agents/:alias`, `DELETE /api/agents/:alias`. Validation for name (1-128), alias (lowercase alphanumeric, 2-64), description (1-512), systemPrompt (optional)

**Frontend** (`frontend/src/pages/agents/`)
- `AgentList.tsx` — Agent list page with create/delete, navigation to chat view
- `CreateAgent.tsx` — Agent creation form (name, alias auto-gen, description, system prompt)
- `AgentDashboard.tsx` — Dashboard layout with sidebar nav (desktop) / bottom tab bar (mobile), uses `useOutletContext` to pass agent data to sub-pages
- `dashboard/Overview.tsx` — Stat cards, quick actions, recent activity feed
- `dashboard/Chat.tsx` — Chat interface with mock auto-replies
- `dashboard/CronJobs.tsx` — Scheduled task cards with pause/resume toggles
- `dashboard/Connections.tsx` — Service integration cards grid with connect/disconnect
- `dashboard/Triggers.tsx` — Event trigger cards with enable/pause
- `dashboard/Activity.tsx` — Timeline with type-based filter pills
- `dashboard/Memory.tsx` — Searchable, expandable key-value store with category badges
- `dashboard/mockData.ts` — Mock data powering all dashboard pages (to be replaced)

**Routing** — Agent routes in `App.tsx`:
```
/agents                    → AgentList
/agents/new                → CreateAgent
/agents/:alias             → AgentDashboard
/agents/:alias/chat        → Chat
/agents/:alias/cron        → CronJobs
/agents/:alias/connections → Connections
/agents/:alias/triggers    → Triggers
/agents/:alias/activity    → Activity
/agents/:alias/memory      → Memory
```

**Navigation** — Symmetrical icon buttons: ChatList header has a Bot icon → `/agents`, AgentList header has a MessageSquare icon → `/`

**Data Directory** — `data/agents/` for agent config storage

**CSS Variables** — `--success` and `--warning` added for dashboard status indicators

### Key Integration Points

The existing Claude Code integration lives in `backend/src/services/claude.ts`:
- `sendMessage(opts)` — Creates/resumes Claude sessions via `@anthropic-ai/claude-agent-sdk`
- `SendMessageOptions` — `{ prompt, chatId?, folder?, defaultPermissions?, maxTurns?, activePlugins?, imageMetadata? }`
- Returns an `EventEmitter` that emits `StreamEvent`s: `chat_created`, `message_update`, `permission_request`, `user_question`, `plan_review`, `message_complete`, `message_error`
- `respondToPermission(chatId, approved)` — Resolves pending permission requests
- `getActiveSession(chatId)` / `stopSession(chatId)` — Session lifecycle

SSE streaming in `backend/src/routes/stream.ts`:
- `POST /api/stream/new/message` — Start new chat session
- `POST /api/stream/:chatId/message` — Send message to existing session
- `GET /api/stream/:chatId/events` — SSE event stream

---

## Phase 2: Agent Data Backend

**Goal**: Replace mock data with real file-based persistence for all agent features.

### 2.1 — Data Model

Each agent gets a directory with feature-specific JSON files:

```
data/agents/{alias}/
├── agent.json          # AgentConfig (already exists)
├── connections.json    # Connection[]
├── triggers.json       # Trigger[]
├── cron-jobs.json      # CronJob[]
├── activity.jsonl      # ActivityEntry[] (append-only log, one JSON per line)
├── memory.json         # MemoryItem[]
└── sessions/           # Links to Claude Code chat sessions owned by this agent
    └── {chatId}.json   # { chatId, startedAt, triggeredBy, status }
```

### 2.2 — Expand Shared Types

Add action models and metadata fields to existing types in `shared/types/agentFeatures.ts`:

```typescript
// New — defines what happens when a trigger/cron fires
export interface TriggerAction {
  type: "start_session" | "send_message" | "run_command";
  folder?: string;        // Working directory for new sessions
  prompt?: string;        // Message template (can use {{event}} placeholders)
  maxTurns?: number;
  permissions?: DefaultPermissions;
}

// Extend existing Trigger with action
export interface Trigger {
  // ... existing fields ...
  action: TriggerAction;
}

// Extend existing CronJob with action
export interface CronJob {
  // ... existing fields ...
  action: TriggerAction;  // Reuse same action model
}

// Add optional metadata to ActivityEntry
export interface ActivityEntry {
  // ... existing fields ...
  metadata?: Record<string, unknown>;  // e.g. { chatId, triggerId }
}

// Add optional config to Connection
export interface Connection {
  // ... existing fields ...
  config?: Record<string, unknown>;  // Service-specific config
}
```

### 2.3 — Backend Services

Create file-based services following the existing `chat-file-service.ts` pattern (read JSON → in-memory cache → write back on mutation):

| New File | Responsibility |
|---|---|
| `backend/src/services/agent-connections.ts` | CRUD for agent connections |
| `backend/src/services/agent-triggers.ts` | CRUD for agent triggers |
| `backend/src/services/agent-cron-jobs.ts` | CRUD for agent cron jobs |
| `backend/src/services/agent-activity.ts` | Append-only activity log (JSONL) |
| `backend/src/services/agent-memory.ts` | CRUD for agent memory items |

### 2.4 — Backend Routes

Mount sub-routes under the existing agents router:

| New File | Endpoints |
|---|---|
| `backend/src/routes/agent-connections.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/connections` |
| `backend/src/routes/agent-triggers.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/triggers` |
| `backend/src/routes/agent-cron-jobs.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/cron-jobs` |
| `backend/src/routes/agent-activity.ts` | `GET /api/agents/:alias/activity` (with type filter query param) |
| `backend/src/routes/agent-memory.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/memory` |

Wire into `routes/agents.ts`:
```typescript
router.use("/:alias/connections", connectionRoutes);
router.use("/:alias/triggers", triggerRoutes);
router.use("/:alias/cron-jobs", cronJobRoutes);
router.use("/:alias/activity", activityRoutes);
router.use("/:alias/memory", memoryRoutes);
```

### 2.5 — Frontend Integration

Update each dashboard sub-page to:
1. Replace mock data imports with `useEffect` + `useState` API calls
2. Wire create/update/delete buttons to real API calls
3. Add loading spinners and error states
4. Remove `mockData.ts` when all features are wired up

Add new API functions to `frontend/src/api.ts`:
```typescript
// Connections
export async function listConnections(alias: string): Promise<Connection[]>
export async function createConnection(alias: string, data: Omit<Connection, 'id'>): Promise<Connection>
export async function updateConnection(alias: string, id: string, data: Partial<Connection>): Promise<Connection>
export async function deleteConnection(alias: string, id: string): Promise<void>

// Triggers (same pattern)
// CronJobs (same pattern)
// Activity (GET only, with filter)
// Memory (same pattern)
```

### 2.6 — Verification

- All 7 dashboard pages show real persisted data
- CRUD operations work end-to-end
- Activity log records entries when other operations occur
- Data persists across server restarts
- `mockData.ts` is fully removed

---

## Phase 3: Agent Execution Engine

**Goal**: Agents can programmatically create and manage Claude Code sessions using the existing `sendMessage()` infrastructure.

### 3.1 — Expand AgentConfig

Add execution-related fields to `shared/types/agent.ts`:

```typescript
export interface AgentConfig {
  name: string;
  alias: string;
  description: string;
  systemPrompt?: string;
  createdAt: number;

  // Execution config
  defaultFolder?: string;              // Default working directory for sessions
  defaultPermissions?: DefaultPermissions;
  maxTurns?: number;                    // Default max turns per session (default: 200)
  activePlugins?: string[];             // Plugin IDs to always activate
  autoApproveTools?: string[];          // Tool names to auto-approve (e.g. ["Bash", "Write"])
}
```

Update `CreateAgent.tsx` and `AgentDashboard.tsx` to support editing these new fields.

### 3.2 — Agent Executor Service

**New file: `backend/src/services/agent-executor.ts`**

The bridge between agent config and the existing `sendMessage()` function:

```typescript
export interface AgentExecutionOptions {
  agentAlias: string;
  prompt: string;
  folder?: string;                     // Override agent's defaultFolder
  triggeredBy?: { type: "cron" | "trigger" | "manual"; id?: string };
  chatId?: string;                     // Resume existing session
}

export async function executeAgent(opts: AgentExecutionOptions): Promise<{
  chatId: string;
  emitter: EventEmitter;
}>
```

Key responsibilities:
1. Load the agent's config and memory
2. Build a full prompt by combining: system prompt → memory (instructions, context, facts, preferences) → user prompt
3. Call `sendMessage()` with the agent's configured permissions, plugins, maxTurns
4. Handle permission requests based on `autoApproveTools` — auto-approve listed tools, leave others pending for human review
5. Link the created session to the agent in `data/agents/{alias}/sessions/`
6. Log lifecycle events to the agent's activity feed

### 3.3 — Agent Chat Routes

**New file: `backend/src/routes/agent-chat.ts`**

```
POST   /api/agents/:alias/chat/new         — Start new agent session
POST   /api/agents/:alias/chat/:chatId/message — Send message to existing session
GET    /api/agents/:alias/chat/:chatId/stream  — SSE stream for agent session
GET    /api/agents/:alias/sessions         — List all sessions owned by this agent
```

These routes use `executeAgent()` rather than calling `sendMessage()` directly, so the agent's personality, memory, and permissions are always injected.

### 3.4 — Frontend Chat Integration

Update `dashboard/Chat.tsx` to replace mock auto-replies with real Claude Code session interaction:
- User types message → `POST /api/agents/:alias/chat/new` → streams response via SSE
- Permission requests shown inline or auto-handled per agent config
- Session history pulled from the agent's linked sessions
- Reuse existing SSE consumption patterns from `frontend/src/pages/Chat.tsx`

### 3.5 — Session Ownership

Agent sessions appear in **both** views:
- In the agent's dashboard (under Chat / Sessions) — filtered to that agent's sessions
- In the main chat list (at `/`) — marked with an agent badge so users can see which agent owns which session

Add an `agentAlias` field to the chat metadata so the main ChatList can display ownership.

### 3.6 — Verification

- Start a Claude Code session from the agent dashboard chat
- Agent's system prompt is injected into the conversation
- Memory items are included in the prompt context
- Permissions auto-handled per agent config
- Session appears in both the agent view and the main chat list
- Activity log records session lifecycle events

---

## Phase 4: Triggers & Automation

**Goal**: Agents respond to external events and scheduled tasks without human intervention.

### 4.1 — Cron Scheduler

**New file: `backend/src/services/cron-scheduler.ts`**

Uses `node-cron` (or similar) to schedule agent executions:

```typescript
export function initScheduler(): void       // On startup: load all active cron jobs
export function scheduleJob(agentAlias: string, job: CronJob): void
export function cancelJob(jobId: string): void
export function pauseJob(jobId: string): void
export function resumeJob(jobId: string): void
```

On trigger: calls `executeAgent()` with the job's configured action (folder, prompt template, permissions).

Initialize on server startup in `backend/src/index.ts`:
```typescript
import { initScheduler } from "./services/cron-scheduler.js";
initScheduler();
```

### 4.2 — Event Poller

**New file: `backend/src/services/event-poller.ts`**

Periodically calls the `mcp-secure-proxy` `poll_events` endpoint to ingest external events (Discord messages, GitHub webhooks, Slack messages, etc.):

```typescript
export function startPolling(interval?: number): void  // Default: 5 seconds
export function stopPolling(): void
```

Maintains a cursor (`after_id`) for incremental polling. Dispatches events to the trigger engine.

### 4.3 — Trigger Engine

**New file: `backend/src/services/trigger-engine.ts`**

Evaluates incoming events against all active triggers across all agents:

```typescript
export function initTriggerEngine(): void
export function evaluateTrigger(trigger: Trigger, event: IncomingEvent): boolean
export function processEvent(event: IncomingEvent): Promise<void>
```

When a trigger matches:
1. Extract event data (sender, message content, channel, etc.)
2. Interpolate `{{event.*}}` placeholders in the trigger's prompt template
3. Call `executeAgent()` with the trigger's action config
4. Log to the agent's activity feed

### 4.4 — Trigger Condition Language

Start simple, expand later:
- **Keyword match**: `contains("deploy")` — message body contains keyword
- **Source filter**: `from("user-123")` — filter by sender
- **Channel filter**: `channel("#alerts")` — filter by channel/room
- **Regex**: `matches(/^!bot\s+/)` — regex match on message body
- **Compound**: `contains("deploy") AND channel("#ops")` — AND/OR combinators

### 4.5 — Frontend Wiring

- CronJobs page: "New Job" button opens a form to configure schedule, prompt template, folder, permissions → calls backend CRUD
- Triggers page: "New Trigger" button opens a form to configure source, event, condition, action → calls backend CRUD
- Both pages show real-time status (last triggered, next run) from persisted data
- Activity page shows trigger/cron executions in real-time

### 4.6 — Verification

- Cron jobs execute on schedule and create Claude Code sessions
- Discord messages (via mcp-secure-proxy) trigger agents
- Trigger conditions filter events correctly
- Activity log shows all trigger/cron executions
- Multiple agents can fire concurrently without interference
- Pausing a cron job / trigger stops it from firing

---

## Phase 5: Advanced Features

Natural extensions once the core pipeline is working.

### 5.1 — Agent Memory Auto-Update
- After sessions complete, use a lightweight LLM call to extract key facts
- Auto-populate memory items with what the agent learned
- Configurable per-agent: opt-in to auto-memory extraction

### 5.2 — Connection Management
- Real OAuth flows for Google, Slack, Discord, etc.
- Encrypted credential storage (separate from agent config)
- Connection health monitoring with auto-reconnect
- Connection status feeds into agent activity

### 5.3 — Agent-to-Agent Communication
- Agents can reference and invoke other agents
- Shared memory pools between related agents
- Agent orchestration workflows (agent A triggers agent B on completion)
- Parent/child agent relationships

### 5.4 — Dashboard Real-Time Updates
- WebSocket or SSE for live activity feed updates
- Real-time session status across all agents
- Notification system for pending permission approvals
- Agent status indicators (idle, running, waiting for approval)

### 5.5 — Agent Templates
- Pre-built agent configurations for common use cases
- "Code Reviewer", "CI Monitor", "Discord Bot", "Documentation Writer"
- Import/export agent configs as JSON

### 5.6 — Multi-Session Management
- Agent can run multiple concurrent sessions
- Session pool with configurable concurrency limits
- Queue system for excess requests when at capacity

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
├───────────────┴──────────────────────────────────────────────────┤
│                     Express Backend (API)                         │
├──────────────────────────────────────────────────────────────────┤
│  /api/stream/*     │  /api/agents/*       │  /api/agents/:alias/ │
│  (existing SSE)    │  (agent CRUD)        │  {connections,       │
│                    │                      │   triggers, cron,    │
│                    │                      │   activity, memory,  │
│                    │                      │   chat, sessions}    │
├──────────────────────────────────────────────────────────────────┤
│                       Services Layer                              │
├──────────┬───────────┬──────────────┬────────────────────────────┤
│ claude.ts│ agent-    │ cron-        │ trigger-    │ event-       │
│ (SDK)    │ executor  │ scheduler    │ engine      │ poller       │
│          │           │              │             │              │
│ sendMsg()│ builds    │ node-cron    │ matches     │ polls        │
│ SSE      │ prompt +  │ schedules    │ events to   │ mcp-secure-  │
│ perms    │ memory    │ → executor   │ triggers    │ proxy        │
│          │ → sendMsg │              │ → executor  │ → trigger    │
├──────────┴───────────┴──────────────┴─────────────┴──────────────┤
│                   File-Based Storage (data/)                      │
├──────────────────────────────────────────────────────────────────┤
│  data/chats/          │  data/agents/{alias}/                     │
│  (existing)           │  ├── agent.json                           │
│                       │  ├── connections.json                     │
│                       │  ├── triggers.json                        │
│                       │  ├── cron-jobs.json                       │
│                       │  ├── activity.jsonl                       │
│                       │  ├── memory.json                          │
│                       │  └── sessions/{chatId}.json               │
├──────────────────────────────────────────────────────────────────┤
│              External Services (via mcp-secure-proxy)             │
│  Discord │ Slack │ GitHub │ Gmail │ Webhooks │ ...               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Implementation Order & Dependencies

```
Phase 1 ✅  Foundation (agent CRUD, dashboard UI, navigation)
    │
    ▼
Phase 2     Data Backend (real persistence, remove mock data)
    │
    ▼
Phase 3     Execution Engine (agents create Claude sessions)
    │       Depends on: Phase 2 (memory, activity logging)
    ▼
Phase 4     Triggers & Automation (cron, event polling, trigger matching)
    │       Depends on: Phase 3 (executeAgent)
    ▼
Phase 5     Advanced Features (auto-memory, OAuth, agent-to-agent, templates)
            Depends on: Phase 4 (working automation pipeline)
```

Each phase is independently deployable — the app works after each phase, with progressively more functionality.
