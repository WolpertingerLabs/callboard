# Agents Plan

Autonomous agent management within claude-code-ui — agents with personalities, memory, scheduled tasks, heartbeats, and external triggers that programmatically create and control Claude Code sessions.

**Core insight**: Each agent's workspace directory (`~/.ccui-agents/{alias}/`) is a real Claude Code project. Identity is injected via two complementary layers:
1. **`CLAUDE.md` in the workspace** — Contains the behavioral/workspace protocol (memory rules, safety, heartbeats, group chat etiquette). Auto-loaded by the Claude Code SDK via `settingSources: ["project"]`. This is a copy of the AGENTS.md scaffold template.
2. **`systemPrompt.append` via the SDK** — The agent's structured identity (name, emoji, role, tone, guidelines, user context) is compiled into a markdown string and appended to Claude Code's preset system prompt via `{ type: 'preset', preset: 'claude_code', append: compiledIdentity }`.

This two-layer approach gives clean separation: workspace protocol lives in files the agent can read and reference, while structured identity is injected at the SDK level from form-editable settings.

**Identity model**: Agent identity lives as structured fields in `agent.json` (stored in `data/agents/{alias}/`) — editable via dashboard form fields. No separate `IDENTITY.md` file. The backend compiles these settings into a system prompt append string, giving users a form-based editing experience while producing the rich context the agent needs.

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
- `agentFeatures.ts` — `ChatMessage`, `CronJob`, `Connection`, `Trigger`, `ActivityEntry`, `MemoryItem` interfaces

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
- `agents/dashboard/` — Overview, Chat, CronJobs, Connections, Triggers, Activity, Memory sub-pages (all using mock data)
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
/agents/:alias/triggers    → Triggers
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

### 2.4 — Revised Shared Types

**`shared/types/agentFeatures.ts`** — Keep operational types, drop `MemoryItem`:

```typescript
// Keep as-is (used by cron, triggers, connections, activity)
export interface CronJob { /* ... existing fields ... */
  action: TriggerAction;
}

export interface Trigger { /* ... existing fields ... */
  action: TriggerAction;
}

export interface Connection { /* ... existing fields ... */
  config?: Record<string, unknown>;
}

export interface ActivityEntry { /* ... existing fields ... */
  metadata?: Record<string, unknown>;
}

// NEW — defines what happens when a trigger/cron fires
export interface TriggerAction {
  type: "start_session" | "send_message";
  prompt?: string;           // Message template (can use {{event}} placeholders)
  folder?: string;           // Override agent's defaultFolder
  maxTurns?: number;
  permissions?: DefaultPermissions;
}

// REMOVE MemoryItem — memory is now markdown files, not key-value pairs
// The dashboard Memory page becomes a file editor (see Phase 2.7)
```

### 2.5 — Backend Services for Operational Data

These still use JSON files, stored in the app's data directory (not the agent workspace), since they're managed by the app, not the agent:

```
data/agents/{alias}/
├── agent.json         # AgentConfig (already exists)
├── connections.json   # Connection[]
├── triggers.json      # Trigger[]
├── cron-jobs.json     # CronJob[]
├── activity.jsonl     # ActivityEntry[] (append-only log)
└── sessions/          # Links to Claude Code sessions
    └── {chatId}.json  # { chatId, startedAt, triggeredBy, status }
```

Create file-based services following the existing `chat-file-service.ts` pattern:

| New File | Responsibility |
|---|---|
| `backend/src/services/agent-connections.ts` | CRUD for agent connections |
| `backend/src/services/agent-triggers.ts` | CRUD for agent triggers |
| `backend/src/services/agent-cron-jobs.ts` | CRUD for agent cron jobs |
| `backend/src/services/agent-activity.ts` | Append-only activity log (JSONL) |

### 2.6 — Backend Routes (Remaining)

Mount sub-routes under the existing agents router:

| New File | Endpoints |
|---|---|
| `backend/src/routes/agent-workspace.ts` | `GET/PUT /api/agents/:alias/workspace/:filename` — read/write markdown files |
| `backend/src/routes/agent-memory.ts` | `GET /api/agents/:alias/memory` — list dates + read daily/long-term memory; `PUT` to update |
| `backend/src/routes/agent-connections.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/connections` |
| `backend/src/routes/agent-triggers.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/triggers` |
| `backend/src/routes/agent-cron-jobs.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/cron-jobs` |
| `backend/src/routes/agent-activity.ts` | `GET /api/agents/:alias/activity` (with type filter) |

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
- Stat cards: active connections, cron jobs, triggers (from real APIs)
- Recent activity from real activity log

