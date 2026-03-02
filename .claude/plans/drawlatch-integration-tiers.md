# Drawlatch Integration Plan for Callboard

## Overview

Drawlatch is an encrypted MCP proxy for Claude Code that enables secure, authenticated HTTP requests to 22+ external APIs with real-time event ingestion. Callboard integrates drawlatch for both local (in-process) and remote (encrypted) proxy modes.

This document tracks all new drawlatch features that need to be integrated into callboard, organized by priority tier.

---

## Current State (What's Already Integrated)

| MCP Tool          | Claude Sessions |         Backend Route         | Frontend UI |
| ----------------- | :-------------: | :---------------------------: | :---------: |
| `secure_request`  |       ✅        |              ✅               |      —      |
| `list_routes`     |       ✅        |  ✅ `GET /api/proxy/routes`   |     ✅      |
| `poll_events`     |       ✅        |  ✅ `GET /api/proxy/events`   |     ✅      |
| `ingestor_status` |       ✅        | ✅ `GET /api/proxy/ingestors` |     ✅      |

Plus supporting infrastructure:

- ✅ Local & remote proxy mode selection (with UI)
- ✅ Connection enable/disable per caller alias
- ✅ Secret management per caller with env-var prefixes
- ✅ Caller alias CRUD
- ✅ Event polling loops with JSONL storage & deduplication
- ✅ Webhook route forwarding (`POST /webhooks/:path`)
- ✅ Proxy tools auto-injected into every Claude session

### Completed Pre-Requisite

- ✅ **Remote connections in ConnectionsSettings** — The settings page now shows connections from both local and remote proxy sources. Remote connections display as read-only cards with Cloud icon and "Remote" badge (no toggle/configure). Local connections retain full configuration capabilities. (Completed 2026-03-01)

---

## Tier 0 — Pre-Requisite (DONE)

### Show Remote Connections in ConnectionsSettings

**Status: ✅ COMPLETE**

Updated ConnectionsSettings to work for both local and remote proxy modes. Remote connections are displayed as read-only cards.

**Files changed:**

- `shared/types/connections.ts` — Added `source?: "local" | "remote"` to `ConnectionStatus`
- `backend/src/services/connection-manager.ts` — Added `listRemoteConnections()`
- `backend/src/routes/connections.ts` — Updated `GET /` and `GET /callers` for remote mode
- `backend/src/services/local-proxy.ts` — Enriched `list_routes` with `alias`, `hasIngestor`, `ingestorType`, etc.
- `frontend/src/api.ts` — Added `remoteModeActive` to response type
- `frontend/src/pages/settings/ConnectionsSettings.tsx` — Remote-aware UI rendering

---

## Tier 1 — Quick Wins (DONE)

### 1.1 `test_connection` — Validate API Credentials

**Status: ✅ COMPLETE**

**What it does:** Makes a non-destructive read-only request to verify API credentials work (e.g., `GET /user` for GitHub, `GET /users/@me` for Discord). Each connection template has a pre-configured `testConnection` config.

**Why it matters:** Users currently enable connections and set secrets blindly — no way to verify credentials before using them.

**Implementation:**

**Backend:**

- `backend/src/services/local-proxy.ts` — Add `test_connection` case in `callTool()` switch. The drawlatch remote server already handles this; for local mode, need to import and call the test function from drawlatch (or use `executeProxyRequest` with the test config).
- `backend/src/services/proxy-tools.ts` — Expose `test_connection` tool to Claude sessions.
- `backend/src/routes/proxy-routes.ts` — Add `POST /api/proxy/test-connection/:alias` endpoint.
  - Takes `{ alias: string, caller?: string }`
  - Calls `proxy.callTool("test_connection", { connection: alias })`
  - Returns `{ success: boolean, message: string, statusCode?: number }`

**Frontend:**

- `frontend/src/pages/settings/ConnectionsSettings.tsx` — Add a "Test" button on each connection card (both local enabled + remote).
  - Shows loading spinner while testing
  - Shows success (green check) or failure (red X) toast/inline result
  - Only visible when connection is enabled (local) or always (remote)
