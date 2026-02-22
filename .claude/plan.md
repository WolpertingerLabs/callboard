# Plan: claude-code-ui — Staged Proxy Integration

## Stage Dependency Graph

```
mcp-secure-proxy Stage 1  ──→  claude-code-ui Stage 1
  (exports + executeProxyRequest)    (LocalProxy + proxy tools for all sessions)

mcp-secure-proxy Stage 2  ──→  claude-code-ui Stage 2
  (connection template introspection) (connection management UI, local mode)

mcp-secure-proxy Stage 3  ──→  claude-code-ui Stage 3
  (admin API + bootstrap)            (remote provisioning + key management)

                                claude-code-ui Stage 4
                                (setup wizard + polish)
```

Each stage ships independently and delivers standalone value.

---

## Stage 1: LocalProxy + Proxy Tools for All Sessions

### Problem

Today, proxy tools are only available via an external MCP stdio process that requires a running remote server — even when everything is on the same machine. This means:

1. Single-user setups pay the cost of encryption, HTTP, and process management for no benefit
2. Proxy tools only work in agent sessions (injected per-agent), not in regular chat sessions
3. The 410-line `proxy-client.ts` is a vendored copy of mcp-secure-proxy's crypto code — it drifts

### Solution

#### 1a. Add `file:` dependency on mcp-secure-proxy

In `backend/package.json`:
```json
"dependencies": {
  "mcp-secure-proxy": "file:../../mcp-secure-proxy"
}
```

Both repos live side-by-side under `WolpertingerLabs/`. npm symlinks the package — changes in mcp-secure-proxy are immediately visible. Swap to a published npm version later by changing the version string.

Build integration: mcp-secure-proxy's `postinstall` script runs `npm run build`, so `npm install` in claude-code-ui triggers it automatically.

#### 1b. Build `LocalProxy` class

New file: `backend/src/services/local-proxy.ts`

In local mode, there is **no separate server, no port, no child process, and no encryption**. `LocalProxy` imports the core functions from mcp-secure-proxy and calls them directly in-process.

```typescript
import {
  loadRemoteConfig, resolveCallerRoutes, resolveRoutes,
  resolveSecrets,
  type ResolvedRoute,
} from "mcp-secure-proxy/shared/config";
import { executeProxyRequest } from "mcp-secure-proxy/remote/server";
import { IngestorManager } from "mcp-secure-proxy/remote/ingestors";

export class LocalProxy {
  private routes: ResolvedRoute[];
  private ingestorManager: IngestorManager;
  private callerAlias: string;

  constructor(private mcpConfigDir: string, callerAlias: string) {
    this.callerAlias = callerAlias;

    // Load config and resolve routes — same logic the remote server uses at startup
    const config = loadRemoteConfig();
    const callerRoutes = resolveCallerRoutes(config, callerAlias);
    const caller = config.callers[callerAlias];
    const callerEnv = resolveSecrets(caller?.env ?? {});
    this.routes = resolveRoutes(callerRoutes, callerEnv);

    // IngestorManager handles Discord bots, webhook receivers, poll loops, etc.
    this.ingestorManager = new IngestorManager(config);
  }

  async start(): Promise<void> {
    await this.ingestorManager.startAll();
  }

  async stop(): Promise<void> {
    await this.ingestorManager.stopAll();
  }

  /** Reinitialize after config/secret changes (re-reads config from disk) */
  async reinitialize(): Promise<void> {
    await this.stop();
    const config = loadRemoteConfig();
    const callerRoutes = resolveCallerRoutes(config, this.callerAlias);
    const caller = config.callers[this.callerAlias];
    const callerEnv = resolveSecrets(caller?.env ?? {});
    this.routes = resolveRoutes(callerRoutes, callerEnv);
    this.ingestorManager = new IngestorManager(config);
    await this.start();
  }

  /** Same interface as ProxyClient.callTool() — drop-in replacement */
  async callTool(toolName: string, toolInput?: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case "http_request":
        // Delegates to the SAME function the remote server uses — no duplication
        return executeProxyRequest(
          toolInput as { method: string; url: string; headers?: Record<string, string>; body?: unknown },
          this.routes,
        );

      case "list_routes":
        return this.routes.map((route, index) => ({
          index,
          name: route.name,
          description: route.description,
          docsUrl: route.docsUrl,
          allowedEndpoints: route.allowedEndpoints,
          secretNames: Object.keys(route.secrets),
          autoHeaders: Object.keys(route.headers),
        }));

      case "poll_events": {
        const { connection, after_id } = (toolInput ?? {}) as {
          connection?: string;
          after_id?: number;
        };
        if (connection) {
          return this.ingestorManager.getEvents(this.callerAlias, connection, after_id ?? -1);
        }
        return this.ingestorManager.getAllEvents(this.callerAlias, after_id ?? -1);
      }

      case "ingestor_status":
        return this.ingestorManager.getStatuses(this.callerAlias);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
```

