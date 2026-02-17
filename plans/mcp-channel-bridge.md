# Plan: mcp-channel-bridge

An MCP server that bridges messaging platforms (Telegram, Discord, Slack, etc.) into Claude Code as tools, enabling the agent to receive and send messages across channels.

---

## Why This Matters

Today, claude-code-ui is a solo experience: you talk to Claude through a web interface, and it talks back. OpenClaw's most transformative feature isn't any single channel -- it's that the agent becomes **reachable**. People message it on Telegram, it responds on Slack, it alerts you on Discord. The agent stops being a tool you visit and becomes a presence that lives alongside your communication.

Without a channel bridge:

- **No async communication.** You can't tell the agent "message me on Telegram when the deploy finishes." It has no way to reach you outside the UI.
- **No collaborative AI.** Teammates can't interact with the agent in shared Slack channels or Discord servers. The agent is locked to whoever has the UI open.
- **No mobile reach.** When you're away from your desk, the agent can't notify you of anything. OpenClaw users get WhatsApp/Telegram pings from their agent while walking the dog.
- **No multi-surface workflows.** Things like "monitor this channel and summarize activity" or "forward important Slack DMs to my Telegram" are impossible.

The channel bridge closes the largest functional gap between the modular stack and OpenClaw. It turns the agent from something you use into something that works alongside you.

---

## Design Principles

1. **MCP-native.** Exposed as standard MCP tools so any Claude Code session can use it. No custom protocol.
2. **Secure by default.** Secrets (bot tokens) live on the remote server via mcp-secure-proxy. The local MCP client never sees credentials.
3. **Modular channels.** Each channel is an independent adapter. Ship Telegram first, add Discord later. No monolith.
4. **Stateless proxy, stateful server.** The MCP proxy is stateless. The remote server holds channel connections, message queues, and session state.
5. **Inbox model.** Inbound messages queue up and are pulled by the agent via a tool call, not pushed. This fits Claude Code's request-response model without requiring a persistent WebSocket.

---

## Architecture

```
                                          REMOTE SERVER (holds secrets + connections)
                                         ┌─────────────────────────────────────────┐
┌─────────────┐   stdio    ┌──────────┐  │  ┌──────────────┐   ┌───────────────┐  │
│ Claude Code │◄──────────►│ MCP      │◄─E2EE─►│ Channel    │──►│ Telegram Bot │  │
│             │  MCP tools │ Proxy    │  │  │  Router      │   │ Discord Bot  │  │
│             │            │ (local)  │  │  │              │   │ Slack Bot    │  │
└─────────────┘            └──────────┘  │  │              │   │ ...          │  │
                                         │  └──────┬───────┘   └───────────────┘  │
                                         │         │                               │
                                         │  ┌──────▼───────┐                       │
                                         │  │ Message Queue │ (SQLite)             │
                                         │  │ + Session Map │                       │
                                         │  └──────────────┘                       │
                                         └─────────────────────────────────────────┘
```

The remote server is a long-running process that maintains bot connections. The MCP proxy translates tool calls into encrypted requests to it.

---

## MCP Tools Exposed

### `channels_list`

List configured channels and their status (connected, disconnected, error).

```typescript
// No parameters
// Returns:
{
  channels: [
    { id: "telegram", name: "Telegram", status: "connected", accountId: "default" },
    { id: "discord", name: "Discord", status: "connected", accountId: "default" },
    { id: "slack", name: "Slack", status: "disconnected", accountId: "work" }
  ]
}
```

### `channels_inbox`

Pull unread messages from the inbox. Agent calls this to check for new messages.

```typescript
// Parameters:
{
  channel?: string,        // Filter by channel (optional)
  limit?: number,          // Max messages to return (default 20)
  since?: string,          // ISO timestamp, only messages after this
  markRead?: boolean       // Mark returned messages as read (default true)
}

// Returns:
{
  messages: [
    {
      id: "msg_abc123",
      channel: "telegram",
      senderId: "user:44821",
      senderName: "Alice",
      chatType: "dm",                 // "dm" | "group" | "channel"
      groupId?: "group:engineers",    // present if chatType != "dm"
      groupName?: "Engineers",
      text: "Hey, can you check the staging deploy?",
      media?: [{ type: "image", url: "/media/abc.png", caption: "screenshot" }],
      replyToId?: "msg_xyz",
      timestamp: "2026-02-16T14:32:00Z"
    }
  ],
  unreadCount: 3
}
```

### `channels_send`

Send a message to a user or group on any connected channel.

```typescript
// Parameters:
{
  channel: string,          // "telegram" | "discord" | "slack"
  to: string,              // User or group identifier
  text: string,            // Message content (markdown)
  replyToId?: string,      // Reply to a specific message
  media?: {                // Optional attachment
    url: string,
    type: "image" | "file" | "audio" | "video"
  }
}

// Returns:
{ messageId: "msg_def456", timestamp: "2026-02-16T14:33:00Z" }
```

