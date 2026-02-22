# Plan: Packaging mcp-secure-proxy with claude-code-ui

## Overview

Integrate mcp-secure-proxy as a bundled dependency of claude-code-ui, enabling:
1. **Local mode** — remote server runs from within claude-code-ui on the same machine
2. **Remote mode** — connect to an external mcp-secure-proxy remote server
3. **Settings UI** — toggle local/remote, configure server URL, manage connections & keys
4. **Connection management** — users can enable services (Discord, GitHub, etc.) and provide API keys through the UI, which get provisioned to the remote server via an authenticated admin channel

---

## Part 1: Packaging mcp-secure-proxy

### Approach: Git Submodule + Workspace Integration

Add mcp-secure-proxy as a git submodule under `packages/mcp-secure-proxy/`.

**Why submodule over npm package:**
- Both repos are actively developed in the same org
- Need access to source (not just dist) for the remote server's `createApp()` export
- Keeps repos independently deployable while allowing tight integration
- Can pin to specific commits during development

**Why not copy/vendor:**
- mcp-secure-proxy is large (~23 connection templates, ingestor system, crypto, CLI)
- Independent test suite and build pipeline should remain intact
- Updates should be atomic git operations, not manual file copies

### Implementation Steps

1. **Add submodule:**
   ```bash
   git submodule add ../mcp-secure-proxy packages/mcp-secure-proxy
   ```

2. **Add to npm workspaces** in root `package.json`:
   ```json
   "workspaces": ["shared", "backend", "frontend", "packages/mcp-secure-proxy"]
   ```

3. **Backend dependency** — add workspace reference in `backend/package.json`:
   ```json
   "dependencies": {
     "mcp-secure-proxy": "*"
   }
   ```

4. **Build integration** — update root build script to build mcp-secure-proxy first:
   ```json
   "build": "npm run build:proxy && npm run build:shared && npm run build:backend && npm run build:frontend",
   "build:proxy": "npm -w mcp-secure-proxy run build"
   ```

5. **Replace vendored proxy-client.ts** — once mcp-secure-proxy is a workspace dep, import directly:
   ```typescript
   // Before (vendored):
   import { ProxyClient } from "./proxy-client.js";

   // After (workspace):
   import { HandshakeInitiator, EncryptedChannel } from "mcp-secure-proxy/shared/protocol";
   import { loadKeyBundle, loadPublicKeys } from "mcp-secure-proxy/shared/crypto";
   ```

   This requires mcp-secure-proxy to add proper `exports` to its package.json (see mcp-secure-proxy plan).

---

## Part 2: Local Mode — Embedded Remote Server

### Concept

When in local mode, claude-code-ui manages the mcp-secure-proxy remote server lifecycle. The remote server runs as either:
- **Option A (recommended): Child process** — spawned and monitored by claude-code-ui's backend
- **Option B: Embedded Express sub-app** — mounted on claude-code-ui's Express app at a sub-path