**Key design decision:** `httpRequest()` calls `executeProxyRequest()` imported from mcp-secure-proxy — the exact same function the remote server uses. No behavioral drift possible.

#### 1c. Extend `AgentSettings` with proxy mode

In `shared/types/agentSettings.ts`:

```typescript
export interface AgentSettings {
  /** Absolute path to .mcp-secure-proxy/ directory containing keys and config */
  mcpConfigDir?: string;

  /** Proxy mode: 'local' runs in-process, 'remote' connects to external server */
  proxyMode?: "local" | "remote";

  /** URL of the remote MCP secure proxy server (used in 'remote' mode only) */
  remoteServerUrl?: string;
}
```

No `localServerPort` or `localServerAutoStart` — there's no server to start in local mode.

#### 1d. Update `proxy-singleton.ts` — return `LocalProxy` or `ProxyClient` based on mode

```typescript
import { LocalProxy } from "./local-proxy.js";

// Shared interface both classes satisfy
export interface ProxyLike {
  callTool(toolName: string, toolInput?: Record<string, unknown>): Promise<unknown>;
}

// Singleton LocalProxy instance (shared across all sessions)
let localProxyInstance: LocalProxy | null = null;

export function getLocalProxyInstance(): LocalProxy | null {
  return localProxyInstance;
}

export function setLocalProxyInstance(proxy: LocalProxy): void {
  localProxyInstance = proxy;
}

/**
 * Get the appropriate proxy for a given alias.
 * In local mode: returns the shared LocalProxy (ignores alias — single-user).
 * In remote mode: returns a cached ProxyClient for the alias.
 */
export function getProxy(alias: string): ProxyLike | null {
  const settings = getAgentSettings();

  if (settings.proxyMode === "local") {
    return localProxyInstance;
  } else {
    return getProxyClient(alias); // existing behavior
  }
}
```

The existing `getProxyClient()`, `resetClient()`, `resetAllClients()`, `isProxyConfigured()`, `getConfiguredAliases()` all remain unchanged — they're used for remote mode and by event-watcher.

#### 1e. Build `proxy-tools.ts` — SDK MCP server for proxy tools

New file: `backend/src/services/proxy-tools.ts`

This is an in-process MCP server that exposes proxy tools to Claude. It gets injected into **every** chat session — both regular and agent.