### `channels_contacts`

Look up users and groups across channels.

```typescript
// Parameters:
{
  channel: string,
  query?: string,          // Search by name
  type?: "user" | "group"
}

// Returns:
{
  contacts: [
    { id: "user:44821", name: "Alice", channel: "telegram", type: "user" },
    { id: "group:engineers", name: "Engineers", channel: "slack", type: "group" }
  ]
}
```

### `channels_subscribe`

Register interest in messages matching a pattern (for cron-like monitoring when paired with a scheduler).

```typescript
// Parameters:
{
  channel: string,
  filter?: {
    chatType?: "dm" | "group",
    senderId?: string,
    groupId?: string,
    textPattern?: string     // Regex pattern to match
  },
  label: string             // Human-readable subscription name
}
```

---

## Channel Adapter Interface

Each channel implements a common adapter, inspired by OpenClaw's `ChannelPlugin` but drastically simplified for the MCP context:

```typescript
interface ChannelAdapter {
  id: string;                           // "telegram", "discord", "slack"
  name: string;                         // Human-readable name

  // Lifecycle
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  status(): ChannelStatus;

  // Inbound (called by the adapter, pushes to queue)
  onMessage(handler: (msg: InboundMessage) => void): void;

  // Outbound
  sendText(to: string, text: string, opts?: SendOptions): Promise<SentMessage>;
  sendMedia(to: string, media: MediaPayload, opts?: SendOptions): Promise<SentMessage>;

  // Directory
  lookupContacts(query?: string): Promise<Contact[]>;

  // Text handling
  maxTextLength: number;
  formatMarkdown(text: string): string;  // Convert to channel-native format
}
```

### Channel-Specific Notes

| Channel | Auth | Max Text | Unique Considerations |
|---------|------|----------|----------------------|
| **Telegram** | Bot token via BotFather | 4096 chars | Markdown v2 formatting, topics in supergroups, polling vs webhook |
| **Discord** | Bot token from Dev Portal | 2000 chars | Guild/channel hierarchy, rich embeds, slash commands |
| **Slack** | Bot + App tokens | 4000 chars | Socket Mode preferred, threaded replies, Block Kit formatting |

---

## Security Model

### Secrets Management

Bot tokens are **the most sensitive part** of this system. A leaked Telegram bot token gives full control of the bot. The mcp-secure-proxy architecture is ideal here:

```
Local (no secrets)                    Remote (has secrets)
─────────────────                     ────────────────────
MCP proxy knows:                      Remote server knows:
  - Remote server URL                   - Telegram bot token
  - Its own Ed25519 keys                - Discord bot token
  - Session encryption keys             - Slack bot + app tokens
                                        - Allowed sender lists
```

- Bot tokens stored as env vars on the remote server, referenced via `${TELEGRAM_BOT_TOKEN}` placeholders in config.
- The MCP proxy never sees or handles bot tokens.
- Channel connections are established server-side. The proxy only sends/receives encrypted message payloads.

### Sender Authorization

Adopt OpenClaw's pairing model, simplified:

1. **Default: allowlist mode.** Config specifies `allowFrom: ["user:12345", "user:67890"]` per channel.
2. **Pairing mode (optional).** Unknown senders receive a short code. Approve via `channels_pairing_approve` tool or CLI.
3. **Group gating.** Groups require bot mention by default. Configurable per group.

### Message Sanitization

- Strip or escape any content that could be interpreted as tool instructions (prompt injection mitigation).
- Media size limits per channel (configurable, defaults match platform limits).
- Rate limiting on outbound messages to prevent bot abuse.

---

## Message Queue & Storage

SQLite database on the remote server:

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  chat_type TEXT NOT NULL,           -- 'dm', 'group', 'channel'
  group_id TEXT,
  group_name TEXT,
  text TEXT,
  media_json TEXT,                   -- JSON array of media objects
  reply_to_id TEXT,
  timestamp TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  session_id TEXT                    -- Ties to MCP proxy session
);

CREATE INDEX idx_messages_unread ON messages(read, timestamp);
CREATE INDEX idx_messages_channel ON messages(channel, timestamp);
```

- Messages older than 7 days auto-pruned (configurable).
- Queue depth limit per sender (prevent flooding).
- Read tracking per MCP session (different Claude sessions see different read states).

---

## Configuration

### Remote Server Config (`channel-bridge.config.json`)

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "accounts": {
        "default": {
          "mode": "polling",
          "allowFrom": ["user:44821", "user:99102"],
          "dmPolicy": "allowlist",
          "groups": {
            "*": { "requireMention": true }
          }
        }
      }
    },
    "discord": {
      "enabled": true,
      "accounts": {
        "default": {
          "allowFrom": ["user:301928374"],
          "guilds": {
            "123456789": {
              "channels": {
                "987654321": { "requireMention": false }
              }
            }
          }
        }
      }
    }
  },
  "queue": {
    "maxAge": "7d",
    "maxPerSender": 100
  },
  "secrets": {
    "TELEGRAM_BOT_TOKEN": "${TELEGRAM_BOT_TOKEN}",
    "DISCORD_BOT_TOKEN": "${DISCORD_BOT_TOKEN}"
  }
}
```