- `frontend/src/api.ts` — Add `testConnection(alias, caller?)` API function.

**Estimated effort:** ~150 lines across 4-5 files.

### 1.2 `test_ingestor` — Validate Listener Configuration

**Status: ✅ COMPLETE**

**What it does:** Verifies event listener/ingestor configuration without starting a persistent listener. Tests webhook secrets, poll credentials, WebSocket auth. Each connection template has a `testIngestor` strategy (`webhook_verify`, `poll_once`, `websocket_auth`).

**Why it matters:** Users have no way to know if their listener setup is correct until they start it and watch for errors.

**Implementation:**

**Backend:**

- Same pattern as `test_connection` above.
- `backend/src/routes/proxy-routes.ts` — Add `POST /api/proxy/test-ingestor/:alias` endpoint.
- `backend/src/services/proxy-tools.ts` — Expose `test_ingestor` tool to Claude sessions.

**Frontend:**

- Add "Test Listener" button in the listener/ingestor section of connection cards (only for connections with `hasIngestor`).
- Same loading/result UX as test_connection.

**Estimated effort:** ~100 lines across 4-5 files.

---

## Tier 2 — High Value (DONE)

### 2.1 `control_listener` — Runtime Listener Start/Stop/Restart

**Status: ✅ COMPLETE**

**What it does:** Start, stop, or restart individual event listeners at runtime without restarting the whole callboard server. Supports per-instance control via `instance_id` parameter.

**Why it matters:** Currently if a listener gets stuck or a user wants to pause event collection, they must restart the entire server.

**Implementation:**

**Backend:**

- `backend/src/services/proxy-tools.ts` — Expose `control_listener` tool to Claude sessions.
- `backend/src/routes/proxy-routes.ts` — Add `POST /api/proxy/control-listener/:alias` endpoint.
  - Body: `{ action: "start" | "stop" | "restart", instance_id?: string, caller?: string }`
  - Calls `proxy.callTool("control_listener", { connection: alias, action, instance_id })`

**Frontend:**

- Add start/stop/restart buttons to an ingestor management panel (could be in ConnectionsSettings or a dedicated "Listeners" tab in settings).
- Show current listener state (from `ingestor_status`) alongside controls.
- Consider a dedicated "Listeners" section in settings or in the Events dashboard.

**Estimated effort:** ~200 lines across 5-6 files.

### 2.2 `list_listener_configs` — Listener Configuration Schemas

**Status: ✅ COMPLETE**

**What it does:** Returns JSON schemas for all configurable listener fields per connection. Each field has: `key`, `label`, `description`, `type` (text/number/boolean/select/multiselect/secret/text[]), `default`, `required`, `validation`, `dynamicOptions` metadata.

**Why it matters:** This is the **key missing piece** for a listener configuration UI. Currently callboard only lets users configure secrets, not listener parameters (which Discord guild to watch, which Trello board, event type filters, poll intervals, etc.). These schemas are designed to be auto-rendered into forms.

**Implementation:**

**Backend:**

- `backend/src/services/proxy-tools.ts` — Expose `list_listener_configs` tool.
- `backend/src/routes/proxy-routes.ts` — Add `GET /api/proxy/listener-configs` endpoint.
  - Returns `{ configs: Record<string, ListenerConfigSchema> }` keyed by connection alias.

**Frontend:**

- Build a new `ListenerConfigPanel` component that auto-renders forms from field schemas.
- Field type → React control mapping:
  - `text` → `<input type="text">`
  - `number` → `<input type="number">` (respects min/max)
  - `boolean` → toggle switch
  - `select` → `<select>` dropdown
  - `multiselect` → checkbox group
  - `secret` → `<input type="password">`
  - `text[]` → tag input / comma-separated
- Integrate into ConfigureConnectionModal or as a separate panel.
- Save listener parameter changes back to `remote.config.json` (local mode) or display read-only (remote mode).

**Estimated effort:** ~400 lines across 5-6 files. The form renderer is the bulk of the work.

---