Option A is recommended because:
- Process isolation (crash in remote server doesn't take down UI)
- Clean separation of ports (no middleware conflicts)
- Can reuse existing PM2 config for production
- Remote server can be restarted independently

### New Settings: `AgentSettings` Type Extension

```typescript
// shared/types/agentSettings.ts
export interface AgentSettings {
  /** Absolute path to .mcp-secure-proxy/ directory containing keys and config */
  mcpConfigDir?: string;

  /** Proxy server mode: 'local' runs embedded server, 'remote' connects to external */
  proxyMode?: 'local' | 'remote';

  /** URL of the remote MCP secure proxy server (used in 'remote' mode) */
  remoteServerUrl?: string;

  /** Port for the local embedded server (used in 'local' mode, default: 9999) */
  localServerPort?: number;

  /** Auto-start local server on app startup (default: true) */
  localServerAutoStart?: boolean;

  /** Admin key alias — the key used to provision new callers/connections on the remote server.
   *  Must be an alias already registered as a caller on the target server. */
  adminKeyAlias?: string;
}
```

### Local Server Manager Service

New file: `backend/src/services/local-server-manager.ts`

Responsibilities:
- Start/stop the mcp-secure-proxy remote server as a child process
- Monitor health via `/health` endpoint polling
- Restart on crash (with backoff)
- Pipe stdout/stderr to claude-code-ui's logger
- Manage `remote.config.json` file on behalf of the UI (for connection/caller management)

```typescript
// Pseudocode for the local server manager
export class LocalServerManager {
  private process: ChildProcess | null = null;
  private configPath: string;  // path to remote.config.json

  constructor(private mcpConfigDir: string, private port: number) {
    this.configPath = join(mcpConfigDir, 'remote.config.json');
  }

  async start(): Promise<void> {
    // 1. Ensure remote.config.json exists (create default if not)
    // 2. Ensure remote server keys exist (generate if not)
    // 3. Spawn: node packages/mcp-secure-proxy/dist/remote/server.js
    //    with env: MCP_CONFIG_DIR=this.mcpConfigDir
    // 4. Wait for /health to respond
  }

  async stop(): Promise<void> { /* SIGTERM with timeout */ }

  isRunning(): boolean { /* check process alive + /health */ }

  /** Hot-reload config: update remote.config.json and restart server */
  async reloadConfig(newConfig: RemoteServerConfig): Promise<void> {}
}
```

### Integration with Backend Startup

In `backend/src/index.ts`:

```typescript
import { LocalServerManager } from "./services/local-server-manager.js";

// At startup:
const settings = getAgentSettings();
if (settings.proxyMode === 'local' && settings.localServerAutoStart !== false) {
  const manager = new LocalServerManager(
    settings.mcpConfigDir!,
    settings.localServerPort ?? 9999
  );
  await manager.start();
}
```

### Proxy Singleton Update

Update `backend/src/services/proxy-singleton.ts` to read the remote URL from settings:

```typescript
function getRemoteUrl(): string {
  const settings = getAgentSettings();
  if (settings.proxyMode === 'local') {
    return `http://127.0.0.1:${settings.localServerPort ?? 9999}`;
  }
  return settings.remoteServerUrl || process.env.EVENT_WATCHER_REMOTE_URL || "http://127.0.0.1:9999";
}
```

---

## Part 3: Settings UI Enhancements

### Current State
- `AgentSettings.tsx` only has a text field for `mcpConfigDir` and displays discovered key aliases

### New Settings Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  MCP Secure Proxy Settings                              │
│                                                         │
│  ┌─── Server Mode ────────────────────────────────────┐ │
│  │  ○ Local (runs on this machine)                    │ │
│  │    Port: [9999]  Auto-start: [✓]                   │ │
│  │    Status: ● Running (3 active sessions)           │ │
│  │    [Restart Server]  [Stop Server]                 │ │
│  │                                                    │ │
│  │  ○ Remote (connect to external server)             │ │
│  │    Server URL: [https://proxy.example.com:9999]    │ │
│  │    Status: ● Connected                             │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─── Keys Directory ────────────────────────────────┐  │
│  │  Config Directory: [/path/to/.mcp-secure-proxy/]  │  │
│  │  [Browse]                                          │  │
│  │                                                    │  │
│  │  Discovered Aliases:                               │  │
│  │    ✓ default  (signing ✓, exchange ✓)             │  │
│  │    ✓ agent-1  (signing ✓, exchange ✓)             │  │
│  │    [+ Generate New Key Alias]                     │  │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─── Admin Key ─────────────────────────────────────┐  │
│  │  Admin Alias: [default ▼] (for provisioning)      │  │
│  │  This key is used to add new callers/connections   │  │
│  │  to the remote server.                             │  │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  [Save Settings]                                        │
└─────────────────────────────────────────────────────────┘
```

### New Settings API Endpoints

Add to `backend/src/routes/agent-settings.ts`:

```
GET  /api/agent-settings/server-status    → { running, port, activeSessions, uptime }
POST /api/agent-settings/server/start     → Start local server
POST /api/agent-settings/server/stop      → Stop local server
POST /api/agent-settings/server/restart   → Restart local server
POST /api/agent-settings/generate-key     → { alias } → Generate new keypair
```

### Key Generation from UI

