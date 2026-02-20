# Agents Plan

Autonomous agent management within claude-code-ui — agents with personalities, memory, scheduled tasks, heartbeats, and external triggers that programmatically create and control Claude Code sessions.

**Core insight**: Each agent's workspace directory is a real Claude Code project. `CLAUDE.md` is **compiled** by the backend from the agent's structured settings (identity, personality, user context) plus its workspace markdown files (SOUL.md, TOOLS.md, etc.), then auto-loaded by the Claude Code SDK when a session starts. The agent's folder *is* its personality.

**Identity model**: Agent identity lives as structured settings in `.agent.json` — editable via clean form fields in the dashboard. No separate `IDENTITY.md` file. The backend compiles these settings into the `CLAUDE.md` system prompt before each session, giving users a form-based editing experience while producing the rich context the agent needs.

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
- `CreateAgent.tsx` — Agent creation form (name, alias auto-gen, description, system prompt) — to be expanded with structured identity fields in Phase 2
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

## Phase 2: Agent Workspace & Memory

**Goal**: Replace the flat `agent.json` + mock data with a real workspace directory that serves as both storage and Claude Code project. Inspired by the OpenClaw agent structure (`~/.ccui-agents/test/`).

### 2.1 — Workspace Directory Structure

Each agent gets a full workspace directory. When Claude Code starts a session with `folder` set to this workspace, `CLAUDE.md` auto-loads the agent's compiled system prompt:

```
~/.ccui-agents/{alias}/
├── CLAUDE.md           # COMPILED — auto-generated before each session from:
│                       #   1. Agent identity settings (from .agent.json)
│                       #   2. SOUL.md, USER.md, TOOLS.md contents
│                       #   3. Default behavioral instructions (memory protocol, safety, etc.)
│                       #   DO NOT EDIT DIRECTLY — will be overwritten on next compile
├── SOUL.md             # Personality, values, tone, boundaries — who the agent IS
├── USER.md             # Info about the human (name, timezone, preferences)
├── TOOLS.md            # Environment-specific notes (devices, SSH hosts, API keys context)
├── HEARTBEAT.md        # Fluid checklist for heartbeat polls (see Phase 4)
├── memory/
│   ├── YYYY-MM-DD.md   # Daily journals — raw logs of what happened each day
│   └── ...
├── MEMORY.md           # Curated long-term memory — distilled from daily journals
└── .agent.json         # Structured settings (identity + execution config):
                        #   See AgentConfig in section 2.2
```

**Key principles**:
- **Identity is structured, not markdown.** Agent name, emoji, description, platform handles, etc. live as fields in `.agent.json`, editable via dashboard form fields. No separate `IDENTITY.md` — that data belongs in structured settings.
- **`CLAUDE.md` is compiled, not hand-edited.** The backend generates it before each session by combining identity settings + workspace files (SOUL, USER, TOOLS) + default behavioral instructions (memory protocol, safety rules). This gives users the best of both worlds: clean forms for identity, free-form markdown for personality/context, and a single compiled output for the SDK.
- **Workspace markdown files are the agent's own.** `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, and daily journals are read and written by the agent during sessions. The agent maintains its own memory.

**Why `~/.ccui-agents/` instead of `data/agents/`?** The workspace needs to be a real directory the Claude Code SDK can use as a project root. Keeping it in the user's home directory (configurable) separates agent workspaces from the app's internal data. The path is configurable via environment variable `CCUI_AGENTS_DIR` (default: `~/.ccui-agents`).

### 2.2 — Agent Config & Identity

The current `AgentConfig` is too flat (just name, alias, description, systemPrompt). Expand it to hold comprehensive structured identity settings alongside execution config. Everything in `.agent.json` is editable via dashboard form fields.

