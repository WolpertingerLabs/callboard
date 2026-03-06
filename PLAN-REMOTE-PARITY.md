# Callboard: Remote Mode Parity Plan

## Goal

Make callboard's remote mode connections UI functionally equivalent to local mode — enable toggling connections, configuring secrets, and managing callers when connected to a drawlatch remote server, using the same UI components and flows.

## Current State

### Local mode (full management)
- `ConnectionsSettings.tsx`: Toggle switches, "Configure" button, secret status badges, caller create/delete
- `connection-manager.ts`: Direct file I/O to `remote.config.json` and `.env`
- `connections.ts` routes: Full CRUD for connections, secrets, callers, listener instances
- `ConfigureConnectionModal`: Secret input forms per connection

### Remote mode (read-only)
- Shows connections from `list_routes` with "Remote" badge instead of toggle
- No "Configure" button (`!isRemote` guard at line 1199)
- No secret status badges (`!isRemote` guard at line 1153)
- No caller create/delete (`canManageCallers = localModeActive && !remoteModeActive`)
- `listRemoteConnections()` returns empty `requiredSecrets`, `requiredSecretsSet`
- Connection cards use `Cloud` icon and "Remote" tag

## Dependency

This plan depends on drawlatch adding new remote tool handlers (see `../drawlatch/PLAN-CONFIG-MANAGEMENT.md`):
- `list_connection_templates` — replaces `list_routes` for settings page
- `set_connection_enabled` — toggle connections
- `set_secrets` — write secrets
- `get_secret_status` — check which secrets are set

## Changes Required

### Phase 0: Replace duplicated utilities with drawlatch imports

#### `backend/src/services/connection-manager.ts` — deduplicate

Callboard currently maintains ~100 lines of `.env` file I/O and secret-status logic that duplicates what drawlatch now exports from `@wolpertingerlabs/drawlatch/shared/env-utils`. Replace with imports:

**Remove these local functions** (lines 43-173):
- `callerToPrefix()` → import from `@wolpertingerlabs/drawlatch/shared/env-utils`
- `prefixedEnvVar()` → import from drawlatch
- `getEnvFilePath()` → use drawlatch's (it already reads from `getConfigDir()`)
- `loadEnvFile()` → import from drawlatch
- `loadMcpEnvIntoProcess()` → replace with `loadEnvIntoProcess()` from drawlatch
- `setEnvVars()` → import from drawlatch
- `isSecretSetForCaller()` → import from drawlatch

**Replace `setSecrets()`** (lines 364-421) with drawlatch's `setCallerSecrets()`, which handles the prefixed env var write + config env mapping update in one call.

**Keep** the `syncConfigDir()` call before drawlatch function calls to ensure `MCP_CONFIG_DIR` is set.

After this change, `connection-manager.ts` becomes a thin orchestration layer: it calls drawlatch utilities for env/secret operations and adds callboard-specific concerns (proxy reinitialization, active config dir resolution).

### Phase 1: Backend — Remote connection management via proxy tools

#### 1a. `backend/src/services/connection-manager.ts`

**Modify `listRemoteConnections()`** to use `list_connection_templates` instead of `list_routes`:
- Call `client.callTool("list_connection_templates")`
- Map result to `ConnectionStatus[]` with full secret info (requiredSecrets, requiredSecretsSet, etc.)
- Fallback to current `list_routes` behavior if tool is unsupported (backward compat)
- Remove `source: "remote"` distinction — or keep it for UI hint but don't gate features on it

**Add remote-mode implementations** for operations that currently only work locally:

```ts
// New function: toggle connection via remote proxy
export async function setRemoteConnectionEnabled(
  alias: string, enabled: boolean, callerAlias: string
): Promise<void>

// New function: set secrets via remote proxy
export async function setRemoteSecrets(
  secrets: Record<string, string>, callerAlias: string
): Promise<Record<string, boolean>>

// New function: get secret status via remote proxy
export async function getRemoteSecretStatus(
  connectionAlias: string, callerAlias: string
): Promise<{ requiredSecretsSet: Record<string, boolean>; optionalSecretsSet: Record<string, boolean> }>
```

Each calls the corresponding drawlatch tool via `client.callTool()`.

#### 1b. `backend/src/routes/connections.ts`

**Modify existing routes** to dispatch to remote functions when in remote mode:

- `POST /:alias/enable` — call `setRemoteConnectionEnabled()` when remote
- `PUT /:alias/secrets` — call `setRemoteSecrets()` when remote
- `GET /:alias/secrets` — call `getRemoteSecretStatus()` when remote
- `GET /` — already dispatches via `listRemoteConnections()`, just needs richer data
- `POST /callers` — remains local-only (caller creation is server-side privilege)
- `DELETE /callers/:alias` — remains local-only

**Pattern**: Check `settings.proxyMode` at the top of each handler and dispatch accordingly. Use the existing `safeCallTool` pattern for graceful "unsupported" fallback.

#### 1c. `backend/src/routes/proxy.ts` (minimal changes)

No new routes needed — the existing `/api/connections/*` routes will handle remote dispatch. The `/api/proxy/*` routes remain for agent-facing dashboard data.

### Phase 2: Frontend — Remove remote-mode guards

#### 2a. `frontend/src/pages/settings/ConnectionsSettings.tsx`

**Remove `isRemote` feature gates:**

1. **Toggle switch** (line 1012): Show toggle for remote connections too (not just "Remote" badge). Keep the badge as a visual indicator but add the toggle.

2. **Configure button** (line 1199): Remove `!isRemote` guard. The Configure button should work for remote connections.

3. **Secret status badge** (line 1153): Remove `!isRemote` guard. Show secret status for remote connections since `list_connection_templates` now provides it.

4. **Caller management** (line 241): `canManageCallers` should remain false for remote mode — caller creation/deletion stays server-side. But the caller switcher dropdown should still work (it already does).

**Specific UI changes:**
- Remote connection cards: Replace `Cloud` icon + "Remote" badge with same `Wifi` icon + toggle as local. Add a small "(remote)" label in the description area to indicate source.
- Or: Keep `Cloud` icon but enable all actions. The visual distinction is still useful.

#### 2b. `frontend/src/components/ConfigureConnectionModal.tsx`

**No changes needed** — the modal is already generic. It takes a `ConnectionStatus` and renders secret inputs based on `requiredSecrets`/`optionalSecrets`. Once the backend provides this data for remote connections, the modal will work as-is.

#### 2c. `frontend/src/api.ts` (API client)

**No changes needed** — the existing `setConnectionEnabled()`, `setSecrets()`, `getSecretStatus()` calls already go through the backend routes, which will handle remote dispatch.

### Phase 3: Graceful degradation

When connected to an older drawlatch server that doesn't support the new tools:

1. **Detection**: The first call to `list_connection_templates` will fail with "Unknown tool"
2. **Fallback**: `listRemoteConnections()` falls back to `list_routes` (existing behavior)
3. **UI**: When fallback is active, disable Configure/toggle buttons and show a hint: "Upgrade drawlatch server to manage connections remotely"
4. **Mechanism**: Add a `remoteCapabilities` field to the connections API response:
   ```ts
   { templates, callers, localModeActive, remoteModeActive, remoteConfigManagement: boolean }
   ```

### Phase 4: Shared types update

#### `shared/types/connections.ts`

- Optionally remove `source?: "local" | "remote"` or repurpose it as a UI hint only
- No new types needed — `ConnectionStatus` already has all fields

## File Change Summary

| File | Change Type | Description |
|------|------------|-------------|
| `backend/src/services/connection-manager.ts` | Modify | Remove ~100 lines of duplicated env/secret utils, import from `@wolpertingerlabs/drawlatch/shared/env-utils`. Add remote-mode functions, enhance `listRemoteConnections()` |
| `backend/src/routes/connections.ts` | Modify | Dispatch to remote functions based on proxy mode |
| `frontend/src/pages/settings/ConnectionsSettings.tsx` | Modify | Remove `isRemote` feature gates on toggle/configure/secrets |
| `shared/types/connections.ts` | Minor | Optional: add `remoteConfigManagement` flag |

## Non-Goals

- Caller creation/deletion in remote mode (stays server-side)
- Custom connector management in remote mode (stays server-side)
- Server settings management in remote mode (host/port/keys)
- Any changes to the agent dashboard `Connections.tsx` (already works for both modes)

## Testing Strategy

1. Run callboard in local mode — verify no regressions
2. Run drawlatch remote server with new tools
3. Switch callboard to remote mode
4. Verify: connection list shows all templates (not just enabled)
5. Verify: toggle switches work
6. Verify: Configure modal opens, secrets can be set
7. Verify: secret status badges update after setting secrets
8. Verify: test connection/ingestor buttons work
9. Verify: listener controls work (already work, just verify)
10. Verify: fallback to read-only when connected to old drawlatch server