```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getProxy } from "./proxy-singleton.js";

/**
 * Build an in-process MCP server exposing proxy tools.
 *
 * Injected into EVERY chat session — regular chats and agent chats.
 * In local mode: calls go through LocalProxy (in-process).
 * In remote mode: calls go through ProxyClient (encrypted HTTP).
 */
export function buildProxyToolsServer(keyAlias: string) {
  return createSdkMcpServer({
    name: "mcp-proxy",
    version: "1.0.0",
    tools: [
      tool(
        "secure_request",
        "Make an authenticated HTTP request through a configured connection. " +
          "Route-level headers (e.g., Authorization) are injected automatically. " +
          "Use list_routes first to discover available APIs.",
        {
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
          url: z.string().describe("Full URL, may contain ${VAR} placeholders"),
          headers: z.record(z.string()).optional().describe("Request headers"),
          body: z.any().optional().describe("Request body (object for JSON, string for raw)"),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) return { content: [{ type: "text" as const, text: "Proxy not configured" }] };
          const result = await proxy.callTool("http_request", input);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        },
      ),

      tool(
        "list_routes",
        "List all available API routes/connections and their endpoints, " +
          "auto-injected headers, and available secret placeholder names.",
        {},
        async () => {
          const proxy = getProxy(keyAlias);
          if (!proxy) return { content: [{ type: "text" as const, text: "Proxy not configured" }] };
          const result = await proxy.callTool("list_routes");
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        },
      ),

      tool(
        "poll_events",
        "Poll for new events from ingestors (Discord messages, GitHub webhooks, etc.). " +
          "Pass after_id from the last event to get only new events.",
        {
          connection: z.string().optional().describe("Connection alias to poll. Omit for all."),
          after_id: z.number().optional().describe("Return events with id > after_id. Omit for all buffered events."),
        },
        async (input) => {
          const proxy = getProxy(keyAlias);
          if (!proxy) return { content: [{ type: "text" as const, text: "Proxy not configured" }] };
          const result = await proxy.callTool("poll_events", input);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        },
      ),

      tool(
        "ingestor_status",
        "Get the status of all active ingestors. Shows connection state, " +
          "buffer sizes, event counts, and any errors.",
        {},
        async () => {
          const proxy = getProxy(keyAlias);
          if (!proxy) return { content: [{ type: "text" as const, text: "Proxy not configured" }] };
          const result = await proxy.callTool("ingestor_status");
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        },
      ),
    ],
  });
}
```

#### 1f. Inject proxy tools in `claude.ts` for ALL sessions

In `sendMessage()`, **before** the agent-specific tools block:

```typescript
const mcpServers: Record<string, any> = mcpOpts ? { ...mcpOpts.mcpServers } : {};
const allowedTools: string[] = mcpOpts ? [...mcpOpts.allowedTools] : [];

// ── Proxy tools: injected for ALL sessions ──
const settings = getAgentSettings();
if (settings.proxyMode && settings.mcpConfigDir) {
  // Determine key alias: agent's alias if available, otherwise "default"
  const proxyKeyAlias = opts.agentAlias
    ? (getAgent(opts.agentAlias)?.mcpKeyAlias ?? "default")
    : "default";

  try {
    const proxyServer = buildProxyToolsServer(proxyKeyAlias);
    if (proxyServer && proxyServer.type === "sdk" && proxyServer.instance) {
      mcpServers["mcp-proxy"] = proxyServer;
      allowedTools.push("mcp__mcp-proxy__*");
      log.info(`Injected proxy tools (mode=${settings.proxyMode}, alias=${proxyKeyAlias})`);
    }
  } catch (err: any) {
    log.error(`Failed to build proxy tools server: ${err.message}`);
  }
}

// ── Agent tools: injected only for agent sessions (existing code, unchanged) ──
if (opts.agentAlias) {
  // ... existing agent tools injection ...
}
```

#### 1g. Initialize `LocalProxy` on boot

In `backend/src/index.ts`, inside the `app.listen` callback:

```typescript
// Start local proxy if configured
const settings = getAgentSettings();
if (settings.proxyMode === "local" && settings.mcpConfigDir) {
  try {
    const localProxy = new LocalProxy(settings.mcpConfigDir, "default");
    await localProxy.start();
    setLocalProxyInstance(localProxy);
    log.info("Local proxy started");
  } catch (err: any) {
    log.error(`Failed to start local proxy: ${err.message}`);
  }
}
```

Add to graceful shutdown:
```typescript
const localProxy = getLocalProxyInstance();
if (localProxy) await localProxy.stop();
```

#### 1h. Mount webhook route for local mode

On the existing Express app, a single route for webhook ingestors:

```typescript
app.post("/webhooks/:path", (req, res) => {
  const localProxy = getLocalProxyInstance();
  if (!localProxy) {
    res.status(404).json({ error: "Local proxy not active" });
    return;
  }
  // Forward to ingestor manager
  const ingestors = localProxy.ingestorManager.getWebhookIngestors(req.params.path);
  if (ingestors.length === 0) {
    res.status(404).json({ error: "No webhook ingestor for this path" });
    return;
  }
  for (const ingestor of ingestors) {
    ingestor.handleWebhook(req.headers, req.body);
  }
  res.json({ received: true });
});
```