**`shared/types/agent.ts`**:
```typescript
export interface AgentConfig {
  // Core identity
  alias: string;                       // Unique identifier (immutable after creation)
  createdAt: number;

  // Identity settings (editable via dashboard forms → compiled into CLAUDE.md)
  name: string;                        // Display name ("Hex", "CodeBot")
  emoji?: string;                      // Agent emoji ("🔮", "🤖")
  description: string;                 // Short description for agent list
  personality?: string;                // One-liner personality hint ("Sharp, witty, direct")
  role?: string;                       // What this agent does ("Code reviewer", "Discord bot")
  tone?: string;                       // Communication style ("Professional", "Casual and friendly",
                                       //   "Terse and technical", custom free-text)
  pronouns?: string;                   // Agent's pronouns ("they/them", "she/her", etc.)
  languages?: string[];                // Languages the agent should respond in (["English", "Spanish"])
  guidelines?: string[];               // Custom behavioral rules as short bullet points
                                       //   e.g. ["Never apologize", "Always suggest tests",
                                       //         "Prefer functional patterns"]

  // User context (who the agent serves — compiled into CLAUDE.md)
  userName?: string;                   // Human's name
  userTimezone?: string;               // e.g. "America/New_York"
  userLocation?: string;               // e.g. "Phoenixville, PA"
  userContext?: string;                 // Free-text: what matters to this human, their projects,
                                       //   preferences, quirks — the stuff that makes help personal

  // Execution defaults (used by agent-executor, not compiled into prompt)
  defaultFolder?: string;              // Working directory for sessions (defaults to workspace)
  defaultPermissions?: DefaultPermissions;
  maxTurns?: number;                   // Default: 200
  activePlugins?: string[];            // Plugin IDs to always activate
}
```

**Workspace markdown files** — What the agent reads/writes during sessions:
- `SOUL.md` → Deep personality, values, boundaries — the agent's inner compass (editable via UI as free-form markdown)
- `USER.md` → Extended user notes the agent accumulates over time (starts from `userContext` but the agent grows it)
- `TOOLS.md` → Environment-specific notes (devices, SSH hosts, API quirks — the agent adds to this)
- `HEARTBEAT.md` → Fluid heartbeat checklist (see Phase 4)
- `MEMORY.md` → Curated long-term memory
- `memory/YYYY-MM-DD.md` → Daily journals

**What goes where?**
- **Structured settings** (`.agent.json` → form fields): Anything that has a clear shape — name, emoji, tone, role, timezone, guidelines. Users shouldn't have to write markdown for these.
- **Free-form markdown** (workspace files → markdown editor): Anything that benefits from narrative or open-ended expression — personality depth (SOUL), extended notes (USER, TOOLS), memory.

### 2.3 — Revised Shared Types

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
// The dashboard Memory page becomes a file editor (see Phase 2.6)
```

### 2.4 — Backend Workspace Service

**New file: `backend/src/services/agent-workspace.ts`**

Replaces the current `agent-file-service.ts`. Manages the workspace directory:

```typescript
// Workspace lifecycle
export function createWorkspace(alias: string, config: AgentConfig): void
export function deleteWorkspace(alias: string): void
export function workspaceExists(alias: string): boolean
export function getWorkspacePath(alias: string): string

// Agent config (.agent.json)
export function getAgentConfig(alias: string): AgentConfig | undefined
export function updateAgentConfig(alias: string, updates: Partial<AgentConfig>): AgentConfig
export function listAgents(): AgentConfig[]

// CLAUDE.md compilation
export function compileClaude(alias: string): void

// Workspace files (markdown)
export function readWorkspaceFile(alias: string, filename: string): string | undefined
export function writeWorkspaceFile(alias: string, filename: string, content: string): void
export function listWorkspaceFiles(alias: string): string[]

// Daily memory
export function readDailyMemory(alias: string, date?: string): string | undefined
export function appendDailyMemory(alias: string, entry: string, date?: string): void
export function listMemoryDates(alias: string): string[]