## Tier 3 — Full Feature (Higher Effort)

### 3.1 `resolve_listener_options` — Dynamic Dropdown Options

**Status: ✅ COMPLETE**

**What it does:** Fetches real-time options from APIs to populate dynamic dropdowns. For example:

- Discord: list of guilds (servers) the bot is in
- Trello: list of boards the user has access to
- Reddit: (user types subreddit names, no API needed)
- Slack: list of channels

Called lazily when a user opens/focuses a select field. Each field's `dynamicOptions` config specifies the API endpoint and response path.

**Why it matters:** Without this, users must manually enter opaque IDs. With it, they get friendly dropdown lists populated from their actual API accounts.

**Implementation:**

**Backend:**

- `backend/src/services/proxy-tools.ts` — Expose `resolve_listener_options` tool.
- `backend/src/routes/proxy-routes.ts` — Add `POST /api/proxy/resolve-listener-options` endpoint.
  - Body: `{ connection: string, paramKey: string, caller?: string }`
  - Returns: `{ options: Array<{ value: string, label: string }> }`

**Frontend:**

- Wire into the `ListenerConfigPanel` form renderer from Tier 2.2.
- When a `select`/`multiselect` field has `dynamicOptions`, fetch options lazily on field focus.
- Cache results for the session (avoid re-fetching on every focus).
- Show loading spinner while fetching.

**Estimated effort:** ~150 lines, but depends on Tier 2.2 being done first.

### 3.2 Multi-Instance Listener Support

**Status: ✅ COMPLETE**

**What it does:** A single connection (e.g., Trello) can have multiple concurrent listener instances. For example: watching 3 different Trello boards, or multiple Discord guilds, or several Reddit subreddits. Each instance has its own configuration overrides and event buffer.

Keyed by: `callerAlias:connectionAlias:instanceId`

Fields with `instanceKey: true` in the listener config schema create separate instances per unique value.

**Why it matters:** Power users watching multiple sources can't currently do so without duplicate connections.

**Implementation:**

**Backend:**

- `backend/src/services/connection-manager.ts` — Added `listenerInstances` CRUD:
  - `listListenerInstances()`, `addListenerInstance()`, `updateListenerInstance()`, `deleteListenerInstance()`
  - Stores in `remote.config.json` under `callers[alias].listenerInstances[connection]`
  - All writes trigger `reinitializeProxy()` for immediate effect
- `backend/src/routes/connections.ts` — Added REST endpoints:
  - `GET /:alias/listener-instances` — list instances
  - `POST /:alias/listener-instances` — create instance
  - `PUT /:alias/listener-instances/:instanceId` — update instance
  - `DELETE /:alias/listener-instances/:instanceId` — delete instance
- `control_listener` already supports `instance_id` parameter from Tier 2.1

**Frontend:**

- `frontend/src/api.ts` — Added `ListenerInstanceInfo` type and CRUD API functions
- `frontend/src/api.ts` — Added `instanceId?: string` to `IngestorStatus` (forward-compatible)
- `frontend/src/components/ListenerConfigPanel.tsx` — Added instance management UI:
  - Instance list with per-instance start/stop/restart controls
  - "Add Instance" form with instance key hint from config schema
  - Delete instance button (local mode only)
  - Bulk controls (start all / stop all / restart all)
  - Instance count in metadata footer
  - Single-instance status section hidden when multi-instance active
- `frontend/src/pages/settings/ConnectionsSettings.tsx` — Passes `localModeActive` to panel

**Note:** Per-instance status indicators await upgrading drawlatch from alpha.2 to alpha.4, which adds `instanceId` to `IngestorStatus`. The UI is forward-compatible and will automatically show per-instance status once upgraded.

---

## Tier 4 — Editable Listener Config (New in drawlatch alpha.4)

These 3 new MCP tools turn the read-only `ListenerConfigPanel` into a fully editable configuration UI. They also enable listener config management in **remote mode** (currently instance CRUD is local-mode only via direct `remote.config.json` access).

### 4.1 `get_listener_params` — Read Current Parameter Overrides