---

## Implementation Phases

### Phase 1: Core + Telegram (MVP)

**Goal:** Agent can receive and send Telegram DMs.

1. Remote server scaffolding (Express + SQLite + E2EE session handler)
2. Message queue (insert, poll, mark-read, prune)
3. Telegram adapter (Grammy, polling mode, text only)
4. MCP tools: `channels_list`, `channels_inbox`, `channels_send`
5. MCP proxy integration (reuse mcp-secure-proxy patterns)
6. Allowlist-based sender auth
7. Basic tests + manual QA

**Estimated effort:** 2-3 weeks

### Phase 2: Discord + Slack

**Goal:** Add two more channels, proving the adapter model works.

1. Discord adapter (discord.js, gateway mode)
2. Slack adapter (Bolt, socket mode)
3. `channels_contacts` tool
4. Media support (images inbound + outbound)
5. Group/channel message support with mention gating
6. Channel-specific markdown formatting

**Estimated effort:** 2 weeks

### Phase 3: Pairing + Subscriptions

**Goal:** Let new users pair with the bot, let the agent subscribe to message patterns.

1. Pairing flow (code generation, approval tool, allowlist persistence)
2. `channels_subscribe` tool
3. Webhook endpoint for external triggers (GitHub → agent notification)
4. Thread/reply-chain support per channel
5. Message actions (reactions, pins) where supported

**Estimated effort:** 2 weeks

### Phase 4: Polish + Integration

**Goal:** Production-ready with claude-code-ui integration.

1. UI panel in claude-code-ui showing connected channels and unread count
2. Auto-inbox-check: agent periodically checks inbox during long sessions
3. Cross-channel identity linking (same person on Telegram and Slack)
4. Audit logging for all message operations
5. Connection template for mcp-secure-proxy (`channel-bridge.json`)
6. Documentation, examples, deployment guide

**Estimated effort:** 2 weeks

---

## Integration with mcp-secure-proxy

The channel bridge runs as a **separate remote server process** but reuses the same encryption and auth infrastructure:

```
mcp-secure-proxy remote server  (port 9999)  ← API proxy (GitHub, Stripe, etc.)
mcp-channel-bridge remote server (port 9998)  ← Channel bridge (Telegram, Discord, etc.)
```

Both share:
- Same keypair directory structure
- Same handshake protocol (Noise NK)
- Same caller authorization model
- Same E2EE message format

The MCP proxy can either:
- **Option A:** Register as a second MCP server in Claude Code (separate stdio process)
- **Option B:** Be added as a route on the existing mcp-secure-proxy remote server (single process, single handshake)

Option B is cleaner long-term but Option A is simpler to ship first.

---

## What This Doesn't Do (And Why)

| Intentionally excluded | Reason |
|----------------------|--------|
| Multi-model support | Agent model is Claude Code's concern, not the bridge's |
| Voice/TTS | Separate concern, separate MCP server (see future plans) |
| Canvas/A2UI | UI concern, belongs in claude-code-ui |
| Session orchestration | The bridge delivers messages; session management is the agent's job |
| Full OpenClaw parity | Goal is the 20% of features that cover 80% of value |

---

## Dependencies

| Dependency | Purpose | Why |
|-----------|---------|-----|
| `grammy` | Telegram Bot API | Mature, well-typed, OpenClaw uses it |
| `discord.js` | Discord Bot API | Industry standard |
| `@slack/bolt` | Slack Bot API | Official Slack SDK |
| `better-sqlite3` | Message queue storage | Fast, embedded, no external DB |
| `@modelcontextprotocol/sdk` | MCP server implementation | Standard MCP tooling |
| mcp-secure-proxy shared crypto | E2EE channel | Reuse, don't reinvent |

---

## Success Criteria

- [ ] Agent can receive a Telegram DM and respond through `channels_send`
- [ ] Bot tokens never appear in MCP proxy logs or Claude's context
- [ ] Unknown senders are rejected (allowlist) or prompted to pair
- [ ] Messages queue reliably when the agent isn't actively polling
- [ ] Adding a new channel requires only implementing the adapter interface (~200 lines)
- [ ] Round-trip latency from message received to inbox poll < 2 seconds