// Curated memory (MEMORY.md)
export function readLongTermMemory(alias: string): string | undefined
export function writeLongTermMemory(alias: string, content: string): void
```

**`compileClaude(alias)`** — The core compilation function. Generates `CLAUDE.md` from:
1. **Identity block** — Compiled from `.agent.json` structured fields:
   ```markdown
   # Identity
   - **Name:** Hex
   - **Role:** Code reviewer and Discord bot
   - **Personality:** Sharp, witty, direct
   - **Tone:** Casual and friendly
   - **Emoji:** 🔮
   - **Pronouns:** they/them
   - **Languages:** English, Spanish
   ```
2. **User context block** — Compiled from `.agent.json` user fields:
   ```markdown
   # Your Human
   - **Name:** Ben
   - **Timezone:** America/New_York
   - **Location:** Phoenixville, PA
   - **Context:** [free-text from userContext field]
   ```
3. **Guidelines block** — Compiled from `.agent.json` guidelines array:
   ```markdown
   # Guidelines
   - Never apologize
   - Always suggest tests
   - Prefer functional patterns
   ```
4. **Behavioral instructions** — Default template (memory protocol, safety rules, session startup sequence)
5. **Workspace file contents** — Inline `SOUL.md`, `TOOLS.md` if they exist (so the agent doesn't have to read them separately)

Called automatically:
- On `createWorkspace` (initial generation)
- On `updateAgentConfig` (identity/user settings changed)
- On `writeWorkspaceFile` for SOUL.md or TOOLS.md (markdown content changed)
- Before each session start (in the executor, to ensure freshness)

On `createWorkspace`:
1. Create `~/.ccui-agents/{alias}/` and `memory/` subdirectory
2. Write `.agent.json` with full config (identity + execution settings)
3. Generate starter `SOUL.md`, `USER.md`, `TOOLS.md` from templates
4. Create empty `HEARTBEAT.md`
5. Call `compileClaude(alias)` to generate initial `CLAUDE.md`

### 2.5 — Backend Services for Operational Data

These still use JSON files, but stored in the app's data directory (not the agent workspace), since they're managed by the app, not the agent:

```
data/agents/{alias}/
├── connections.json    # Connection[]
├── triggers.json       # Trigger[]
├── cron-jobs.json      # CronJob[]
├── activity.jsonl      # ActivityEntry[] (append-only log)
└── sessions/           # Links to Claude Code sessions
    └── {chatId}.json   # { chatId, startedAt, triggeredBy, status }
```

Create file-based services following the existing `chat-file-service.ts` pattern:

| New File | Responsibility |
|---|---|
| `backend/src/services/agent-connections.ts` | CRUD for agent connections |
| `backend/src/services/agent-triggers.ts` | CRUD for agent triggers |
| `backend/src/services/agent-cron-jobs.ts` | CRUD for agent cron jobs |
| `backend/src/services/agent-activity.ts` | Append-only activity log (JSONL) |

### 2.6 — Backend Routes

Mount sub-routes under the existing agents router:

| New/Modified File | Endpoints |
|---|---|
| `backend/src/routes/agents.ts` (modify) | Update CRUD to use workspace service |
| `backend/src/routes/agent-workspace.ts` | `GET/PUT /api/agents/:alias/workspace/:filename` — read/write markdown files |
| `backend/src/routes/agent-memory.ts` | `GET /api/agents/:alias/memory` — list dates + read daily/long-term memory; `PUT` to update |
| `backend/src/routes/agent-connections.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/connections` |
| `backend/src/routes/agent-triggers.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/triggers` |
| `backend/src/routes/agent-cron-jobs.ts` | `GET/POST/PUT/DELETE /api/agents/:alias/cron-jobs` |
| `backend/src/routes/agent-activity.ts` | `GET /api/agents/:alias/activity` (with type filter) |

### 2.7 — Frontend: Dashboard Overhaul

The dashboard sub-pages need significant rework to match the new model:

**Overview page** → Agent identity + settings form + stats:
- Agent header: display name + emoji + role from `AgentConfig` (not parsed from a file)
- **Settings section**: Form fields for all identity settings:
  - Name, emoji picker, description, role, personality, tone (dropdown + custom), pronouns, languages
  - User context: userName, userTimezone (dropdown), userLocation, userContext (textarea)
  - Guidelines: list editor (add/remove/reorder bullet points)
  - Execution: defaultFolder, maxTurns, defaultPermissions, activePlugins
- Saves to `PUT /api/agents/:alias` → updates `.agent.json` → triggers `compileClaude()`
- Stat cards: active connections, cron jobs, triggers (from real APIs)
- Recent activity from real activity log

**Memory page** → Becomes a **workspace file editor**:
- Left sidebar: list of workspace files (`SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`)
- Main area: markdown editor for selected file
- Saving a file calls `PUT /api/agents/:alias/workspace/:filename` → triggers `compileClaude()` if SOUL.md or TOOLS.md
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

### 2.8 — Default Templates & CLAUDE.md Compilation

**`backend/src/services/claude-compiler.ts`** — The compilation logic:

Takes an `AgentConfig` + workspace file contents and produces the full `CLAUDE.md` output. The compiled file has a clear structure:

```markdown
<!-- AUTO-GENERATED — Do not edit directly. Edit via dashboard settings or workspace files. -->