#### 1i. Replace vendored `proxy-client.ts` with package imports

The existing `proxy-client.ts` (410 lines of vendored crypto/handshake code) is replaced by importing from the package:

```typescript
// Before (vendored):
import { ProxyClient } from "./proxy-client.js";

// After (package import):
import { HandshakeInitiator, EncryptedChannel } from "mcp-secure-proxy/shared/crypto";
import { loadKeyBundle, loadPublicKeys } from "mcp-secure-proxy/shared/crypto";
```

**However:** `ProxyClient` as a class still exists in claude-code-ui — it wraps the handshake + encrypted channel for remote mode. The refactor is:
1. Keep `ProxyClient` class in a slimmed-down `proxy-client.ts` that imports crypto primitives from the package instead of implementing them
2. Or: move `ProxyClient` into mcp-secure-proxy as an export (it belongs there anyway)

**Recommendation for Stage 1:** Option 1 (slim down, import primitives). Moving `ProxyClient` into the package is cleaner but adds scope. Do it in a follow-up if desired.

#### 1j. Update Settings UI with mode toggle

In `frontend/src/pages/agents/AgentSettings.tsx`, add a mode toggle:

```
┌─── Mode ───────────────────────────────────────────┐
│  ○ Local (runs in-process, no separate server)     │
│  ○ Remote (connect to external server)             │
│    Server URL: [https://proxy.example.com:9999]    │
└────────────────────────────────────────────────────┘
```

Update the `PUT /api/agent-settings` route to accept `proxyMode` and `remoteServerUrl`.

### Files to Change

| File | Change |
|---|---|
| `backend/package.json` | Add `mcp-secure-proxy` file dependency |
| `shared/types/agentSettings.ts` | Add `proxyMode`, `remoteServerUrl` |
| `backend/src/services/local-proxy.ts` | **New.** `LocalProxy` class |
| `backend/src/services/proxy-tools.ts` | **New.** SDK MCP server for proxy tools |
| `backend/src/services/proxy-singleton.ts` | Add `ProxyLike` interface, `getProxy()`, local proxy singleton |
| `backend/src/services/proxy-client.ts` | Replace vendored crypto with imports from mcp-secure-proxy |
| `backend/src/services/claude.ts` | Inject `mcp-proxy` MCP server for ALL sessions (before agent tools block) |
| `backend/src/services/agent-settings.ts` | Handle new settings fields |
| `backend/src/routes/agent-settings.ts` | Accept `proxyMode`, `remoteServerUrl` in PUT |
| `backend/src/index.ts` | Initialize LocalProxy on boot, mount webhook route, add to shutdown |
| `frontend/src/pages/agents/AgentSettings.tsx` | Mode toggle UI |

### What Keeps Working (No Changes)

- `event-watcher.ts` — continues using `getProxyClient(alias)` for polling. In remote mode, nothing changes. In local mode, the watcher pattern still works because `getProxy()` returns the `LocalProxy` which satisfies the same `callTool()` interface.
- All existing agent-tools injection — unchanged, proxy tools are additive.
- All existing proxy routes (`/api/proxy/*`) — unchanged, still call `getProxyClient()`.

### Done When

- `npm install` in claude-code-ui creates symlink to mcp-secure-proxy
- Setting `proxyMode: "local"` starts an in-process `LocalProxy` on boot
- Any chat session (regular or agent) sees `secure_request`, `list_routes`, `poll_events`, `ingestor_status` tools
- Claude can call `list_routes` in a regular chat and see available connections
- Claude can call `secure_request` to make an API call through a configured connection
- Remote mode continues to work exactly as before
- `proxy-client.ts` imports crypto from mcp-secure-proxy instead of reimplementing it

---

## Stage 2: Connection Management UI (Local Mode)

### Problem

Users can't browse available connection templates, enable/disable connections, or provide API keys through the UI. They have to manually edit JSON files and `.env` files. This is the main barrier to adoption.

### Solution

#### 2a. `ConnectionManager` service

New file: `backend/src/services/connection-manager.ts`

Handles local-mode connection management by reading/writing config files directly. (Remote mode support is deferred to Stage 3.)