**What it does:** Returns the current listener parameter overrides for a connection, along with schema defaults. Supports `instance_id` for multi-instance listeners. This is the read-side complement to the schema from `list_listener_configs` — schemas tell you what fields exist, this tells you what values are currently set.

**Why it matters:** The `ListenerConfigPanel` currently shows field schemas with default values only. Without this tool, there's no way to know what the user has actually configured. Needed to populate form fields with current values.

**Drawlatch tool signature:**

```
Input:
  connection: string       // connection alias
  instance_id?: string     // optional, for multi-instance

Output:
  connection: string
  instance_id?: string
  params: Record<string, unknown>    // current override values
  defaults: Record<string, unknown>  // defaults from template schema
```

**Implementation:**

**Backend:**

- `backend/src/services/local-proxy.ts` — Add `get_listener_params` case. Read from `callers[alias].listenerInstances[connection][instanceId].params` (or single-instance equivalent). Return merged with schema defaults.
- `backend/src/services/proxy-tools.ts` — Expose `get_listener_params` tool to Claude sessions.
- `backend/src/routes/proxy.ts` — Add `GET /api/proxy/listener-params/:connection` endpoint.
  - Query: `?caller=...&instance_id=...`
  - Returns `{ params, defaults }`

**Frontend:**

- `frontend/src/api.ts` — Add `getListenerParams(connection, caller?, instanceId?)` function.
- `frontend/src/components/ListenerConfigPanel.tsx` — Fetch current params on mount and populate form fields with actual values instead of just showing schema defaults.

**Estimated effort:** ~100 lines across 4 files.

### 4.2 `set_listener_params` — Write Parameter Overrides

**What it does:** Sets listener parameter overrides for a connection. Validates params against the schema. Supports creating new multi-instance instances via `create_instance` flag. Merges into existing config and persists to `remote.config.json`.

**Why it matters:** This is the **key enabler** for editable forms. Currently the `ListenerConfigPanel` is read-only display. With this tool, the schema fields become actual form inputs that save changes. Also enables remote mode config management (currently local-mode only).

**Drawlatch tool signature:**

```
Input:
  connection: string
  instance_id?: string           // optional, for multi-instance
  params: Record<string, unknown> // key-value pairs to set
  create_instance?: boolean       // true = create new instance if doesn't exist

Output:
  success: boolean
  connection: string
  instance_id?: string
  params: Record<string, unknown>  // merged result after save
```

**Implementation:**

**Backend:**

- `backend/src/services/local-proxy.ts` — Add `set_listener_params` case. Validate against schema, merge params, save config, reinitialize proxy.
- `backend/src/services/proxy-tools.ts` — Expose `set_listener_params` tool to Claude sessions.
- `backend/src/routes/proxy.ts` — Add `PUT /api/proxy/listener-params/:connection` endpoint.
  - Body: `{ params, instance_id?, create_instance?, caller? }`

**Frontend:**

- `frontend/src/api.ts` — Add `setListenerParams(connection, params, caller?, instanceId?, createInstance?)` function.
- `frontend/src/components/ListenerConfigPanel.tsx` — Transform `FieldDisplay` from read-only to editable:
  - `text` → `<input type="text">`
  - `number` → `<input type="number">` with min/max
  - `boolean` → toggle switch
  - `select` → `<select>` dropdown (with dynamic options from `resolve_listener_options`)
  - `multiselect` → checkbox group
  - `secret` → `<input type="password">`
  - `text[]` → tag input / comma-separated
  - Add "Save" button that calls `setListenerParams()`
  - Show dirty/unsaved indicator
- Update "Add Instance" form to include param fields from schema (not just instance ID).

**Estimated effort:** ~400 lines across 4-5 files. The editable form renderer is the bulk.

### 4.3 `delete_listener_instance` — Remove Instance via Tool

**What it does:** Removes a multi-instance listener instance. Stops the running ingestor if active, removes from config, cleans up empty maps.

**Why it matters:** Instance deletion currently only works in **local mode** (callboard writes directly to `remote.config.json` via `connection-manager.ts`). This tool enables deletion in **remote mode** too, and provides a cleaner abstraction than direct config file manipulation.