# {name} {emoji}

{role and personality summary}

## Identity
- **Name:** ...
- **Tone:** ...
- **Pronouns:** ...
(etc — from AgentConfig structured fields)

## Your Human
- **Name:** ...
- **Timezone:** ...
(etc — from AgentConfig user fields)

## Guidelines
- {guideline 1}
- {guideline 2}
(etc — from AgentConfig.guidelines[])

## Soul
{contents of SOUL.md, if it exists}

## Tools & Environment
{contents of TOOLS.md, if it exists}

## Workspace Protocol
{default behavioral instructions template:}
- Session startup: read today's + yesterday's memory/YYYY-MM-DD.md, read MEMORY.md
- Memory protocol: daily journals in memory/YYYY-MM-DD.md, curated in MEMORY.md
- Safety rules: don't exfiltrate data, ask before external actions
- Write-it-down principle: files over "mental notes"
```

**Default workspace file templates** (`backend/src/templates/`):

**`soul.md.template`** — Starter personality:
- Placeholder prompts for the user to fill in
- Core values (be helpful, have opinions, be resourceful)

**`user.md.template`** — Extended user notes placeholder (the agent grows this over time)

**`tools.md.template`** — Environment notes placeholder

### 2.9 — Verification

- Creating an agent produces a full workspace directory with compiled `CLAUDE.md`
- `CLAUDE.md` contains compiled identity from structured settings + SOUL.md + TOOLS.md + behavioral instructions
- Updating agent settings via dashboard re-compiles `CLAUDE.md`
- Editing SOUL.md or TOOLS.md via workspace editor re-compiles `CLAUDE.md`
- All workspace files are readable/editable via API and dashboard
- Overview page shows all identity fields in form format, saves correctly
- Daily memory files can be viewed by date
- Connections, triggers, cron jobs persist via JSON APIs
- Activity log records entries
- `mockData.ts` is fully removed
- Deleting an agent removes both workspace and data directories

---

## Phase 3: Agent Execution Engine

**Goal**: Agents can programmatically create and manage Claude Code sessions. The execution model is simple: point `sendMessage()` at the agent's workspace directory and let `CLAUDE.md` do the rest.

### 3.1 — Agent Executor Service

**New file: `backend/src/services/agent-executor.ts`**

The bridge between agent config and the existing `sendMessage()` function. Because `CLAUDE.md` auto-loads in the workspace, the executor is thin:

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
1. Load the agent's `.agent.json` config
2. Call `compileClaude(alias)` to ensure `CLAUDE.md` is fresh (identity + workspace files → compiled prompt)
3. Determine `folder` — use override, or agent's `defaultFolder`, or fall back to workspace path
4. Call `sendMessage()` with `{ prompt, folder, defaultPermissions, maxTurns, activePlugins }` from agent config
5. Link the created session to the agent in `data/agents/{alias}/sessions/`
6. Log lifecycle events to the agent's activity feed
7. On session complete: append a summary entry to today's `memory/YYYY-MM-DD.md`

**What the executor does NOT do** (because `CLAUDE.md` handles it):
- ~~Manually build prompts by concatenating personality + context~~ → `compileClaude()` already assembled everything into `CLAUDE.md`
- ~~Inject identity~~ → Compiled into `CLAUDE.md` from structured settings
- ~~Inject user context~~ → Compiled into `CLAUDE.md` from structured settings
- ~~Format memory items~~ → Agent reads `MEMORY.md` and daily journals itself per workspace protocol

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
- Agent's `CLAUDE.md` is loaded (verify by checking that it follows SOUL.md personality)
- Agent reads its own memory files during the session
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

Add `heartbeat` field to `.agent.json`:
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
- Add guidance in the compiled `CLAUDE.md` workspace protocol section for memory maintenance

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
│               │                                                  │
│               │  Overview page = identity settings form:         │
│               │  ┌──────────────────────────────────────────┐   │
│               │  │ Name: [Hex    ] Emoji: [🔮]  Role: [...] │   │
│               │  │ Tone: [Casual ▾]  Pronouns: [they/them] │   │
│               │  │ Guidelines: [+ Add rule]                 │   │
│               │  │ User: [Ben] TZ: [America/New_York ▾]    │   │
│               │  └──────────────────────────────────────────┘   │
│               │                                                  │
│               │  Memory page = workspace file editor:            │
│               │  ┌─────────┬────────────────────────────────┐   │
│               │  │ Files   │ Markdown Editor                │   │
│               │  │─────────│                                │   │
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
│  (existing SSE)    │  (agent CRUD)          │  /workspace/:file  │
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
│ sendMsg()│ compile → │ settings │ node-   │ periodic│ matches  │
│ SSE      │ folder +  │ + md →   │ cron    │ open-   │ events → │
│ perms    │ config    │ CLAUDE.md│ specific│ ended   │ triggers │
│          │ → sendMsg │          │ tasks   │ check-in│ →executor│
│          │           │          │→executor│→executor│          │
├──────────┴───────────┴──────────┴─────────┴──────────┴───────────┤
│                       Storage                                     │
├─────────────────────────────┬────────────────────────────────────┤
│  App Data (data/)           │  Agent Workspaces (~/.ccui-agents/) │
│  ├── chats/ (existing)      │  └── {alias}/                      │
│  └── agents/{alias}/        │      ├── CLAUDE.md  ← COMPILED     │
│      ├── connections.json   │      ├── SOUL.md                   │
│      ├── triggers.json      │      ├── USER.md                   │
│      ├── cron-jobs.json     │      ├── TOOLS.md                  │
│      ├── activity.jsonl     │      ├── HEARTBEAT.md              │
│      └── sessions/          │      ├── MEMORY.md                 │
│                             │      ├── memory/                   │
│                             │      │   └── YYYY-MM-DD.md         │
│                             │      └── .agent.json               │
├─────────────────────────────┴────────────────────────────────────┤
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
Phase 2     Workspace & Memory
    │       - Agent workspace directories with compiled CLAUDE.md
    │       - Structured identity settings in .agent.json (form-editable)
    │       - CLAUDE.md compiler: settings + SOUL.md + TOOLS.md → system prompt
    │       - Markdown workspace files (SOUL, USER, TOOLS) for free-form content
    │       - Daily journal + curated MEMORY.md
    │       - JSON persistence for connections, triggers, cron, activity
    │       - Dashboard: Overview → settings form, Memory → file editor
    │
    ▼
Phase 3     Execution Engine
    │       - Thin executor: compileClaude() + folder + config → sendMessage()
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