**Memory page** → Becomes a **workspace file editor**:
- Left sidebar: list of workspace files (`SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`)
- Main area: markdown editor for selected file
- Saving a file calls `PUT /api/agents/:alias/workspace/:filename`
- Below or in a tab: daily memory timeline (`memory/YYYY-MM-DD.md`) — read-only viewer with date picker
- `MEMORY.md` section: editable curated long-term memory

**Connections, CronJobs, Triggers, Activity** → Wire to real APIs:
- Replace mock data imports with `useEffect` + `useState` API calls
- Wire create/update/delete buttons to real API calls
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
- Connections, triggers, cron jobs persist via JSON APIs
- Activity log records entries
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
  triggeredBy?: { type: "cron" | "trigger" | "heartbeat" | "manual"; id?: string };
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
- Session appears in both the agent view and the main chat list
- Activity log records session lifecycle events
- Daily memory updated after session completes

---

## Phase 4: Triggers & Automation

**Goal**: Agents respond to scheduled tasks, heartbeat polls, and external events without human intervention.

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

On trigger: calls `executeAgent()` with the job's configured action (folder, prompt template, permissions).

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

### 4.3 — Event Poller

**New file: `backend/src/services/event-poller.ts`**

Periodically calls the `mcp-secure-proxy` `poll_events` endpoint to ingest external events (Discord messages, GitHub webhooks, Slack messages, etc.):

```typescript
export function startPolling(interval?: number): void  // Default: 5 seconds
export function stopPolling(): void
```

Maintains a cursor (`after_id`) for incremental polling. Dispatches events to the trigger engine.

### 4.4 — Trigger Engine

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

### 4.5 — Trigger Condition Language

Start simple, expand later:
- **Keyword match**: `contains("deploy")` — message body contains keyword
- **Source filter**: `from("user-123")` — filter by sender
- **Channel filter**: `channel("#alerts")` — filter by channel/room
- **Regex**: `matches(/^!bot\s+/)` — regex match on message body
- **Compound**: `contains("deploy") AND channel("#ops")` — AND/OR combinators

### 4.6 — Frontend Wiring

- **CronJobs page**: "New Job" button opens a form to configure schedule, prompt template, folder → calls backend CRUD
- **Triggers page**: "New Trigger" button opens a form to configure source, event, condition, action → calls backend CRUD
- **Overview page**: Heartbeat toggle + interval config in agent settings section
- Both pages show real-time status (last triggered, next run) from persisted data
- Activity page shows trigger/cron/heartbeat executions

### 4.7 — Verification

- Cron jobs execute on schedule and create Claude Code sessions
- Heartbeat polls fire at configured intervals, agent reads HEARTBEAT.md and acts or replies HEARTBEAT_OK
- Quiet hours respected for heartbeats
- Discord messages (via mcp-secure-proxy) trigger agents
- Trigger conditions filter events correctly
- Activity log shows all trigger/cron/heartbeat executions
- Multiple agents can fire concurrently without interference
- Pausing a cron job / trigger / heartbeat stops it from firing

---

## Phase 5: Advanced Features

Natural extensions once the core pipeline is working.

### 5.1 — Agent Memory Auto-Update
- After sessions complete, agent can update its own `MEMORY.md` and daily journals (it already has write access to its workspace)
- During heartbeats, agent can review recent daily files and curate `MEMORY.md` (like a human reviewing their journal)
- The workspace protocol in CLAUDE.md already includes guidance for memory maintenance

### 5.2 — Connection Management
- Real OAuth flows for Google, Slack, Discord, etc.
- Encrypted credential storage (separate from agent workspace)
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
- Agent status indicators (idle, running, heartbeat active, waiting for approval)

