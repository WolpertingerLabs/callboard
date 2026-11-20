# Drawlatch

> **Alpha software:** expect breaking changes between updates.

Drawlatch gives AI agents authenticated access to external APIs without giving them the credentials. A daemon holds your secrets and makes the API calls. Agents reach it through a local MCP server over an end-to-end encrypted, mutually authenticated channel, and can only call the URL patterns each connection allows.

- **32 pre-built connections** (GitHub, Slack, Discord, Stripe, Notion, Linear, OpenAI, …) plus your own custom connectors. See [CONNECTIONS.md](CONNECTIONS.md).
- **Per-caller access control.** Each agent identity (caller) sees only its own connections and secrets.
- **Real-time events.** WebSocket, webhook, and polling listeners buffer events for agents to read. See [INGESTORS.md](INGESTORS.md).
- **Admin dashboard** for callers, connections, secrets, and listeners, served by the daemon itself.

**Using [Callboard](https://github.com/WolpertingerLabs/callboard)?** Drawlatch is built in. Callboard manages connections, secrets, and agent identities through its UI, so you don't need to set up drawlatch separately.

## How it works

```
Claude Code ◄─ stdio ─► MCP server (local, no secrets) ◄─ HTTP + E2EE ─► drawlatch daemon (holds secrets) ─ HTTPS ─► API
```

The local MCP server holds only its caller keypair and the daemon's public keys. Each session starts with a handshake: Ed25519 signatures for mutual authentication, then X25519 ECDH to derive AES-256-GCM session keys. The daemon matches each request to an allowlisted connection, injects that connection's headers and secrets, and makes the call. All crypto uses Node's built-in `crypto` module.

## Quick start (single machine)

Requires Node.js 22 or later.

```bash
npm install -g @wolpertingerlabs/drawlatch

drawlatch init            # server keypair, configs and .env in ~/.drawlatch
drawlatch set-password    # dashboard password (at least 8 characters)
drawlatch start           # start the daemon in the background
```

`init` is idempotent and never overwrites existing files. Annotated examples: [`remote.config.example.json`](remote.config.example.json), [`proxy.config.example.json`](proxy.config.example.json), and [`.env.example`](.env.example) (append only the lines you need to `~/.drawlatch/.env`; don't overwrite it, it also holds the dashboard password hash). It writes `"host": "0.0.0.0"`, so the daemon listens on every interface (the dashboard is password-protected; set `"host": "127.0.0.1"` in `~/.drawlatch/remote.config.json` for loopback only). It does not create a caller. Create one next.

**Create a caller.** The local MCP server authenticates as the caller named by `MCP_KEY_ALIAS` (default: `default`), using the keypair in `~/.drawlatch/keys/callers/<alias>/`. Either:

- **Dashboard:** open `http://127.0.0.1:9999/`, go to **Callers → New caller**, name it `default`, then on **Connections** enable `github` and set `GITHUB_TOKEN`. Changes apply immediately.
- **CLI:**

  ```bash
  drawlatch generate-keys caller default
  # In ~/.drawlatch/remote.config.json, set:  "callers": { "default": { "connections": ["github"] } }
  echo 'DEFAULT_GITHUB_TOKEN=ghp_your_token' >> ~/.drawlatch/.env   # secrets are prefixed with the caller alias
  drawlatch restart
  ```

**Register the MCP server with Claude Code:**

```bash
claude mcp add drawlatch -- node "$(npm root -g)/@wolpertingerlabs/drawlatch/dist/mcp/server.js"
```

Add `-e MCP_KEY_ALIAS=<alias>` (before `--`) to use a caller other than `default`, and `-e MCP_CONFIG_DIR=/abs/path` for a config directory other than `~/.drawlatch`. Use absolute paths: a `~` inside an MCP `env` value is not expanded.

**Check the setup:**

```bash
drawlatch doctor    # config, keys, required secrets, daemon health
drawlatch status    # PID, port, uptime, active sessions, dashboard URL
```

This repo is also a Claude Code plugin marketplace (`.claude-plugin/`): `/plugin marketplace add WolpertingerLabs/drawlatch`, then `/plugin install drawlatch@drawlatch`. Its MCP server is named `secure-proxy` and passes `MCP_CONFIG_DIR` and `MCP_KEY_ALIAS` through from your environment.

## Daemon and MCP server on different machines

The MCP server reads PEM files only, so you exchange public keys by hand:

1. **Client machine:** install drawlatch, run `drawlatch generate-keys caller laptop`, and create `~/.drawlatch/proxy.config.json` with `"remoteUrl": "http://<daemon-host>:9999"` (see [Proxy config](#proxy-config-proxyconfigjson)). Don't run `init` here; it would create an unrelated server keypair.
2. Copy the client's `keys/callers/laptop/*.pub.pem` to the daemon machine's `~/.drawlatch/keys/callers/laptop/`, and add `"laptop": { "connections": [...] }` to its `callers`.
3. Copy the daemon's `keys/server/*.pub.pem` to the client's `~/.drawlatch/keys/server/`.
4. `drawlatch restart` on the daemon, then register the MCP server on the client with `-e MCP_KEY_ALIAS=laptop`.

Traffic is encrypted end to end, but the dashboard cookie is not marked `secure`. Put the daemon behind a TLS-terminating proxy if you expose it beyond a trusted network.

**Callboard instances** use credential bundles instead: `drawlatch issue-caller <alias> -o <alias>.drawlatch-caller.json` (or **Issue credentials** on the dashboard's caller page), then import the file in Callboard. On the same host, `--into <callboard keys dir>` writes the key files directly. Issuing mints a new keypair and keeps only its public half, so **issuing for an existing alias rotates its keys** and deletes any private key drawlatch held for it. After a CLI issue, `drawlatch restart` so a running daemon accepts the new key; dashboard issues apply immediately.

A co-located Callboard can also provision itself. When the daemon starts with `DRAWLATCH_LOCAL_CALLER_KEYS_DIR` set and the caller named by `DRAWLATCH_LOCAL_CALLER_ALIAS` (default `callboard-local`; Callboard sets `default`) is missing from config or has no keys, drawlatch issues it and writes the caller keys to `<dir>/callers/<alias>/` and the server public keys to `<dir>/server/`. `DRAWLATCH_LOCAL_CALLER_CONNECTIONS` (comma-separated) sets its connections. If that is unset, it keeps the existing entry's connections or copies the `default` caller's.

## MCP tools

The local MCP server exposes these tools. Every call goes through the encrypted channel and runs as the authenticated caller.

| Tool | Purpose |
| --- | --- |
| `secure_request` | HTTP request to an allowlisted URL. Connection headers are injected for you. `${VAR}` placeholders in the URL and headers resolve server-side from the matched connection's secrets (in the body only if the connection sets `resolveSecretsInBody`). Secrets the connection injects itself are [withheld](#header-only-secrets): a request that references one is rejected, and their values are scrubbed from the response body. Redirects are followed only within the connection's allowlist ([Redirects](#redirects)). Supports multipart uploads from local files (25 MB per file, 50 MB per base64-encoded request): with `files`, the JSON `body` is sent as a form part named `payload_json` (change it with `bodyFieldName`). Also takes a per-call `timeoutMs`. |
| `list_routes` | The caller's connections: docs links, allowed endpoint patterns, the *names* of secrets that are set, auto-injected header names, `withheldSecretNames` (secrets the connection uses itself, which a request may not reference), `awsSigV4` settings, timeouts, listener info. |
| `test_connection` | Run a connection's built-in credential check. Some cost a little credit; see [CONNECTIONS.md](CONNECTIONS.md#available-connections). |
| `list_connection_templates` | All built-in templates, with which are enabled for this caller and which secrets are set (booleans). Custom connectors aren't listed. Each entry's `selfManageable` says whether the two tools below will work for this caller. |
| `set_connection_enabled` | Enable or disable a connection for this caller. Refused when the caller has `selfManage: false`. |
| `set_secrets` | Set or delete (empty string) this caller's secrets. Write-only. Refused when the caller has `selfManage: false`. |
| `get_secret_status` | Which required and optional secrets are set for a built-in connection (booleans). |
| `poll_events` | Read buffered listener events after a cursor. |
| `ingestor_status` | State, buffer size, event counts, and errors for this caller's listeners. |
| `control_listener` | Start, stop, or restart a listener. |
| `list_listener_configs` | Configurable listener fields per connection. |
| `get_listener_params` / `set_listener_params` | Read or change listener parameters. |
| `resolve_listener_options` | Fetch dynamic choices for a listener field (for example, your Trello boards). |
| `list_listener_instances` / `delete_listener_instance` | Manage multi-instance listeners. |
| `test_ingestor` | Check a listener's configuration and credentials. |

`set_secrets` and `set_connection_enabled` let an agent change its own caller's configuration, which can grant it more access: secrets resolve per caller by name, so a connection the agent enables for itself starts with any secret it shares a name with (a second `google-*` connector picks up the existing `GOOGLE_API_TOKEN`). The agent still can't read secret values or reach URLs outside the allowlists. Set [`selfManage: false`](#callers) on a caller to refuse both tools to its agent. The dashboard can still make the change. Callers that drawlatch creates (dashboard **New caller**, `issue-caller` for a new alias, local Callboard provisioning) start with `selfManage: false`. A caller entry without the field allows both tools, so existing configs behave as before.

The daemon also accepts `wait_for_events`, a long-poll over all of a caller's event streams. The local MCP server doesn't expose it; long-running clients such as Callboard call it over the encrypted channel. See [INGESTORS.md](INGESTORS.md#reading-events).

It likewise accepts `ingest_logs`, which appends records to the caller's audit log. The local MCP server doesn't expose it either. See [Audit log](#audit-log).

## Configuration

### Config directory

Everything lives in `~/.drawlatch/`, or `$MCP_CONFIG_DIR` if set:

```
remote.config.json     daemon config: callers, custom connectors, host/port, rate limit, tunnel
proxy.config.json      local MCP server config: daemon URL and timeouts
.env                   secrets (mode 0600), plus the dashboard password hash
keys/server/           the daemon's Ed25519 + X25519 keypair
keys/callers/<alias>/  one keypair per caller (public half only, when issued as a bundle)
logs/drawlatch.log     daemon log (drawlatch logs)
data/sessions.json     dashboard login sessions
audit/<caller>/        append-only audit logs shipped by callers (see Audit log)
drawlatch.pid          PID of the background daemon
```

Each key directory holds `signing.{pub,key}.pem` and `exchange.{pub,key}.pem`. Private keys are written `0600` and key directories `0700`. On startup the daemon moves the legacy `keys/local`, `keys/remote`, and `keys/peers/*` layouts into this one.

### Daemon config (`remote.config.json`)

| Field | Default | Description |
| --- | --- | --- |
| `host` | `127.0.0.1` (`init` writes `0.0.0.0`) | Bind address. Env override: `DRAWLATCH_HOST`, or `drawlatch start --host`. |
| `port` | `9999` | Listen port. Env override: `DRAWLATCH_PORT`, or `--port`. |
| `rateLimitPerMinute` | `240` (`init` writes `60`) | Encrypted requests per minute per session. Over the limit, the daemon returns `429` with `Retry-After`. |
| `callers` | `{}` | Caller aliases and what each may use (see below). |
| `connectors` | `[]` | Custom connector definitions (see below). |
| `tunnel` | `false` | Start a Cloudflare quick tunnel at boot. Env override: `DRAWLATCH_TUNNEL=1`, or `--tunnel`. |

`LOG_LEVEL` in `.env` or the environment sets daemon log verbosity: `error`, `warn`, `info` (default), or `debug`.

The daemon re-reads `remote.config.json` for each new session and after dashboard changes. Hand edits that add callers or change listeners need `drawlatch restart`.

### Callers

```json
{
  "callers": {
    "default": { "connections": ["github", "stripe", "internal-api"] },
    "ci": { "name": "CI runner", "connections": ["github"] }
  }
}
```

| Field | Description |
| --- | --- |
| `connections` | Required. Built-in connection names or custom connector aliases. |
| `name` | Display name for logs and the dashboard. |
| `env` | Per-caller secret values (see [Secrets](#secrets)). |
| `ingestorOverrides`, `listenerInstances` | Listener settings ([INGESTORS.md](INGESTORS.md#per-caller-listener-settings)). |
| `triggerRules` | Forward matching events to Claude Code remote triggers ([INGESTORS.md](INGESTORS.md#trigger-rules-experimental)). |
| `selfManage` | Whether the caller's agent may run `set_connection_enabled` and `set_secrets` on itself ([MCP tools](#mcp-tools)). Absent means `true`. Callers drawlatch creates are written with `false`. The admin API and dashboard aren't affected. |

Caller public keys are read from `keys/callers/<alias>/`. Aliases must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`.

### Secrets

Connections reference secrets as `${NAME}` (for example, `${GITHUB_TOKEN}`). For caller `<alias>`, the daemon looks up `NAME` in this order:

1. A literal value in the caller's `env` map: `"env": { "GITHUB_TOKEN": "ghp_..." }`.
2. The environment variable `<ALIAS>_<NAME>`, with the alias uppercased and `-` replaced by `_`. Examples: `DEFAULT_GITHUB_TOKEN`, `MY_AGENT_GITHUB_TOKEN`.

A bare `GITHUB_TOKEN` is never used. This keeps one caller from picking up another's credentials. The daemon loads `.env` at startup, so restart after editing it by hand. The dashboard and `set_secrets` write `<ALIAS>_<NAME>` to `.env` and apply the change immediately.

If a secret isn't set, its placeholder is sent literally (for example, `Authorization: Bearer ${GITHUB_TOKEN}`), and the upstream API will usually answer `401`. An [`awsSigV4`](#aws-sigv4-signing) connection without its signing keys fails the request instead of sending it. `drawlatch doctor`, `drawlatch config`, and the dashboard's Secrets page show what's missing. They check only built-in templates, and only secrets used in a template's headers or, for an `awsSigV4` template, its signing keys: custom connectors are skipped, and a token that goes in the URL (Telegram, Trello) isn't flagged. `doctor` also prints the unprefixed name ("Set GITHUB_TOKEN in …/.env"); whatever it says, set `<ALIAS>_<NAME>` (`DEFAULT_GITHUB_TOKEN` for the default caller).

> **Known issue:** an `env` value that redirects to another variable, such as `"GITHUB_TOKEN": "${ALICE_TOKEN}"`, is ignored; the prefixed variable (`<ALIAS>_GITHUB_TOKEN`) is used if set. Status checks still report the redirected secret as set. Use a literal value or the prefixed variable instead.

#### Header-only secrets

A secret that a connection's own `headers` reference is **header-only**: it is injected into those headers, and nowhere else. A request may not reference it as `${NAME}` in its URL, its headers, or a `resolveSecretsInBody` body; such a request is rejected before anything is sent, and the daemon logs the connection and secret name. Upstreams echo identifiers back in error messages, so `GET https://www.googleapis.com/drive/v3/files/${GOOGLE_API_TOKEN}` would otherwise answer `File not found: ya29…` and hand the token to the agent.

Header-only secrets are one kind of **withheld** secret. The others are a webhook listener's `signatureSecret`, anything a connector lists in `withheldSecrets` (the `slack` template lists `SLACK_APP_TOKEN`, which Socket Mode reads directly), any secret whose value contains a withheld value of 4 or more characters, and [AWS SigV4](#aws-sigv4-signing) signing keys, which, unlike the others, don't resolve in `headers` either. `list_routes` reports them as `withheldSecretNames`. `placeholderSecrets` releases only header-only secrets, not the other kinds.

**Scrubbing.** Withheld values are replaced with `${NAME}` in response bodies, `statusText`, and listener output: buffered events (`poll_events`, `wait_for_events`, triggers) and `ingestor_status` errors, which are scrubbed of every secret. JSON bodies, including `+json` types such as `application/problem+json`, are parsed and their string values and keys scrubbed. Text bodies are scrubbed of each value as-is, URL-encoded, and JSON-string-escaped (with and without `\/`). Scrubbing is best-effort defense in depth: base64, case-changed, or otherwise transformed copies aren't recognised. Secrets a request may reference are left alone in bodies and events, since the caller can use them by design and many are ordinary values (`REDDIT_SUBREDDIT`, `TWITCH_USER_ID`) that appear in real responses. Values that are public but sent in a header are withheld too: Twitch's `Client-Id` and Reddit's `User-Agent` show up as `${TWITCH_CLIENT_ID}` and `${REDDIT_USER_AGENT}` in responses. A custom connector that needs them verbatim lists them in `placeholderSecrets`.

Built-in templates that authenticate in the URL keep working, because their tokens aren't in `headers`: Trello (`?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`) and Telegram (`/bot${TELEGRAM_BOT_TOKEN}/`). An upstream can still echo those back.

**Template requests.** `testConnection`, `testIngestor`, and `listenerConfig` option lookups come from the connection, not the agent. They run against their own connection only, may use withheld secrets (never signing keys), and their headers override the connection's headers of the same name, so Slack's listener test sends its app token instead of the bot token. Their responses are still scrubbed. Listeners also receive withheld secrets (the Discord gateway needs its bot token).

**Upgrading custom connectors.** A custom connector whose agents were told to write a header secret into a URL, body, or request header now has those requests rejected. If the API really needs the secret there, list it in `placeholderSecrets`. At startup the daemon logs a warning, and `drawlatch doctor` fails a check, for a connector whose `description` references a withheld secret, or whose `placeholderSecrets` entry can't take effect.

### Custom connectors

Use these for APIs without a built-in template, or to override one: a connector whose `alias` matches a built-in name replaces that template.

```json
{
  "connectors": [
    {
      "alias": "internal-api",
      "name": "Internal Admin API",
      "allowedEndpoints": ["https://admin.internal.example/**"],
      "headers": { "Authorization": "Bearer ${ADMIN_KEY}" },
      "secrets": { "ADMIN_KEY": "${ADMIN_KEY}" }
    }
  ]
}
```

With this connector, caller `default` reads `ADMIN_KEY` from `DEFAULT_ADMIN_KEY`.

| Field | Description |
| --- | --- |
| `alias` | Required. Name referenced from a caller's `connections`. |
| `allowedEndpoints` | Required. URL globs: `*` matches within a path segment, `**` across segments. An empty list matches nothing. |
| `headers` | Headers injected into every request. `${VAR}` resolves against `secrets`. A request that sets the same header itself is rejected. |
| `awsSigV4` | Sign every request with AWS Signature Version 4: `{}`, or `{ "service": "…", "region": "…" }` to override what's inferred from the hostname. See [AWS SigV4 signing](#aws-sigv4-signing). |
| `secrets` | `NAME → value`. The value is a literal, or `${VAR}` resolved per caller as in [Secrets](#secrets). A secret referenced in `headers` is [header-only](#header-only-secrets). |
| `withheldSecrets` | Extra secret names to withhold from request URLs, headers, and bodies, like header-only ones. They still resolve in `headers` and listener configs. |
| `placeholderSecrets` | Header secrets that requests may also reference as `${NAME}`, for an API that needs the same credential in a header and the URL or body. The upstream can echo these back. Releases only header-only secrets, not a `signatureSecret`, a `withheldSecrets` entry, or SigV4 signing keys. |
| `resolveSecretsInBody` | Resolve `${VAR}` in request bodies. Default `false`, which stops an agent from writing a placeholder into a resource and reading the secret back. |
| `requestTimeoutMs` | Default outbound timeout for this API, and the most a caller may request (see [Request timeouts](#request-timeouts)). |
| `name`, `description`, `docsUrl`, `openApiUrl` | Shown to agents by `list_routes`. |
| `testConnection`, `ingestor`, `listenerConfig`, `testIngestor` | Credential test and event listener definitions. Built-in templates in `src/connections/` are the reference. |

#### AWS SigV4 signing

AWS APIs need a signature computed per request, so a static header can't authenticate them. A connector with `awsSigV4` gets one from the daemon instead. After the URL, headers, and body are final, the daemon signs the exact bytes it sends and adds `Authorization`, `X-Amz-Date`, `X-Amz-Content-Sha256` (the SHA-256 of the body), and `X-Amz-Security-Token` when a session token is set. The built-in [`aws`](CONNECTIONS.md#notes-by-connection) template uses it.

- **Credentials** are the connector's `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets, plus `AWS_SESSION_TOKEN` for temporary credentials. They resolve per caller like any other secret, so `"AWS_ACCESS_KEY_ID": "${PROD_AWS_ACCESS_KEY_ID}"` in `secrets` points a connector at different variables. The first two count as required. If either is missing, the request fails without being sent. Only the signer reads these three. They, and any other secret whose value contains one of them, are never substituted for `${VAR}` in a URL, a header, a connector's own `headers`, a body with `resolveSecretsInBody`, or a listener's requests; a request that references one is rejected.
- **Service and region** come from the request hostname: `<service>.<region>.amazonaws.com`, `<id>.<service>.<region>.amazonaws.com` (API Gateway, SageMaker runtime), `<id>.<region>.<service>.amazonaws.com` (OpenSearch), interface VPC endpoints (`vpce-….<service>.<region>.vpce.amazonaws.com`), and S3's virtual-hosted, path-style, dual-stack, and legacy `s3-<region>` hosts, with `s3-outposts` and `s3-object-lambda` as their own signing names. A global endpoint such as `sts.amazonaws.com` or `iam.amazonaws.com` signs for `us-east-1`, and `iam.us-gov.amazonaws.com` for `us-gov-west-1`. A few endpoint prefixes map to a different signing name (`bedrock-runtime` and `bedrock-agent*` → `bedrock`, `email` → `ses`, `aps-workspaces` → `aps`). For anything else, set `service` and `region` explicitly, which overrides the inference for every request on that connector.
- **Reserved names.** A request may not set `Authorization`, `Host`, `X-Amz-Date`, `X-Amz-Content-Sha256`, or `X-Amz-Security-Token`, or carry presigned-URL query parameters (`X-Amz-Signature`, `X-Amz-Credential`, and so on). Such a request is rejected. Other `x-amz-*` headers, such as `X-Amz-Target` or `x-amz-meta-*`, are sent and signed.
- **What's signed:** `host`, every header sent except hop-by-hop ones (`connection`, `user-agent`, `content-length`, and similar), and the body. A string body is sent as UTF-8, with fetch's default `text/plain;charset=UTF-8` content type unless you set one. Multipart uploads are serialized before signing. Paths are normalized and encoded per segment as SigV4 requires. S3 paths are encoded once and not normalized. The URL itself is parsed first, which already resolves `.` and `..` segments (including `%2E%2E`), so S3 keys containing those segments can't be reached.
- **Redirects** aren't followed, even to the same host: the signature covers the original URL. A 3xx comes back to the caller with its `Location` header (see [Redirects](#redirects)).

### Proxy config (`proxy.config.json`)

Read by the local MCP server, which won't connect without this file. `init` writes it. Fields missing from the file fall back to these defaults.

| Field | Default | Description |
| --- | --- | --- |
| `remoteUrl` | `http://localhost:9999` (`init` writes `http://127.0.0.1:9999`) | Daemon URL. |
| `connectTimeout` | `10000` | Handshake timeout (ms). |
| `requestTimeout` | `185000` | Local → daemon deadline (ms) for calls that don't pass `timeoutMs`. It also caps the daemon's outbound budget. |

Keys are read from `keys/callers/<MCP_KEY_ALIAS or "default">/` and `keys/server/`.

### Request timeouts

A proxied call has three nested deadlines. The innermost fires first, because only the daemon's outbound fetch can actually cancel the upstream call:

| Layer | Deadline | Default |
| --- | --- | --- |
| daemon → upstream API | per-call `timeoutMs`, else the connection's `requestTimeoutMs`, else 25 s. Capped by the connection's `requestTimeoutMs` (or 290 s), then by the local budget. | `25000` |
| MCP server → daemon | `timeoutMs + 5000`, else `requestTimeout` | `185000` |
| MCP client → MCP server | your client's tool timeout (`MCP_TOOL_TIMEOUT` in Claude Code) | `60000` |

- The MCP server sends the daemon an outbound budget of its own deadline minus 5 s, so the outbound leg always finishes first. Passing `timeoutMs` widens the local deadline to match.
- `exa`, `firecrawl`, and `parallel` allow up to 120 s, and `perplexity` up to 180 s. All four exceed the MCP client's 60 s default, so raise `MCP_TOOL_TIMEOUT` to use the full ceiling. They already fit under the default `requestTimeout`. For long jobs, prefer the API's async submit-and-poll endpoints.
- `list_routes` reports each connection's `defaultTimeoutMs` and `maxTimeoutMs` under the current budget.
- The 290 s outbound maximum sits below undici's internal 300 s headers timeout, which would otherwise fire first with an opaque error.
- A timed-out call is cancelled at the socket and reported as `Upstream request timed out after <n>ms`. If the local budget was the binding limit, the error names the setting to raise. A host that never accepts the connection is reported as `Upstream never accepted the connection`.
- The MCP server accepts `timeoutMs` only as a positive integer up to 290000. The daemon treats invalid values from other clients as unset. A malformed `requestTimeoutMs` on a connection falls back to 25 s; it doesn't remove the ceiling.

### Redirects

The daemon follows redirects itself rather than leaving them to fetch, whose default forwards every header except `Authorization` and `Cookie` to wherever `Location` points. For a proxied request (`secure_request`, `test_connection`, `test_ingestor`, `resolve_listener_options`), each hop is checked first:

- **Allowlist:** the target must match the same connection's `allowedEndpoints`, on the same host or another one.
- **No downgrade:** an `https` URL never redirects to `http`, even on the same host.
- **Cross-origin headers:** when the scheme, host, or port changes, only `Accept`, `Accept-Language`, `Content-Language`, `Content-Type`, and `User-Agent` go along, and only when their value contains none of the connection's secrets. Connection headers such as `x-api-key`, `Circle-Token`, `DD-API-KEY`, or Twitch's `Client-Id`, and caller headers with resolved placeholders, are dropped for that hop and every later one. A same-origin hop keeps all headers, and so does a plain upgrade from `http` on port 80 to `https` on port 443 with the same hostname. Any other port change counts as cross-origin.
- **Method and body:** 301 and 302 turn a `POST` into a `GET`, 303 turns anything but `GET` or `HEAD` into a `GET`, and both drop the body and its content headers. 307 and 308 resend the method and body, multipart uploads included. If `resolveSecretsInBody` substituted a secret into the body, a 307 or 308 to another origin isn't followed, since the body would go there as-is.
- **Limit:** at most 5 hops.

A hop that fails a check isn't followed and isn't an error. The 3xx comes back as the result, with its `Location` header, and the target is never contacted. Secrets in response header values, such as a refused `Location` that echoes `?key=…` back, are shown as `${NAME}`, both as-is and URL-encoded. Response bodies are scrubbed of [withheld secrets](#header-only-secrets) only. When redirects were followed, the result has a `url` field with the final URL, scrubbed the same way.

`awsSigV4` connections never follow redirects. Listener requests (polls, webhook auto-registration, Slack Socket Mode connect) and trigger dispatch follow redirects only on the request URL's own origin; see [INGESTORS.md](INGESTORS.md#polling).

### Audit log

Callers can ship durable log records to the daemon with the `ingest_logs` tool (Callboard uses it for permission-review decisions). It is write-only: no tool reads, lists, changes, or deletes what is stored. Read the files on the daemon's machine.

The input mirrors OTLP's `ExportLogsServiceRequest` in its JSON encoding (`resourceLogs[].scopeLogs[].logRecords[]`, hex `traceId`/`spanId`, uint64 times as decimal strings, proto3 JSON spellings such as `"NaN"` doubles and `SEVERITY_NUMBER_*` names). A record may also carry a `parentSpanId`, which OTLP lacks. The reply mirrors `ExportLogsServiceResponse`: `{}` when everything was stored as sent, else `{ "partialSuccess": { "rejectedLogRecords": <n>, "errorMessage": "…" } }`. Only a non-object input or a non-array `resourceLogs` fails the whole call.

Validation keeps data rather than dropping it, as OTLP requires of receivers. An unknown field is stored under `extra` and a known field with an invalid value under `invalid` (`{"reason", "raw"}`), both keyed by path such as `logRecord["spanID"]`, `resource["entityRefs"]` or `logRecord.attributes["latency"]` (client-chosen keys are JSON-quoted, so a key containing `.` can't collide with nested data). At most 128 unknown fields per object and 256 entries per map are kept; past that the line is marked `truncated`. Those records are stored and reported in `errorMessage` as `kept: …` warnings with `rejectedLogRecords: 0`. A record is rejected (`rejected: …`) only when it isn't an object, sits under a container that isn't one, or is over a size limit.

Records go to `audit/<caller>/<YYYY-MM-DD>.jsonl` (UTC day of receipt), one JSON object per line. Files are `0600` and directories `0700`. Each append is fsync'd before the reply, and so is the directory when a file is created. A line looks like this (wrapped here):

```json
{"drawlatch.caller":"callboard","drawlatch.received_at":"2026-10-11T12:00:00.000Z","drawlatch.sequence":42,
 "drawlatch.source":"client","time_unix_nano":"1760184000000000000","severity_number":9,"severity_text":"INFO",
 "event_name":"permission.review.result","trace_id":"…","span_id":"…","parent_span_id":"…",
 "body":{"verdict":"approve"},"attributes":{"tool.name":"Bash"},"resource":{"service.name":"callboard"},
 "scope":{"name":"callboard.permission-review","version":"1"}}
```

The `drawlatch.*` fields are set by the daemon: the caller is the authenticated session's, `sequence` counts up within each file, and `source` is `client` for caller records. Everything else is what the client sent, flattened (attribute lists become objects, `AnyValue`s become plain JSON; an `intValue` too big for a JSON number stays a string). Optional fields are left out when absent. Use `jq`, for example `jq -c 'select(.trace_id == "…")' ~/.drawlatch/audit/*/*.jsonl`.

Limits: 1000 records and 4 MiB stored per call, and 256 KiB per line (the shared resource and scope count toward every line under them). Records past a limit are rejected. Strings over 16 KiB are cut and end in `…[truncated]`; past 128 attributes or keys, 256 array items, or 8 levels of nesting, the extra is dropped. Any of these adds `"truncated": true` to the line. A call counts as one request against `rateLimitPerMinute`.

Each caller also has a stored-bytes budget: a 16 MiB burst refilling at 192 KiB a minute (about 270 MiB a day). Records past it are rejected with `audit byte budget exhausted`, and the daemon records the gap itself with a line clients can't write:

```json
{"drawlatch.caller":"callboard","drawlatch.received_at":"…","drawlatch.sequence":43,"drawlatch.source":"daemon",
 "drawlatch.event":"quota_exceeded","rejected_records":120,"rejected_bytes":4194304,
 "window_start":"…","window_end":"…","budget":{"capacity_bytes":16777216,"refill_bytes_per_minute":196608}}
```

There is at most one such line per caller per minute, covering every refusal since the last one. The first refusal after a quiet minute is recorded in the same append that answers the call. Later ones wait for a timer, which writes them even if the caller stops sending. Whenever a marker write fails, the timer retries with backoff (1 s doubling to 5 min) until it succeeds.

On SIGTERM or SIGINT (`drawlatch stop` sends SIGTERM):
- `ingest_logs` stops accepting calls and answers `server shutting down; retry after restart`. Callboard keeps the batch and resends it after the restart.
- A call already in progress writes its marker in the same append that answers it.
- Pending counts are written before the daemon closes its port, again after it closes, and once more if it reaches its 10 s forced exit. Each attempt waits at most 2 s, so a held-open connection can't hold them back.
- `drawlatch stop` waits 15 s before falling back to SIGKILL, longer than the daemon's own shutdown.

So once a shutdown has begun, every refusal is on disk before the daemon exits, unless the day's marker allowance is used up or the disk keeps failing. What can still be lost is the counts waiting for the timer when the daemon is SIGKILLed or crashes, or the machine loses power: up to a minute of refusals for each caller over budget, or longer while a failing disk keeps the timer retrying. These lines come from a separate 1 MiB-a-day allowance, not the caller's budget. `jq 'select(."drawlatch.source" == "daemon")'` finds them.

Every authenticated caller can write to its own log; there is no per-caller switch. Records carry the client's own timestamps, but only the `drawlatch.*` stamps are the daemon's. Anyone holding a caller's private key can add records as that caller, but not change or remove existing ones. Within the budget they can also crowd out real records; the `quota_exceeded` lines make that visible on the hub.

### Webhooks and the tunnel

Webhook listeners (GitHub, Stripe, Trello) receive `POST /webhooks/<path>` on the daemon's port, so the daemon must be reachable from the internet. `drawlatch start --tunnel` (or `"tunnel": true`) runs a Cloudflare quick tunnel; [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) must be installed. The tunnel URL appears in `drawlatch status`, and the daemon sets any unset callback-URL variable a webhook template references (for example, `TRELLO_CALLBACK_URL`) before starting listeners. Details: [INGESTORS.md](INGESTORS.md#webhooks).

## Admin dashboard

The daemon serves a web dashboard and its JSON API from the same port as the MCP protocol: `http://127.0.0.1:9999/` by default. From it you can create, issue, and delete callers; choose whether a caller's agent may manage its own connections and secrets (**Agent permissions** on the caller page); enable connections; set secrets; configure, test, and control listeners; and watch events, ingestors, sessions, and a secrets matrix. Connection and secret changes apply to open sessions immediately. Running listeners pick up new secrets, or a newly enabled connection, only when they are (re)started: use the listener controls or `drawlatch restart`. Listener parameter changes restart the listener.

**Password.** The dashboard stays locked until a password is set. `drawlatch set-password` (alias `change-password`) prompts on a TTY or reads the password twice from stdin (`printf '%s\n%s\n' "$PW" "$PW" | drawlatch set-password`). It stores a scrypt hash and salt in `.env` as `AUTH_PASSWORD_HASH` / `AUTH_PASSWORD_SALT`. Restart the daemon after setting it from the CLI. Changing it from the dashboard (**Change password**, `/settings/password`) applies immediately and signs out every other session.

**Security.**

- The password, not loopback, is the trust boundary. That's why the daemon can bind `0.0.0.0`.
- The session cookie (`drawlatch_session`) is `httpOnly` and `sameSite=strict`, with a 7-day rolling expiry. It has no `secure` flag, so use a TLS-terminating proxy beyond a trusted network.
- Per-IP rate limits:
  - login and password change: 3/min combined
  - auth check and logout: 20/min
  - `/handshake`: 30/min
  - `/webhooks`: 120/min
  - `/health`: 60/min
  - `/api/admin`: 300/min, with credential issuance limited to 10/min
- Without a password, the MCP protocol still works. Login, auth checks, and `/api/admin/*` return `503`.

**API.** The dashboard is a client of `/api/admin/*` (paths below are relative to it). Read endpoints report secrets as booleans only:

- `GET /meta`, `/health`, `/connections`, `/callers`, `/ingestors`, `/sessions`, `/secrets`
- `GET /callers/:alias/connections`, `/callers/:alias/connection-status`, `/callers/:alias/ingestors`, `/callers/:alias/events`, `/callers/:alias/listener-configs`

Write endpoints (`…` = `/callers/:alias/connections/:connection`):

| Method and path | Action |
| --- | --- |
| `POST /callers` `{alias, name?, connections?}` | Create a caller with a keypair on drawlatch's disk |
| `POST /callers/:alias/issue` `{connections?, endpointUrl?, passphrase?, name?}` | Issue or rotate a credential bundle (10/min) |
| `DELETE /callers/:alias` | Delete a caller, its keys, and the secrets recorded in its `env` map (set via the dashboard or `set_secrets`; hand-added `.env` lines remain). `default` is protected |
| `PUT /callers/:alias/self-manage` `{enabled}` | Set the caller's `selfManage` flag (applies immediately). `GET /callers` reports it |
| `PUT /tunnel` `{enabled}` | Persist the tunnel flag (applies on restart) |
| `POST …` `{enabled}` | Enable or disable a connection |
| `PUT …/secrets` `{secrets}` | Set secrets; empty string deletes |
| `POST …/test`, `POST …/test-ingestor` | Run the connection or listener test |
| `POST …/listener/control` `{action, instance_id?}` | Start, stop or restart a listener |
| `GET`/`PUT …/listener/params` | Read or set listener params |
| `GET`/`POST …/listener/instances`, `DELETE …/listener/instances/:instanceId` | Manage listener instances |
| `POST …/listener/resolve-options` `{paramKey}` | Fetch dynamic field options |

Connection and listener operations share their implementation with the MCP tools (`src/remote/tool-dispatch.ts`). The unauthenticated `GET /health` returns status, active session count, uptime, and the tunnel URL.

## CLI reference

```
drawlatch [command] [options]          (no command: status if running, else help)

init                     Create server keys, proxy/remote configs and .env (idempotent)
start                    Start the daemon in the background
    -f, --foreground       Run in the foreground (for process managers)
    -t, --tunnel           Also start a Cloudflare quick tunnel (requires cloudflared)
    --port <n>, --host <addr>
stop | restart           Stop (SIGTERM, then SIGKILL after 15s) / restart; restart keeps an active tunnel
status                   PID, address, dashboard URL, password state, uptime, health, sessions
logs                     Show the log (~/.drawlatch/logs/drawlatch.log)
    -n, --lines <n>        Lines to show (default 50)
    --follow               Keep tailing
    --requests             Include per-request [audit] lines (hidden by default)
watch [connection]       Stream listener events live (loopback only)
    --full                 Print full payloads instead of a 100-character preview
config                   Show effective config and per-caller secret status (--path: config file path)
doctor                   Check config, keys, required secrets and daemon health
generate-keys caller [alias]   Caller keypair in keys/callers/<alias>/ (default alias "default")
generate-keys server           Server keypair in keys/server/
generate-keys show <path>      Fingerprint of an existing keypair
issue-caller <alias>     Issue a caller credential bundle (for Callboard)
    --name <name>          Display name (default: keep existing, else the alias)
    --connections <a,b>    Connections (default: keep existing, else copy "default")
    --endpoint <url>       Daemon URL pinned in the bundle (default: this daemon's host:port)
    --passphrase           Encrypt the bundle's private keys (scrypt + AES-256-GCM)
    -o, --output <file>    Write to a 0600 file instead of stdout
    --into <keysDir>       Same host: write key files into a Callboard keys directory
set-password             Set the dashboard password (alias: change-password)
-h, --help / -v, --version
```

## Security model

- **Endpoint allowlisting:** requests go only to URLs matching the caller's connections. Redirects are followed only to allowlisted URLs, never from `https` to `http`, and without credential headers across origins ([Redirects](#redirects)).
- **Per-caller isolation:** each caller sees only its connections, and secrets resolve only from its own `env` or `<ALIAS>_`-prefixed variables.
- **No secrets on the client:** the MCP server never holds API credentials. Secret placeholders resolve server-side, in request bodies only when a connection opts in. Secrets a connection injects in its own headers can't be placed in a request at all, and are scrubbed from response bodies ([Header-only secrets](#header-only-secrets)).
- **Mutual authentication:** Ed25519-signed handshake against a pinned server key and registered caller keys.
- **Encryption:** AES-256-GCM with per-session X25519 ECDH keys, and monotonic counters against replay.
- **Sessions** expire after 30 minutes idle.
- **Rate limits** apply per session (`rateLimitPerMinute`) and per IP on unauthenticated endpoints.
- **Request log:** every request and response is logged with caller and session (`drawlatch logs --requests`).
- **Caller audit log:** `ingest_logs` is append-only and write-only over the protocol, stamped with the authenticated caller ([Audit log](#audit-log)).

## Package exports

Drawlatch is mainly a CLI and daemon. Hosts such as Callboard can import these subpaths; any other deep import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

| Export | Contents |
| --- | --- |
| `@wolpertingerlabs/drawlatch` | The MCP stdio server (`dist/mcp/server.js`). Importing it starts the server. |
| `…/shared/crypto` | Key generation, loading and fingerprints, `EncryptedChannel` |
| `…/shared/protocol` | `HandshakeInitiator` / `HandshakeResponder` and wire message types |
| `…/shared/migrations` | Idempotent config-dir migrations (`migrateKeyLayout`, `migrateConfigDir`) |
| `…/remote/server` | Daemon entry point. Resolve its path and run it with `node`; it isn't a library API. |
| `…/remote/caller-bootstrap` | `CALLER_ALIAS_REGEX` and caller creation and issuance helpers |
| `…/remote/admin-types` | Admin API types, including the caller bundle format (`CallerBundleV1`) |

## Development

```bash
npm install               # also builds (prepare script)
npm run build             # tsc + copy connection templates + build the dashboard
npm test                  # unit tests (vitest); npm run test:e2e for live-API tests (.env.e2e)
npm run lint              # eslint src/
npm run format            # prettier
npm run dev:remote        # daemon via tsx, config in ~/.drawlatch-dev
npm run dev:mcp           # MCP server via tsx, config in ~/.drawlatch-dev
```

```
bin/drawlatch.js          CLI
src/mcp/server.ts         local MCP stdio server
src/remote/server.ts      daemon: handshake, /request, webhooks, dashboard, admin API
src/remote/tool-dispatch.ts   tool implementations shared by MCP and the admin API
src/remote/ingestors/     WebSocket, webhook and poll listeners
src/connections/<category>/<name>.json   built-in connection templates
src/shared/               config, secrets, crypto, handshake protocol
src/auth/                 dashboard password and sessions
frontend/                 React + Vite dashboard (built to frontend/dist)
```

## License

MIT