When user clicks "+ Generate New Key Alias":
1. Prompt for alias name (text input)
2. Call `POST /api/agent-settings/generate-key` with `{ alias: "my-alias" }`
3. Backend calls mcp-secure-proxy's `generateKeyBundle()` + `saveKeyBundle()` functions
4. Copy public keys to `keys/peers/{alias}/` on remote server side (for local mode, this is automatic)
5. Update `remote.config.json` to add the new caller
6. Reload remote server config

---

## Part 4: Connection Management UI

### Concept

Users need to:
1. Browse available connection templates (23 built-in: Discord, GitHub, Stripe, etc.)
2. Enable/disable connections for a specific caller (key alias)
3. Provide required API keys/secrets for each connection
4. Have those secrets securely delivered to the remote server

### New Page: Connections Manager

New file: `frontend/src/pages/agents/ConnectionsManager.tsx`

Accessed from Agent Settings or as a top-level settings page.

```
┌────────────────────────────────────────────────────────────┐
│  Connection Manager                                        │
│                                                            │
│  Managing connections for alias: [default ▼]               │
│                                                            │
│  ┌─── Available Connections ──────────────────────────────┐│
│  │                                                        ││
│  │  ┌──────────────────────────────────────────────────┐ ││
│  │  │ 🐙 GitHub API                    [Enabled ✓]     │ ││
│  │  │ Access GitHub repos, issues, PRs                 │ ││
│  │  │ Required: GITHUB_TOKEN            [Set ✓]        │ ││
│  │  │ Optional: GITHUB_WEBHOOK_SECRET   [Not set]      │ ││
│  │  │ [Configure] [Docs ↗]                             │ ││
│  │  └──────────────────────────────────────────────────┘ ││
│  │                                                        ││
│  │  ┌──────────────────────────────────────────────────┐ ││
│  │  │ 🤖 Discord Bot                   [Disabled]      │ ││
│  │  │ Real-time Discord Gateway events                 │ ││
│  │  │ Required: DISCORD_BOT_TOKEN       [Not set]      │ ││
│  │  │ [Configure] [Docs ↗]                             │ ││
│  │  └──────────────────────────────────────────────────┘ ││
│  │                                                        ││
│  │  ... (23 templates + custom connectors)                ││
│  └────────────────────────────────────────────────────────┘│
│                                                            │
│  [+ Add Custom Connector]                                  │
└────────────────────────────────────────────────────────────┘
```

### Configure Modal (per connection)

When user clicks "Configure" on a connection:

```
┌─────────────────────────────────────────────┐
│  Configure: Discord Bot                      │
│                                              │
│  Connection Alias: discord-bot               │
│  Enabled: [✓]                                │
│                                              │
│  ── Required Secrets ──                      │
│  DISCORD_BOT_TOKEN: [••••••••••] [👁] [Set]  │
│                                              │
│  ── Ingestor Settings ──                     │
│  Type: WebSocket (Discord Gateway)           │
│  Intents: [3276799]                          │
│  Guild Filter: [guild-id-1, guild-id-2]      │
│  Channel Filter: [channel-id-1]              │
│  Event Filter: [MESSAGE_CREATE, ...]          │
│  Buffer Size: [200]                          │
│                                              │
│  [Save]  [Cancel]                            │
└─────────────────────────────────────────────┘
```

### Backend: Connection Management API

New file: `backend/src/routes/connections.ts`

```
GET  /api/connections/templates              → List all available connection templates
GET  /api/connections/templates/:alias       → Get single template details
GET  /api/connections/:callerAlias           → Get caller's enabled connections + secret status
POST /api/connections/:callerAlias/enable    → { connectionAlias } → Enable connection for caller
POST /api/connections/:callerAlias/disable   → { connectionAlias } → Disable connection for caller
POST /api/connections/:callerAlias/secrets   → { connectionAlias, secrets: { KEY: "value" } }
GET  /api/connections/:callerAlias/secret-status → Which secrets are set (never returns values!)
POST /api/connections/custom                 → Create custom connector definition
```

### How Secrets Get to the Remote Server

**Two approaches depending on mode:**

#### Local Mode (direct file access)

When running locally, claude-code-ui has direct filesystem access to the mcp-secure-proxy config:

1. User provides `DISCORD_BOT_TOKEN=abc123` via UI
2. Backend writes/updates `.mcp-secure-proxy/.env` file (or a separate `secrets.env`)
3. Backend updates `remote.config.json` to add/modify the caller's connections list
4. Backend triggers server reload (SIGHUP or restart)

Implementation in `backend/src/services/connection-manager.ts`:

```typescript
export class ConnectionManager {
  constructor(private mcpConfigDir: string) {}

  /** Load all built-in connection templates */
  getTemplates(): ConnectionTemplate[] {
    // Import from mcp-secure-proxy/src/connections/*.json
  }

  /** Enable a connection for a caller */
  async enableConnection(callerAlias: string, connectionAlias: string): Promise<void> {
    // 1. Load remote.config.json
    // 2. Add connectionAlias to callers[callerAlias].connections
    // 3. Save remote.config.json
    // 4. Signal server reload
  }

  /** Set secrets for a connection */
  async setSecrets(callerAlias: string, connectionAlias: string, secrets: Record<string, string>): Promise<void> {
    // 1. Load .env file
    // 2. For per-caller isolation: save as CALLALIAS_SECRETNAME=value
    // 3. Update caller's env mapping: { "SECRET_NAME": "${CALLALIAS_SECRETNAME}" }
    // 4. Save .env and remote.config.json
    // 5. Signal server reload
  }

  /** Check which secrets are set (without revealing values) */
  getSecretStatus(callerAlias: string, connectionAlias: string): Record<string, boolean> {
    // Read .env, check which required keys have values
  }
}
```

#### Remote Mode (via Admin API)

When connecting to an external remote server, we need an authenticated admin channel.

1. User provides `DISCORD_BOT_TOKEN=abc123` via UI
2. Backend uses the `adminKeyAlias` to establish an encrypted session with the remote server
3. Backend calls a new `admin_set_secrets` tool on the remote server
4. Remote server stores the secrets in its own .env or secrets store

This requires a new **Admin API** on the remote server (see mcp-secure-proxy plan).

The flow:
```
UI → claude-code-ui backend → ProxyClient(adminKeyAlias) → secure_request →
  remote server admin endpoint → writes to .env / config → reloads
```

New tool calls via ProxyClient:
```typescript
// In backend, using the admin key alias's ProxyClient:
const adminClient = getProxyClient(settings.adminKeyAlias);

// Set secrets for a caller
await adminClient.callTool("admin_set_secrets", {
  callerAlias: "agent-1",
  connectionAlias: "discord-bot",
  secrets: { DISCORD_BOT_TOKEN: "abc123" }
});

// Enable connection for a caller
await adminClient.callTool("admin_enable_connection", {
  callerAlias: "agent-1",
  connectionAlias: "discord-bot"
});

// Register a new caller
await adminClient.callTool("admin_register_caller", {
  callerAlias: "new-agent",
  name: "New Agent",
  signingPubPem: "...",
  exchangePubPem: "...",
  connections: ["github", "discord-bot"]
});
```

---

## Part 5: Key Provisioning — Adding New Aliases to Remote Server

### The Problem

To authenticate with the remote server, a caller needs:
1. Their own keypair (local) — `keys/local/{alias}/`
2. Their public keys registered on the remote server — `keys/peers/{alias}/`
3. A caller entry in `remote.config.json`

For local mode this is straightforward (direct file access). For remote mode, we need an already-provisioned "admin" key to register new callers.

### Flow: Provisioning a New Key Alias

```
┌─────────────────────────────────────────────────────────────┐
│  1. User clicks "+ Generate New Key Alias" in Settings UI   │
│  2. User enters alias name (e.g., "agent-2")                │
│  3. Backend generates Ed25519 + X25519 keypair locally       │
│     → saves to keys/local/agent-2/                          │
│  4. Backend reads the public keys (signing.pub.pem,          │
│     exchange.pub.pem) from the newly generated alias         │
│                                                              │
│  LOCAL MODE:                                                 │
│  5a. Copy public keys to keys/peers/agent-2/ in config dir  │
│  6a. Add caller entry to remote.config.json                  │
│  7a. Reload remote server                                    │
│                                                              │
│  REMOTE MODE:                                                │
│  5b. Use adminKeyAlias's ProxyClient to call                 │
│      admin_register_caller on remote server                  │
│  6b. Remote server stores public keys and adds caller entry  │
│  7b. Remote server reloads config                            │
│                                                              │
│  8. User can now assign this alias to agents                 │
└─────────────────────────────────────────────────────────────┘
```