### 5.5 — Agent Templates
- Pre-built agent configurations for common use cases
- "Code Reviewer", "CI Monitor", "Discord Bot", "Documentation Writer"
- Import/export full agent workspaces as archives

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
│  New chat:    │                                                  │
│  Claude Code  │  Overview page = identity settings form:         │
│  | Agent      │  ┌──────────────────────────────────────────┐   │
│  (toggle)     │  │ Name: [Hex    ] Emoji: [🔮]  Role: [...] │   │
│               │  │ Tone: [Casual ▾]  Pronouns: [they/them] │   │
│  Agent mode:  │  │ Guidelines: [+ Add rule]                 │   │
│  select agent │  │ User: [Ben] TZ: [America/New_York ▾]    │   │
│  → Start Chat │  └──────────────────────────────────────────┘   │
│  (fetches     │                                                  │
│  identity     │  Memory page = workspace file editor:            │
│  prompt →     │  ┌─────────┬────────────────────────────────┐   │
│  navigates to │  │ Files   │ Markdown Editor                │   │
│  /chat/new)   │  │─────────│                                │   │
│               │  │ SOUL    │ # Soul                         │   │
│               │  │ USER    │ Be genuinely helpful, not      │   │
│               │  │ TOOLS   │ performatively helpful...      │   │
│               │  │ HEART.. │                                │   │
│               │  │─────────│                                │   │
│               │  │ Daily   │                                │   │
│               │  │ MEMORY  │                                │   │
│               │  └─────────┴────────────────────────────────┘   │
├───────────────┴──────────────────────────────────────────────────┤
│                     Express Backend (API)                         │
├──────────────────────────────────────────────────────────────────┤
│  /api/stream/*     │  /api/agents/*         │  /api/agents/:alias│
│  (SSE — accepts    │  (agent CRUD +         │  /identity-prompt  │
│   systemPrompt)    │   PUT updates)         │  /workspace/:file  │
│                    │                        │  /memory            │
│                    │                        │  /connections       │
│                    │                        │  /triggers          │
│                    │                        │  /cron-jobs         │
│                    │                        │  /activity          │
│                    │                        │  /chat              │
│                    │                        │  /sessions          │
├──────────────────────────────────────────────────────────────────┤
│                       Services Layer                              │
├──────────┬───────────┬──────────┬─────────┬──────────┬───────────┤
│ claude.ts│ agent-    │ claude-  │ cron-   │ heart-  │ trigger- │
│ (SDK)    │ executor  │ compiler │ sched.  │ beat    │ engine   │
│          │           │          │         │         │          │
│ sendMsg()│ identity  │ compile  │ node-   │ periodic│ matches  │
│ SSE      │ + folder  │ Identity │ cron    │ open-   │ events → │
│ perms    │ + config  │ Prompt() │ specific│ ended   │ triggers │
│ system-  │ → sendMsg │ scaffold │ tasks   │ check-in│ →executor│
│ Prompt   │           │ Wkspace()│→executor│→executor│          │
├──────────┴───────────┴──────────┴─────────┴──────────┴───────────┤
│                       Storage                                     │
├─────────────────────────────┬────────────────────────────────────┤
│  App Data (data/)           │  Agent Workspaces (~/.ccui-agents/) │
│  ├── chats/ (existing)      │  └── {alias}/                      │
│  └── agents/{alias}/        │      ├── CLAUDE.md  ← AGENTS.md   │
│      ├── agent.json         │      ├── AGENTS.md  (protocol)    │
│      ├── connections.json   │      ├── SOUL.md                   │
│      ├── triggers.json      │      ├── USER.md                   │
│      ├── cron-jobs.json     │      ├── TOOLS.md                  │
│      ├── activity.jsonl     │      ├── HEARTBEAT.md              │
│      └── sessions/          │      ├── MEMORY.md                 │
│                             │      └── memory/                   │
│                             │          └── YYYY-MM-DD.md         │
├─────────────────────────────┴────────────────────────────────────┤
│              External Services (via mcp-secure-proxy)             │
│  Discord │ Slack │ GitHub │ Gmail │ Webhooks │ ...               │
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
                └──────────────────────────────────────────────────────┘
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
    │       - Operational data services (connections, triggers, cron, activity)
    │       - Workspace file read/write API endpoints
    │       - Dashboard: Overview → settings form, Memory → file editor
    │       - Wire dashboard pages to real APIs, remove mockData.ts
    │       - CreateAgent form expansion (structured identity fields)
    │
    ▼
Phase 3     Execution Engine
    │       - Thin executor: compileIdentityPrompt() + folder + config → sendMessage()
    │       - Agent chat routes + SSE streaming
    │       - Frontend chat wired to real sessions
    │       - Session ownership (agent badge in main chat list)
    │       Depends on: Phase 2 (workspace, activity logging)
    │
    ▼
Phase 4     Triggers & Automation
    │       - Cron scheduler (specific scheduled tasks)
    │       - Heartbeat system (periodic open-ended check-ins)
    │       - Event poller (mcp-secure-proxy → trigger engine)
    │       - Trigger condition matching + action execution
    │       Depends on: Phase 3 (executeAgent)
    │
    ▼
Phase 5     Advanced Features
            - Memory auto-update, OAuth, agent-to-agent, templates
            Depends on: Phase 4 (working automation pipeline)
```

Each phase is independently deployable — the app works after each phase, with progressively more functionality.
