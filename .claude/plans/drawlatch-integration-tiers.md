# Drawlatch Integration Plan for Callboard

## Overview

Drawlatch is an encrypted MCP proxy for Claude Code that enables secure, authenticated HTTP requests to 22+ external APIs with real-time event ingestion. Callboard integrates drawlatch for both local (in-process) and remote (encrypted) proxy modes.

This document tracks all new drawlatch features that need to be integrated into callboard, organized by priority tier.

---

## Current State (What's Already Integrated)

| MCP Tool | Claude Sessions | Backend Route | Frontend UI |
|----------|:-:|:-:|:-:|
| `secure_request` | ✅ | ✅ | — |
| `list_routes` | ✅ | ✅ `GET /api/proxy/routes` | ✅ |
| `poll_events` | ✅ | ✅ `GET /api/proxy/events` | ✅ |
| `ingestor_status` | ✅ | ✅ `GET /api/proxy/ingestors` | ✅ |

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

## Tier 1 — Quick Wins (Low Effort, High Impact)

### 1.1 `test_connection` — Validate API Credentials

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

## Tier 2 — High Value (Medium Effort, High Impact)

### 2.1 `control_listener` — Runtime Listener Start/Stop/Restart

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

**What it does:** A single connection (e.g., Trello) can have multiple concurrent listener instances. For example: watching 3 different Trello boards, or multiple Discord guilds, or several Reddit subreddits. Each instance has its own configuration overrides and event buffer.

Keyed by: `callerAlias:connectionAlias:instanceId`

Fields with `instanceKey: true` in the listener config schema create separate instances per unique value.

**Why it matters:** Power users watching multiple sources can't currently do so without duplicate connections.

**Implementation:**

**Backend:**
- `backend/src/services/connection-manager.ts` — Add `listenerInstances` config management.
  - CRUD operations for instances per connection per caller.
  - Store in `remote.config.json` under `callers[alias].listenerInstances[connection]`.
- Update `poll_events` calls to support `instance_id` parameter.
- Update `control_listener` calls to support `instance_id` parameter.

**Frontend:**
- Add instance management UI to the ListenerConfigPanel:
  - List existing instances
  - Create new instance (with instanceKey field)
  - Delete instance
  - Per-instance parameter overrides
- Instance selector in the event viewer for filtering events by instance.
- Instance-aware start/stop/restart controls.

**Estimated effort:** ~500+ lines across many files. This is the largest single feature.

---

## Drawlatch MCP Tools Summary

| Tool | Purpose | Tier | Callboard Status |
|------|---------|:----:|:---:|
| `secure_request` | Make authenticated HTTP requests | — | ✅ Integrated |
| `list_routes` | List available API routes | — | ✅ Integrated |
| `poll_events` | Poll for real-time events | — | ✅ Integrated |
| `ingestor_status` | Get listener statuses | — | ✅ Integrated |
| `test_connection` | Validate API credentials | 1 | ❌ Not integrated |
| `test_ingestor` | Validate listener config | 1 | ❌ Not integrated |
| `control_listener` | Start/stop/restart listeners | 2 | ❌ Not integrated |
| `list_listener_configs` | Get listener field schemas | 2 | ❌ Not integrated |
| `resolve_listener_options` | Fetch dynamic dropdown options | 3 | ❌ Not integrated |

Plus multi-instance listener support (not a tool, but a feature across multiple tools).

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
  ├── Tier 1.1: test_connection (independent)
  ├── Tier 1.2: test_ingestor (independent)
  │
  ├── Tier 2.1: control_listener (independent)
  ├── Tier 2.2: list_listener_configs (independent, but enables Tier 3)
  │     │
  │     ├── Tier 3.1: resolve_listener_options (depends on 2.2 form renderer)
  │     └── Tier 3.2: multi-instance support (depends on 2.2 + 2.1)
```

Tier 1 items are fully independent and can be done in any order.
Tier 2 items are independent of each other.
Tier 3 items depend on Tier 2.2 (the form renderer).