### Backend Implementation

Add to `backend/src/services/key-manager.ts`:

```typescript
import { generateKeyBundle, saveKeyBundle, extractPublicKeys } from "mcp-secure-proxy/shared/crypto";

export class KeyManager {
  constructor(private mcpConfigDir: string) {}

  /** Generate a new local keypair for the given alias */
  async generateLocalKeys(alias: string): Promise<{ fingerprint: string }> {
    const targetDir = join(this.mcpConfigDir, "keys", "local", alias);
    if (existsSync(targetDir)) throw new Error(`Alias "${alias}" already exists`);

    const bundle = generateKeyBundle();
    saveKeyBundle(bundle, targetDir);
    const fp = fingerprint(extractPublicKeys(bundle));
    return { fingerprint: fp };
  }

  /** Register the alias as a caller on the remote server */
  async registerOnRemote(alias: string, connections: string[]): Promise<void> {
    const settings = getAgentSettings();

    if (settings.proxyMode === 'local') {
      // Direct file manipulation
      await this.registerLocalCaller(alias, connections);
    } else {
      // Via admin API
      await this.registerRemoteCaller(alias, connections);
    }
  }

  private async registerLocalCaller(alias: string, connections: string[]): Promise<void> {
    // 1. Copy public keys to peers directory
    const srcDir = join(this.mcpConfigDir, "keys", "local", alias);
    const dstDir = join(this.mcpConfigDir, "keys", "peers", alias);
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(join(srcDir, "signing.pub.pem"), join(dstDir, "signing.pub.pem"));
    copyFileSync(join(srcDir, "exchange.pub.pem"), join(dstDir, "exchange.pub.pem"));

    // 2. Add caller entry to remote.config.json
    const config = loadRemoteConfig();
    config.callers[alias] = {
      peerKeyDir: dstDir,
      connections,
      env: {}
    };
    saveRemoteConfig(config);

    // 3. Reload server
    await localServerManager.reloadConfig(config);
  }

  private async registerRemoteCaller(alias: string, connections: string[]): Promise<void> {
    const adminClient = getProxyClient(settings.adminKeyAlias!);
    const pubKeys = readPublicKeys(alias);

    await adminClient.callTool("admin_register_caller", {
      callerAlias: alias,
      signingPubPem: pubKeys.signing,
      exchangePubPem: pubKeys.exchange,
      connections
    });
  }
}
```

---

## Part 6: First-Run Setup Flow

### Problem

New users have no keys, no config, and no understanding of the system. We need a guided setup.

### Setup Wizard (shown when mcpConfigDir is not set or has no keys)

```
┌─────────────────────────────────────────────────────────┐
│  MCP Secure Proxy Setup                                  │
│                                                          │
│  Step 1 of 3: Choose Mode                                │
│                                                          │
│  How would you like to run the secure proxy?             │
│                                                          │
│  ○ Local (Recommended for single-machine setups)         │
│    The proxy server runs on this machine. All secrets     │
│    stay local. Perfect for personal use.                  │
│                                                          │
│  ○ Remote (For team/distributed setups)                   │
│    Connect to an external MCP secure proxy server.        │
│    Requires server URL and pre-provisioned keys.          │
│                                                          │
│  [Next →]                                                │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Step 2 of 3: Initialize Keys                            │
│                                                          │
│  Config Directory: [~/.mcp-secure-proxy/] [Browse]       │
│                                                          │
│  We'll create:                                           │
│  ✓ Remote server keypair (for the local proxy server)    │
│  ✓ Default client keypair (for your first agent)         │
│  ✓ Default configuration files                           │
│                                                          │
│  [Initialize →]                                          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Step 3 of 3: Enable Connections (Optional)              │
│                                                          │
│  Select services you'd like to connect:                  │
│                                                          │
│  ☐ GitHub — repos, issues, PRs                           │
│  ☐ Discord Bot — real-time Discord events                │
│  ☐ Slack — channels, messages                            │
│  ☐ OpenAI — chat completions, embeddings                 │
│  ☐ Anthropic — Claude API                                │
│  ... (show all 23)                                       │
│                                                          │
│  You can always add more connections later.               │
│                                                          │
│  [Finish Setup]                                          │
└─────────────────────────────────────────────────────────┘
```