**Drawlatch tool signature:**

```
Input:
  connection: string
  instance_id: string     // required

Output:
  success: boolean
  connection: string
  instance_id: string
```

**Implementation:**

**Backend:**

- `backend/src/services/local-proxy.ts` — Add `delete_listener_instance` case.
- `backend/src/services/proxy-tools.ts` — Expose `delete_listener_instance` tool to Claude sessions.
- `backend/src/routes/proxy.ts` — Add `DELETE /api/proxy/listener-instance/:connection/:instanceId` endpoint.

**Frontend:**

- `frontend/src/api.ts` — Add `deleteListenerInstanceViaProxy(connection, instanceId, caller?)` function.
- `frontend/src/components/ListenerConfigPanel.tsx` — Update delete handler to use proxy tool instead of direct config CRUD. Falls back to direct CRUD in local mode if tool unavailable.

**Migration note:** With these tools in place, the direct config CRUD in `connection-manager.ts` (`addListenerInstance`, `updateListenerInstance`, `deleteListenerInstance`) and the REST endpoints in `connections.ts` can be deprecated in favor of routing through the proxy tools. This gives a single code path for both local and remote modes.

**Estimated effort:** ~100 lines across 4 files.

---

## Tier 5 — Instance-Aware Enhancements

These leverage new fields added in drawlatch alpha.4 (`instanceId` on `IngestorStatus` and `IngestedEvent`).

**Pre-requisite:** Upgrade callboard's drawlatch dependency from `1.0.0-alpha.2` to `1.0.0-alpha.4`. Remove `any` casts for `startOne`/`stopOne`/`restartOne`/`listenerInstances` which are now properly typed.

### 5.1 `poll_events` with `instance_id` Filtering

**What it does:** The `poll_events` tool now accepts an optional `instance_id` parameter to filter events from a specific listener instance.

**Why it matters:** When multiple instances of the same connection are running (e.g., 3 Trello boards), users need to see events from a specific instance without noise from the others.

**Implementation:**

**Backend:**

- `backend/src/services/local-proxy.ts` — Update `poll_events` handler to pass `instance_id` through.
- `backend/src/services/proxy-tools.ts` — Add `instance_id` to `poll_events` tool schema.
- `backend/src/routes/proxy.ts` — Add `instance_id` query param to events endpoints.

**Frontend:**

- Event viewer: Add instance filter dropdown when viewing a multi-instance connection's events.
- Show instance badge on individual event entries.

**Estimated effort:** ~80 lines.

### 5.2 Per-Instance Status Display

**What it does:** `IngestorStatus` now includes `instanceId?: string` in drawlatch alpha.4. Multiple status entries are returned per connection for multi-instance listeners.

**Why it matters:** The `ListenerConfigPanel` currently can't show per-instance status (connected/stopped/error) because the old drawlatch didn't include `instanceId` in status output. Now it can.

**Implementation:**

**Frontend:**

- `frontend/src/components/ListenerConfigPanel.tsx` — Fetch all ingestor statuses, match by `connection + instanceId`, show status dot + state text on each instance row.
- `frontend/src/pages/settings/ConnectionsSettings.tsx` — Update `fetchIngestorStatuses` to handle multiple statuses per connection. Show aggregate badge on card (e.g., "3/5 connected").

**Estimated effort:** ~80 lines.

### 5.3 Per-Instance Event Badges

**What it does:** `IngestedEvent` now includes `instanceId?: string`. Events carry their source instance identity.

**Why it matters:** In the event log, events from different instances of the same connection are currently indistinguishable.

**Implementation:**

**Frontend:**

- Event viewer: Show instance ID badge on events where `instanceId` is set.
- Group-by-instance view option for multi-instance connections.

**Estimated effort:** ~50 lines.

---

## Drawlatch MCP Tools Summary