```typescript
import { listConnectionTemplates, type ConnectionTemplateInfo } from "mcp-secure-proxy/shared/connections";
import { loadRemoteConfig, saveRemoteConfig } from "mcp-secure-proxy/shared/config";

export class ConnectionManager {
  constructor(private mcpConfigDir: string) {}

  /** List all available connection templates with metadata */
  getTemplates(): ConnectionTemplateInfo[] {
    return listConnectionTemplates();
  }

  /** Get a caller's enabled connections + secret status */
  getCallerConnections(callerAlias: string): {
    connections: string[];
    secretStatus: Record<string, Record<string, boolean>>;
  } { /* ... */ }

  /** Enable a connection for a caller */
  async enableConnection(callerAlias: string, connectionAlias: string): Promise<void> {
    // 1. Load remote.config.json
    // 2. Add connectionAlias to callers[callerAlias].connections
    // 3. Save remote.config.json
    // 4. getLocalProxyInstance()?.reinitialize()  ← in-process, instant
  }

  /** Disable a connection for a caller */
  async disableConnection(callerAlias: string, connectionAlias: string): Promise<void> {
    // Reverse of enable — remove from connections array, reinitialize
  }

  /** Set secrets for a connection (local mode — direct .env write) */
  async setSecrets(
    callerAlias: string,
    connectionAlias: string,
    secrets: Record<string, string>,
  ): Promise<void> {
    // 1. For each secret: write CALLERALIAS_SECRETNAME=value to .env (0600 perms)
    // 2. Update caller.env mapping: { "SECRET_NAME": "${CALLERALIAS_SECRETNAME}" }
    // 3. Save .env and remote.config.json
    // 4. getLocalProxyInstance()?.reinitialize()  ← in-process, instant
  }

  /** Check which secrets are set (never returns values) */
  getSecretStatus(callerAlias: string, connectionAlias: string): Record<string, boolean> {
    // Read .env, check which required keys have values
  }
}
```

#### 2b. Connection Management API

New file: `backend/src/routes/connections.ts`

```
GET  /api/connections/templates              → List all templates with metadata
GET  /api/connections/templates/:alias       → Single template details
GET  /api/connections/:callerAlias           → Caller's connections + secret status
POST /api/connections/:callerAlias/enable    → { connectionAlias }
POST /api/connections/:callerAlias/disable   → { connectionAlias }
POST /api/connections/:callerAlias/secrets   → { connectionAlias, secrets: { KEY: "value" } }
GET  /api/connections/:callerAlias/secret-status → { connectionAlias } → Record<string, boolean>
```

#### 2c. Connections Manager UI

New files:
- `frontend/src/pages/agents/ConnectionsManager.tsx` — main page
- `frontend/src/components/ConnectionCard.tsx` — per-connection card
- `frontend/src/components/ConfigureConnectionModal.tsx` — secret entry modal

```
┌────────────────────────────────────────────────────────┐
│  Connection Manager                                     │
│                                                         │
│  Managing connections for: [default ▼]                  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ GitHub API                        [Enabled ✓]     │  │
│  │ Access GitHub repos, issues, PRs                  │  │
│  │ Required: GITHUB_TOKEN            [Set ✓]         │  │
│  │ [Configure] [Docs]                                │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Discord Bot                       [Disabled]      │  │
│  │ Real-time Discord Gateway events                  │  │
│  │ Required: DISCORD_BOT_TOKEN       [Not set]       │  │
│  │ [Configure] [Docs]                                │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ... (all templates)                                    │
└────────────────────────────────────────────────────────┘
```

Configure modal:
```
┌─────────────────────────────────────────────┐
│  Configure: Discord Bot                      │
│                                              │
│  Enabled: [✓]                                │
│                                              │
│  ── Required Secrets ──                      │
│  DISCORD_BOT_TOKEN: [••••••••] [Show] [Set]  │
│                                              │
│  ── Ingestor Settings (if applicable) ──     │
│  Guild Filter: [guild-id-1, guild-id-2]      │
│  Channel Filter: [channel-id-1]              │
│  Buffer Size: [200]                          │
│                                              │
│  [Save]  [Cancel]                            │
└─────────────────────────────────────────────┘
```

### Files to Change