### Backend: Setup API

```
POST /api/agent-settings/setup/initialize  → Create config dir, generate keys, write configs
POST /api/agent-settings/setup/status      → Check if setup is complete
```

---

## Part 7: File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `backend/src/services/local-server-manager.ts` | Child process management for local proxy server |
| `backend/src/services/connection-manager.ts` | Connection template loading, enable/disable, secret management |
| `backend/src/services/key-manager.ts` | Key generation, provisioning, registration |
| `backend/src/routes/connections.ts` | REST API for connection management |
| `frontend/src/pages/agents/ConnectionsManager.tsx` | Connection management UI page |
| `frontend/src/pages/agents/SetupWizard.tsx` | First-run setup wizard |
| `frontend/src/components/ConnectionCard.tsx` | Individual connection display/config component |
| `frontend/src/components/ConfigureConnectionModal.tsx` | Secret entry + ingestor config modal |

### Modified Files

| File | Changes |
|------|---------|
| `package.json` | Add `packages/mcp-secure-proxy` to workspaces |
| `backend/package.json` | Add `mcp-secure-proxy` workspace dependency |
| `shared/types/agentSettings.ts` | Extend `AgentSettings` with proxy mode, URL, port, admin alias |
| `backend/src/services/agent-settings.ts` | Handle new settings fields, setup initialization |
| `backend/src/services/proxy-singleton.ts` | Read remote URL from settings (not just env var) |
| `backend/src/routes/agent-settings.ts` | New endpoints for server control, key generation, setup |
| `backend/src/index.ts` | Auto-start local server on boot, mount connections router |
| `frontend/src/api.ts` | New API functions for connections, server control, setup |
| `frontend/src/pages/agents/AgentSettings.tsx` | Expand with server mode toggle, status, server controls |
| `backend/src/services/proxy-client.ts` | Eventually replace with import from mcp-secure-proxy package |

### Deleted/Deprecated Files (after migration)

| File | Reason |
|------|--------|
| `backend/src/services/proxy-client.ts` | Replace with import from mcp-secure-proxy workspace |

---

## Part 8: Migration Path

### Phase 1: Submodule + Local Mode
1. Add git submodule
2. Add workspace integration
3. Build `LocalServerManager`
4. Extend settings with proxy mode toggle
5. Update settings UI with server mode section

### Phase 2: Connection Management
1. Build `ConnectionManager` service
2. Build connection templates API
3. Build connections UI page
4. Implement local-mode secret writing (direct .env file manipulation)

### Phase 3: Remote Mode + Admin API
1. Implement admin tool handlers on mcp-secure-proxy (see other plan)
2. Build `KeyManager` service
3. Implement remote-mode provisioning via admin API
4. Build key generation UI
5. Build setup wizard

### Phase 4: Replace Vendored Code
1. Switch imports from vendored `proxy-client.ts` to mcp-secure-proxy workspace
2. Add proper `exports` map to mcp-secure-proxy's package.json
3. Remove vendored proxy-client.ts
4. Update all import paths

---

## Security Considerations

1. **Secret Display**: UI should NEVER show secret values after they're set. Only show "Set ✓" / "Not set" status.
2. **API Key Transmission**: Secrets travel from browser → claude-code-ui backend (over HTTPS in prod) → encrypted channel to remote server. Never stored in browser.
3. **Admin Key Protection**: The admin key alias has elevated permissions. Its use should be clearly indicated and limited to settings/provisioning operations.
4. **Local Mode .env**: When writing secrets to .env files in local mode, ensure file permissions are 0600.
5. **No Secret Logging**: Never log secret values. Log secret names and operations only.
