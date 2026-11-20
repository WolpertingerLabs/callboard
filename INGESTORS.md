# Event listeners (ingestors)

Some connections define an **ingestor**: a long-running listener in the daemon that collects events from the service and buffers them for agents to read. There are three kinds:

- **WebSocket:** a persistent outbound connection (Discord Gateway, Slack Socket Mode).
- **Webhook:** the daemon receives `POST /webhooks/<path>` (GitHub, Stripe, Trello).
- **Poll:** the daemon requests an API on a timer and emits new items (Notion, Linear, Reddit, X, Bluesky, Mastodon, Telegram, Twitch).

Listeners run per caller. Each caller gets its own instance for every enabled connection that has an ingestor, with its own secrets and its own in-memory buffer. Multiple sessions from the same caller share it. Buffers are not persisted: a daemon restart, or a stop/restart of the listener, empties them.

## Built-in listeners

| Connection | Type | Event type | Needs |
| --- | --- | --- | --- |
| `discord-bot` | WebSocket | Gateway dispatch name (`MESSAGE_CREATE`, …) | `DISCORD_BOT_TOKEN`; privileged intents enabled in the Discord developer portal (see [Discord](#discord)) |
| `slack` | WebSocket | `event.type`, the slash command, or the interaction type | `SLACK_APP_TOKEN` (`xapp-…`, `connections:write`), Socket Mode enabled in the app |
| `github` | Webhook | `X-GitHub-Event` header | `GITHUB_WEBHOOK_SECRET`; for auto-registration also `GITHUB_WEBHOOK_URL` and a `repoFilter` or `orgFilter` param. Multi-instance. |
| `stripe` | Webhook | `type` field | `STRIPE_WEBHOOK_SECRET` (`whsec_…`) |
| `trello` | Webhook | `action.type` | `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_API_SECRET`, `TRELLO_CALLBACK_URL`, and a `boardId` param. Multi-instance. |
| `notion` | Poll, 60 s | `page_updated` | `NOTION_API_KEY` (`POST /v1/search`, latest edits) |
| `linear` | Poll, 60 s | `issue_updated` | `LINEAR_API_KEY` (50 most recently updated issues) |
| `reddit` | Poll, 60 s | `new_post` | `REDDIT_ACCESS_TOKEN`, `REDDIT_USER_AGENT`, and a subreddit: the `subreddit` param or `REDDIT_SUBREDDIT`. Multi-instance. |
| `x` | Poll, 60 s | `tweet` | `X_BEARER_TOKEN`, `X_SEARCH_QUERY` (inserted into the URL as-is, not URL-encoded) |
| `bluesky` | Poll, 60 s | `notification` | `BLUESKY_ACCESS_TOKEN` |
| `mastodon` | Poll, 60 s | `status` | `MASTODON_ACCESS_TOKEN` (polls `mastodon.social` only) |
| `telegram` | Poll, 30 s | `update` | `TELEGRAM_BOT_TOKEN` (`getUpdates`; doesn't work if the bot has a webhook set). **Known issue:** no `offset` is sent, so updates are never confirmed. Once 25 are pending, every poll returns the same 25 and the listener stops emitting new ones. |
| `twitch` | Poll, 60 s | `stream_online` | `TWITCH_ACCESS_TOKEN`, `TWITCH_CLIENT_ID`, `TWITCH_USER_ID`, and a *user* access token |

Secrets resolve per caller like any other secret (`<ALIAS>_<NAME>`; see [README → Secrets](README.md#secrets)). A listener with missing secrets still starts and then fails:

- WebSocket listeners go to `error`.
- Poll requests fail until the listener gives up.
- Webhooks reject every delivery.

`ingestor_status` and the dashboard show the error.

## Reading events

Every event has this shape:

```json
{
  "id": 1767225600000001,
  "idempotencyKey": "github:5a1f…",
  "receivedAt": "2026-01-01T00:00:00.000Z",
  "receivedAtMs": 1767225600000,
  "callerAlias": "default",
  "source": "github",
  "instanceId": "my-repo",
  "eventType": "push",
  "data": { "deliveryId": "…", "event": "push", "payload": { "…": "GitHub's payload" } }
}
```

`data` is the raw item for poll and Discord events. Webhook listeners wrap the body: GitHub `{ deliveryId, event, payload }`, Stripe `{ eventId, type, payload }`, Trello `{ actionId, actionType, payload }`. Slack stores the envelope's `payload`.

The connection's [withheld secrets](README.md#header-only-secrets) are replaced with `${NAME}` in `data` before an event is buffered, so `poll_events`, `wait_for_events`, and trigger rules never see them. A listener's error text in `ingestor_status` is scrubbed of every secret.

- **`id`** increases monotonically within one listener instance. It is `epoch × 1,000,000 + counter`, and within one daemon process each new instance (including after a listener restart) claims a higher `epoch` than every earlier one. So every ID from a newer listener is larger than every ID from an older one. After a daemon restart, buffers start empty.
- **`idempotencyKey`** comes from the service where possible: GitHub delivery ID, Stripe event ID, Slack envelope ID, Trello action ID, Discord session and sequence number, or the poll dedup field. A listener drops events whose key it has recently seen.
- **`instanceId`** is present only for multi-instance listeners.

**`poll_events`** (MCP tool) takes `connection`, `after_id`, and `instance_id`, all optional, and returns buffered events with `id > after_id`. Without `connection` it returns events from all of the caller's listeners, sorted by `receivedAt`. One `after_id` shared across listeners therefore hides later events from the older listener. Keep a cursor per connection and instance (pass both), or use `wait_for_events`.

**`wait_for_events`** is a daemon tool for long-running clients such as Callboard. The local MCP server doesn't expose it.

- **Input:** `{ "cursors": { "<connection>:<instanceId>": <lastId> }, "timeout_ms": 25000 }`. Single-instance listeners use instance ID `_default`, and streams without a cursor start from the beginning of their buffer.
- **Timing:** the call returns immediately if any stream has events past its cursor. Otherwise it holds until one does or the timeout passes. The timeout defaults to 25 s, is capped at 55 s and at the client's outbound budget, and `0` means don't hold.
- **Reply:** `streams` (every active stream for the caller, each with `events` and its new `cursor`), `unknownStreams` (cursor keys that matched nothing), and `timedOut`.
- **Rate limit:** a held wait counts as one request. At most 2 waits can hold per session, 8 per caller, and 64 per daemon; beyond that the call fails with `too many concurrent waits`.
- **Shutdown:** held waits are answered with `timedOut: true`. Until the daemon exits, new waits that would hold fail with `server shutting down`.

**`ingestor_status`** reports each listener's `connection`, `instanceId`, `type`, `state` (`starting`, `connected`, `reconnecting`, `stopped`, `error`), `bufferedEvents`, `totalEventsReceived`, `lastEventAt`, `error`, and webhook registration status.

**`drawlatch watch [connection] [--full]`** streams every caller's events to your terminal. It works from the daemon host only.

## Controlling listeners

Listeners start when the daemon starts, for every caller connection that has an ingestor and isn't `disabled`. The MCP tools below act on the calling caller's listeners. The dashboard's Connections page does the same for any caller.

| Tool | Behaviour |
| --- | --- |
| `control_listener` | `start`, `stop`, or `restart`, for one `instance_id` or all instances. Starting one that is already running returns its status. |
| `list_listener_configs` | The configurable fields for each connection, and whether it supports multiple instances. |
| `get_listener_params` / `set_listener_params` | Read or merge `params`. Unknown keys are rejected. With `instance_id` it writes `listenerInstances` (pass `create_instance: true` to add one); without, it writes `ingestorOverrides`. A running listener is restarted to apply the change. A newly created instance is not started; use `control_listener`. |
| `list_listener_instances` / `delete_listener_instance` | List instances, or stop one, remove it from config, and unregister its webhook. |
| `resolve_listener_options` | Live choices for fields with dynamic options: Discord `guildIds` and Trello `boardId`. |
| `test_ingestor` | GitHub and Stripe: checks that the signing secret is set. The others, Trello included, make a test request to the service. (Slack's test currently always fails with a header conflict.) |

## Per-caller listener settings

Set these in the caller's entry in `remote.config.json`, keyed by connection:

```json
{
  "callers": {
    "default": {
      "connections": ["discord-bot", "notion", "trello"],
      "ingestorOverrides": {
        "discord-bot": { "guildIds": ["1234567890"], "eventFilter": ["MESSAGE_CREATE"] },
        "notion": { "intervalMs": 30000, "bufferSize": 500 }
      },
      "listenerInstances": {
        "trello": {
          "roadmap": { "params": { "boardId": "abc123" } },
          "sprint": { "params": { "boardId": "def456" } }
        }
      }
    }
  }
}
```

| Field | Applies to | Effect |
| --- | --- | --- |
| `disabled` | all | Don't start this listener at boot. |
| `bufferSize` | all | Ring buffer capacity (default 200). The oldest events are evicted when it's full. Use 10–1000; the daemon doesn't enforce limits, and 0 breaks the buffer. |
| `intervalMs` | poll | Poll interval. Minimum 5000. |
| `eventFilter` | WebSocket | Keep only these event types. Empty means all. |
| `guildIds`, `channelIds`, `userIds` | Discord (Slack: `channelIds`, `userIds`) | Keep only events from these IDs. Filters are ANDed together, and an event that lacks the field passes. Discord reads the user ID from `author.id`, `user.id`, or `user_id`; Slack from `user`, `user_id`, or `user.id`. |
| `intents` | Discord | Gateway intents bitmask. |
| `params` | listener fields | Values for the connection's listener fields (see below). |

`listenerInstances` runs several copies of a multi-instance listener (`github`, `reddit`, `trello`), keyed by instance ID. Instance IDs must match `^[a-zA-Z0-9_-]+$` and can't be `__proto__`, `constructor`, or `prototype`; the listener tools reject anything else. Each value takes the same fields as `ingestorOverrides`. If a connection has any instances, its `ingestorOverrides` entry is ignored.

**Which `params` take effect.** Only these change listener behaviour:

| Connection | Param | Effect |
| --- | --- | --- |
| `reddit` | `subreddit` | The subreddit to poll; takes priority over `REDDIT_SUBREDDIT`. |
| `trello` | `boardId` | Board to register a webhook for and filter on. |
| `github` | `repoFilter` | Repos to filter on, as `owner/repo`; webhook registration uses the first one. |
| `github` | `orgFilter` | Organization to register an org webhook for. |

The dashboard and `set_listener_params` also accept `intervalMs`, `bufferSize`, `eventFilter`, `guildIds`, `channelIds`, `userIds`, and `intents` as params. Those are saved but **currently have no effect**, so set them as top-level `ingestorOverrides` fields instead. `eventFilter` also has no effect on webhook listeners.

## Discord

The template requests intents `3276799`, which is every intent including the privileged `GUILD_MEMBERS` (2), `GUILD_PRESENCES` (256), and `MESSAGE_CONTENT` (32768). Enable all three under Bot → Privileged Gateway Intents in the Discord developer portal. Otherwise Discord closes the connection with code 4014 and the listener goes to `error`. Alternatives:

- `3243773`: every non-privileged intent.
- `4609`: `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES`, the default when `intents` is unset.

| Intent | Bit | Intent | Bit |
| --- | --- | --- | --- |
| `GUILDS` | 1 | `GUILD_MESSAGE_REACTIONS` | 1024 |
| `GUILD_MEMBERS` (privileged) | 2 | `GUILD_MESSAGE_TYPING` | 2048 |
| `GUILD_MODERATION` | 4 | `DIRECT_MESSAGES` | 4096 |
| `GUILD_EXPRESSIONS` | 8 | `DIRECT_MESSAGE_REACTIONS` | 8192 |
| `GUILD_INTEGRATIONS` | 16 | `DIRECT_MESSAGE_TYPING` | 16384 |
| `GUILD_WEBHOOKS` | 32 | `MESSAGE_CONTENT` (privileged) | 32768 |
| `GUILD_INVITES` | 64 | `GUILD_SCHEDULED_EVENTS` | 65536 |
| `GUILD_VOICE_STATES` | 128 | `AUTO_MODERATION_CONFIGURATION` | 1048576 |
| `GUILD_PRESENCES` (privileged) | 256 | `AUTO_MODERATION_EXECUTION` | 2097152 |
| `GUILD_MESSAGES` | 512 | | |

The listener heartbeats and resumes sessions after disconnects. It reconnects with exponential backoff (capped at 30 s, up to 10 attempts). Close codes 4004 and 4010–4014 are fatal.

Common `eventFilter` values: `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `GUILD_MEMBER_ADD` (needs `GUILD_MEMBERS`), `PRESENCE_UPDATE` (needs `GUILD_PRESENCES`), `TYPING_START`, `INTERACTION_CREATE`.

## Slack

The listener calls `apps.connections.open` with `SLACK_APP_TOKEN`, connects to the returned socket, and acknowledges each envelope. Subscribe to the events you want under Event Subscriptions in the Slack app. It reconnects on `disconnect` messages with the same backoff as Discord.

To reply to a slash command or interaction, call `chat.postMessage` (or another Web API method) through `secure_request`. The payload's `response_url` is on `hooks.slack.com`, outside the `slack` allowlist, so the proxy rejects it.

## Webhooks

The daemon accepts `POST /webhooks/<path>` (`github`, `stripe`, `trello`), with JSON bodies up to 1 MB and 120 requests per minute per IP. Each delivery goes to every caller's listener on that path:

- `200` if any listener accepted it (including one that filtered it out)
- `403` if all rejected it
- `404` if no listener uses the path

`HEAD` returns `200` or `404` the same way, which Trello uses to check the callback URL. Deliveries must use content type `application/json`; select it when you create a webhook by hand (GitHub defaults to form-encoded).

The daemon must be reachable from the service. Use `drawlatch start --tunnel` (needs `cloudflared`) or your own reverse proxy. With the tunnel, the daemon sets an unset callback variable such as `TRELLO_CALLBACK_URL` to `<tunnel>/webhooks/<path>` for every caller, unless a caller's `env` sets it. Quick-tunnel URLs change on every start.

**Signature verification** runs when the template sets both `signatureHeader` and `signatureSecret`, as all three built-ins do. If the secret isn't set, every delivery is rejected.

- **GitHub:** `X-Hub-Signature-256`, HMAC-SHA256 of the body.
- **Stripe:** `Stripe-Signature`, HMAC-SHA256 of `<timestamp>.<body>`. Any `v1` signature may match, and timestamps older than 5 minutes are rejected.
- **Trello:** `X-Trello-Webhook`, base64 HMAC-SHA1 of the body followed by the callback URL. The callback URL must exactly match the one registered.

**Auto-registration.** GitHub and Trello listeners register their webhook with the service when they start, reusing an existing one with the same callback URL, and unregister it when deleted or on daemon shutdown. Stopping or restarting a listener leaves the webhook in place.

- **GitHub** needs `GITHUB_TOKEN` (with permission to manage hooks), `GITHUB_WEBHOOK_URL`, and a `repoFilter` (repo hook) or `orgFilter` (org hook) param. The registered hook subscribes to `push`, `pull_request`, `issues`, `issue_comment`, `create`, `delete`, `release`, `workflow_run`, and `check_run`. The listener's event filter also offers `star`, `fork`, and `deployment`, but those never arrive through an auto-registered hook. Without a filter, register the webhook yourself: point it at `https://<host>/webhooks/github`, use your `GITHUB_WEBHOOK_SECRET`, and choose content type `application/json`.
- **Trello** needs a `boardId` param and `TRELLO_CALLBACK_URL` set to `https://<host>/webhooks/trello`. Trello signs with the API secret from the [Power-Up admin page](https://trello.com/power-ups/admin).
- **Stripe** is manual: add `https://<host>/webhooks/stripe` under Dashboard → Developers → Webhooks.

## Polling

Each cycle makes the configured request with the connection's headers, reads the item array at `responsePath`, and emits items whose `deduplicateBy` value hasn't been seen. Details:

- **First poll:** it runs at start and emits every item in the response.
- **Changes to known items:** after that, only new IDs are emitted. A later edit to an item already seen (a Notion page, a Linear issue) isn't re-emitted until the listener restarts.
- **Dedup memory:** up to 10,000 IDs are remembered, and the oldest half is pruned when that fills. Items without the dedup field are always emitted.
- **Redirects:** followed only on the poll URL's own origin (same scheme, host, and port), never from `https` to `http`, and at most 5 hops. A redirect anywhere else isn't followed, so the connection's headers never reach another host. It counts as an error, reported as `redirect not followed` with its `Location`. Webhook auto-registration requests follow the same rule.
- **Errors:** an error sets the state to `reconnecting`. After 10 consecutive errors (non-2xx, or no array at `responsePath`) the listener stops in `error`. A success resets the count.

## Template reference

These fields go in a connection template's `ingestor` block, or in a custom connector. See `src/connections/` for complete examples.

```json
{ "ingestor": { "type": "poll", "poll": { "url": "https://api.example.com/items", "intervalMs": 60000, "responsePath": "data.items", "deduplicateBy": "id" } } }
```

| `type` | Field | Description |
| --- | --- | --- |
| `websocket` | `gatewayUrl` | Gateway URL (Discord) or the `apps.connections.open` URL (Slack). |
| | `protocol` | `discord` or `slack`. |
| | `intents`, `eventFilter`, `guildIds`, `channelIds`, `userIds` | Defaults for the per-caller fields above. |
| `webhook` | `path` | Serves `/webhooks/<path>`. |
| | `protocol` | `stripe`, `trello`, or omitted (GitHub-style). |
| | `signatureHeader`, `signatureSecret` | Enable verification. `signatureSecret` names a secret, which requests can't reference ([header-only secrets](README.md#header-only-secrets)). |
| | `callbackUrl` | Public URL, usually `${SOME_URL_VAR}`. Trello signs with it; lifecycle registration uses it. |
| | `lifecycle` | `list` / `register` / `unregister` request templates for auto-registration. |
| `poll` | `url`, `intervalMs` | Required. `${VAR}` placeholders in `url` and `body` resolve from secrets (not URL-encoded). |
| | `method`, `body` | Default `GET`. The body is sent as JSON for non-GET requests. |
| | `responsePath` | Dot path to the item array. Omit if the response is an array. |
| | `deduplicateBy` | Item field (dot path) for dedup. Omit to emit every item each cycle. |
| | `eventType` | Default `poll`. |
| | `headers` | Extra headers; `${VAR}` placeholders resolve from secrets. These override the connection's headers with the same name. |
| | `etag` | Send `If-None-Match`; a `304` counts as an empty success. |

Listener fields shown in the dashboard come from the template's `listenerConfig`, and `testIngestor` defines what `test_ingestor` does.

## Trigger rules (experimental)

`triggerRules` on a caller forwards matching events to a Claude Code remote trigger. The daemon POSTs `{ "event": { source, instanceId, eventType, receivedAt, data } }` to `https://api.anthropic.com/v1/code/triggers/<triggerId>/run`, using an `ANTHROPIC_API_KEY` given as a **literal** value in the caller's `env`.

```json
{
  "triggerRules": [
    {
      "name": "new-issues",
      "source": "github",
      "eventTypes": ["issues"],
      "filter": { "payload.action": ["opened"] },
      "target": { "type": "remote_trigger", "triggerId": "trig_…" },
      "throttle": { "maxPerMinute": 10, "deduplicateBy": "payload.issue.id" }
    }
  ]
}
```

A rule matches when `source`, the optional `instanceId`, `eventTypes`, and every `filter` entry (dot path in the event's `data` → allowed values) all match. Set `"enabled": false` to turn a rule off (default `true`). `throttle.maxPerMinute` defaults to 10. `throttle.deduplicateBy` is a dot path in `data`; a rule skips an event whose value at that path it has recently dispatched (up to 1000 remembered values per rule). Rules are attached only to listeners started at daemon boot, so a listener restarted later (by `control_listener`, `set_listener_params`, or the dashboard) stops triggering until the next daemon restart.