| Tool                       | Purpose                          | Tier | Callboard Status |
| -------------------------- | -------------------------------- | :--: | :--------------: |
| `secure_request`           | Make authenticated HTTP requests |  —   |  ✅ Integrated   |
| `list_routes`              | List available API routes        |  —   |  ✅ Integrated   |
| `poll_events`              | Poll for real-time events        |  —   |  ✅ Integrated   |
| `ingestor_status`          | Get listener statuses            |  —   |  ✅ Integrated   |
| `test_connection`          | Validate API credentials         |  1   |  ✅ Integrated   |
| `test_ingestor`            | Validate listener config         |  1   |  ✅ Integrated   |
| `control_listener`         | Start/stop/restart listeners     |  2   |  ✅ Integrated   |
| `list_listener_configs`    | Get listener field schemas       |  2   |  ✅ Integrated   |
| `resolve_listener_options` | Fetch dynamic dropdown options   |  3   |  ✅ Integrated   |
| `get_listener_params`      | Read current param overrides     |  4   |  ✅ Integrated   |
| `set_listener_params`      | Write param overrides            |  4   |  ✅ Integrated   |
| `delete_listener_instance` | Remove a listener instance       |  4   |  ✅ Integrated   |
| `list_listener_instances`  | List all configured instances    |  4   |  ✅ Integrated   |

Plus multi-instance listener support (Tier 3.2, ✅ done) and instance-aware enhancements (Tier 5, ⬜ not started).

---

## Architecture Notes

### Local Mode

- Callboard imports drawlatch functions directly: `loadRemoteConfig`, `resolveCallerRoutes`, `executeProxyRequest`, `IngestorManager`
- New features need additional drawlatch function imports
- Currently installed: `@wolpertingerlabs/drawlatch@1.0.0-alpha.2`
- Source drawlatch is at `1.0.0-alpha.4` — need to update for new fields

### Remote Mode

- `proxy-client.ts` encrypted channel handles arbitrary request types
- New tool calls follow the same encrypt→send→decrypt pattern
- Minimal new code needed per tool

### Frontend Pattern

- Each new tool gets: API function in `api.ts` → route in `proxy-routes.ts` → service call → UI component
- The listener config schema system (`ListenerConfigField`) is designed for UI auto-rendering:
  - Field types map to React controls
  - Dynamic options via lazy API resolution
  - Instance keys for multi-instance support

### Connection Templates (22 total)

GitHub, Discord Bot, Discord OAuth, Slack, Stripe, Notion, Linear, OpenAI, Anthropic, Google, Google AI, Reddit, X (Twitter), Mastodon, Bluesky, Trello, Telegram, Twitch, Hex, Lichess, OpenRouter, Devin

Each template includes: auth headers, secret placeholders, endpoint allowlists, `testConnection` config, `testIngestor` strategy, `listenerConfig` schema.

---

## Dependency Graph

```
Tier 0: Remote connections in settings (DONE)
  │
  ├── Tier 1.1: test_connection (DONE)
  ├── Tier 1.2: test_ingestor (DONE)
  │
  ├── Tier 2.1: control_listener (DONE)
  ├── Tier 2.2: list_listener_configs (DONE)
  │     │
  │     ├── Tier 3.1: resolve_listener_options (DONE)
  │     ├── Tier 3.2: multi-instance support (DONE)
  │     │
  │     └── Tier 4: Editable listener config ← NEW
  │           │
  │           ├── 4.1: get_listener_params (read current overrides)
  │           ├── 4.2: set_listener_params (write overrides — editable forms)
  │           └── 4.3: delete_listener_instance (remote-mode instance delete)
  │
  └── Tier 5: Instance-aware enhancements (requires drawlatch alpha.4 upgrade)
        │
        ├── 5.1: poll_events instance_id filtering
        ├── 5.2: per-instance status display
        └── 5.3: per-instance event badges
```

Tiers 0–3: ✅ Complete.
Tier 4: Depends on Tier 2.2 (form renderer) + Tier 3.2 (instance management). The big item is 4.2 — turning the read-only schema display into editable form controls.
Tier 5: Depends on upgrading drawlatch from alpha.2 → alpha.4. Independent of Tier 4.