| File | Change |
|---|---|
| `backend/src/services/connection-manager.ts` | **New.** Connection template loading, enable/disable, secret management |
| `backend/src/routes/connections.ts` | **New.** REST API for connection management |
| `backend/src/index.ts` | Mount connections router |
| `frontend/src/pages/agents/ConnectionsManager.tsx` | **New.** Connection management page |
| `frontend/src/components/ConnectionCard.tsx` | **New.** Per-connection display component |
| `frontend/src/components/ConfigureConnectionModal.tsx` | **New.** Secret entry + ingestor config modal |
| `frontend/src/api.ts` | Add connection management API functions |

### Done When

- User can open Connections Manager page and see all 23+ available connection templates
- User can enable GitHub, see that `GITHUB_TOKEN` is required, enter it, and save
- The token is written to `.env` with correct per-caller prefix
- `LocalProxy.reinitialize()` picks up the change immediately (no restart)
- User can make a `secure_request` to GitHub in a chat session and it works
- Secret values are NEVER shown after being set — only "Set ✓" / "Not set" status

---

## Stage 3: Remote Mode Provisioning + Key Management

### Problem

In remote mode, the UI can't manage callers, connections, or secrets on the remote server. Users have to SSH in and edit config files manually. Also, generating new key aliases and registering them with a remote server requires CLI commands.

### Prerequisite

mcp-secure-proxy Stage 3 (admin API + bootstrap) must be complete.

### Solution

#### 3a. `KeyManager` service

New file: `backend/src/services/key-manager.ts`

```typescript
import {
  generateKeyBundle, saveKeyBundle, extractPublicKeys, fingerprint,
  loadPublicKeys,
} from "mcp-secure-proxy/shared/crypto";

export class KeyManager {
  constructor(private mcpConfigDir: string) {}

  /** Generate a new local keypair for the given alias */
  async generateLocalKeys(alias: string): Promise<{ fingerprint: string }> {
    // Generate Ed25519 + X25519 keypair, save to keys/local/{alias}/
  }

  /** Register alias as a caller — dispatches to local or remote based on mode */
  async registerCaller(alias: string, connections: string[]): Promise<void> {
    const settings = getAgentSettings();
    if (settings.proxyMode === "local") {
      await this.registerLocalCaller(alias, connections);
    } else {
      await this.registerRemoteCaller(alias, connections);
    }
  }

  private async registerLocalCaller(alias: string, connections: string[]): Promise<void> {
    // 1. Copy public keys to keys/peers/{alias}/
    // 2. Add caller entry to remote.config.json
    // 3. localProxy.reinitialize()
  }

  private async registerRemoteCaller(alias: string, connections: string[]): Promise<void> {
    // 1. Read public keys from keys/local/{alias}/
    // 2. Use admin key's ProxyClient to call admin_register_caller on remote server
    // 3. Remote server stores keys and adds caller entry
  }
}
```

#### 3b. Extend `AgentSettings` with admin key alias

```typescript
export interface AgentSettings {
  mcpConfigDir?: string;
  proxyMode?: "local" | "remote";
  remoteServerUrl?: string;
  /** Admin key alias for provisioning on remote server (remote mode only) */
  adminKeyAlias?: string;
}
```

#### 3c. Remote-mode connection management

Update `ConnectionManager` to dispatch to admin API when in remote mode:

```typescript
async enableConnection(callerAlias: string, connectionAlias: string): Promise<void> {
  const settings = getAgentSettings();
  if (settings.proxyMode === "local") {
    // Direct file write (existing Stage 2 code)
  } else {
    // Use admin key's ProxyClient to call admin tools
    const adminClient = getProxyClient(settings.adminKeyAlias!);
    await adminClient.callTool("admin_update_caller_connections", { ... });
  }
}

async setSecrets(callerAlias: string, connectionAlias: string, secrets: Record<string, string>): Promise<void> {
  const settings = getAgentSettings();
  if (settings.proxyMode === "local") {
    // Direct .env write (existing Stage 2 code)
  } else {
    const adminClient = getProxyClient(settings.adminKeyAlias!);
    await adminClient.callTool("admin_set_secrets", { callerAlias, connectionAlias, secrets });
  }
}
```

#### 3d. Key generation UI

In Agent Settings, add key generation:

```
┌─── Keys ──────────────────────────────────────────┐
│  Discovered Aliases:                               │
│    ✓ default  (signing ✓, exchange ✓)             │
│    ✓ agent-1  (signing ✓, exchange ✓)             │
│  [+ Generate New Key Alias]                       │
│                                                    │
│  Admin Key (remote mode only):                     │
│    Admin Alias: [default ▼]                       │
└────────────────────────────────────────────────────┘
```

New API endpoints:
```
POST /api/agent-settings/generate-key    → { alias } → Generate new keypair
POST /api/agent-settings/register-caller → { alias, connections } → Register with server
```

### Files to Change

| File | Change |
|---|---|
| `backend/src/services/key-manager.ts` | **New.** Key generation + caller registration |
| `backend/src/services/connection-manager.ts` | Add remote-mode dispatch via admin API |
| `shared/types/agentSettings.ts` | Add `adminKeyAlias` |
| `backend/src/routes/agent-settings.ts` | Add generate-key, register-caller endpoints |
| `frontend/src/pages/agents/AgentSettings.tsx` | Key generation UI, admin alias selector |

### Done When

- User can generate a new key alias from the UI
- In local mode: new alias is immediately registered and usable
- In remote mode: new alias is registered on the remote server via admin API
- Connection management works in remote mode (enable/disable, set secrets via admin API)
- Admin key alias is configurable in settings

---

## Stage 4: Setup Wizard + Polish

### Problem

New users have no keys, no config, and no understanding of the system. The settings page assumes everything is already initialized.

### Prerequisite

mcp-secure-proxy Stage 3 (bootstrap function) must be complete.

### Solution

#### 4a. First-run detection

Add to settings API:
```
GET /api/agent-settings/setup/status → { isComplete, hasKeys, hasConfig, mode }
```

The frontend checks this on load and redirects to the wizard if setup is incomplete.

#### 4b. Setup wizard

New file: `frontend/src/pages/agents/SetupWizard.tsx`

Three steps:

**Step 1: Choose Mode**
```
○ Local (Recommended for single-machine setups)
  Runs in-process. All secrets stay on this machine.

○ Remote (For team/distributed setups)
  Connect to an external MCP secure proxy server.
```

**Step 2: Initialize**
```
Config Directory: [~/.mcp-secure-proxy/] [Browse]

We'll create:
  ✓ Default identity keypair
  ✓ Configuration files

[Initialize]
```

Calls `bootstrap()` from mcp-secure-proxy (via a backend API endpoint).

**Step 3: Enable Connections (Optional)**
```
Select services you'd like to connect:
  ☐ GitHub
  ☐ Discord Bot
  ☐ Slack
  ... (all templates)

You can always add more later.

[Finish Setup]
```

#### 4c. Backend setup API

```
POST /api/agent-settings/setup/initialize → { configDir, mode } → runs bootstrap + saves settings
GET  /api/agent-settings/setup/status     → { isComplete, hasKeys, hasConfig }
```

### Files to Change

| File | Change |
|---|---|
| `frontend/src/pages/agents/SetupWizard.tsx` | **New.** 3-step setup wizard |
| `backend/src/routes/agent-settings.ts` | Add setup/initialize and setup/status endpoints |
| `frontend/src/api.ts` | Add setup API functions |
| `frontend/src/App.tsx` (or router) | Redirect to wizard when setup incomplete |

### Done When

- New user opening the app for the first time sees the setup wizard
- Completing the wizard creates config dir, generates keys, saves settings
- User lands on the connections page and can immediately enable their first connection
- Returning users skip the wizard entirely

---

## Security Considerations (All Stages)

1. **Secret display** — UI NEVER shows secret values after they're set. Only "Set ✓" / "Not set".
2. **API key transmission** — Browser → backend (localhost or HTTPS) → .env write (local) or encrypted channel (remote). Never stored in browser.
3. **Admin key protection** — Remote mode only. Its use is limited to settings/provisioning operations.
4. **Local mode .env** — Written with 0600 permissions.
5. **No secret logging** — Log secret names and operations only, never values.
