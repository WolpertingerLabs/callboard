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
| `secure_request` | HTTP request to an allowlisted URL. Connection headers are injected for you. `${VAR}` placeholders in the URL and headers resolve server-side from the matched connection's secrets (in the body only if the connection sets `resolveSecretsInBody`). Secrets the connection injects itself are [withheld](#header-only-secrets): a request that references one is rejected, and their values are scrubbed from the response body. Redirects are followed only within the connection's allowlist ([Redirects](#redirects)). On an [OAuth2](#oauth2-token-minting) connection the daemon mints the access token itself, and a request may not send `Authorization` or an `access_token` query parameter. `${vault:<name>}` placeholders resolve from the caller's own [vault](#vault) items (and `${vault:<owner>/<name>}` from another caller's item [shared with it](#access-requests-and-grants)) in the URL path and query and in headers (in the body only with `resolveSecretsInBody`); an unusable one fails the request before anything is sent, and injected values are scrubbed from the response ([Using vault items in requests](#using-vault-items-in-requests)). Supports multipart uploads from local files (25 MB per file, 50 MB per base64-encoded request): with `files`, the JSON `body` is sent as a form part named `payload_json` (change it with `bodyFieldName`). Also takes a per-call `timeoutMs`. |
| `list_routes` | The caller's connections: docs links, allowed endpoint patterns, the *names* of secrets that are set, auto-injected header names, `withheldSecretNames` (secrets the connection uses itself, which a request may not reference), `awsSigV4` settings, `auth` (`{ "type": "oauth2", "grant", "scopes", "delegated"? }` on an [OAuth2](#oauth2-token-minting) connection, with the scopes after the caller's override, and `delegated: true` when a service account acts as a user; never a token, expiry, or who the user is), timeouts, listener info. |
| `test_connection` | Run a connection's built-in credential check. Some cost a little credit; see [CONNECTIONS.md](CONNECTIONS.md#available-connections). On an [OAuth2](#oauth2-token-minting) connection it mints a token first and reports `oauth2: { tokenMinted, requestedScopes, grantedScopes, missingScopes }` (scope names only); without a test request that is the whole test. |
| `list_connection_templates` | All built-in templates, with which are enabled for this caller and which secrets are set (booleans). Custom connectors aren't listed. Each entry's `selfManageable` says whether the two tools below will work for this caller. |
| `set_connection_enabled` | Enable or disable a connection for this caller. Refused when the caller has `selfManage: false`. Enabling an [OAuth2](#oauth2-token-minting) connection is always refused to the agent, whatever `selfManage` says; disabling one is allowed. |
| `set_secrets` | Set or delete (empty string) this caller's secrets. Write-only. Refused when the caller has `selfManage: false`. A call that sets or deletes a signing credential is always refused to the agent, and nothing in it is written. That means a name in any [OAuth2](#oauth2-token-minting) connection's `secretRefs` or an [AWS SigV4](#aws-sigv4-signing) connection's signing keys, built-in or custom, plus any variable such a secret's value refers to (`RT` defined as `${ACME_REFRESH}` makes `ACME_REFRESH` refused too). |
| `get_secret_status` | Which required and optional secrets are set for a built-in connection (booleans). |
| `poll_events` | Read buffered listener events after a cursor. |
| `ingestor_status` | State, buffer size, event counts, and errors for this caller's listeners. |
| `control_listener` | Start, stop, or restart a listener. |
| `list_listener_configs` | Configurable listener fields per connection. |
| `get_listener_params` / `set_listener_params` | Read or change listener parameters. |
| `resolve_listener_options` | Fetch dynamic choices for a listener field (for example, your Trello boards). |
| `list_listener_instances` / `delete_listener_instance` | Manage multi-instance listeners. |
| `test_ingestor` | Check a listener's configuration and credentials. |
| `vault_list` | This caller's [vault](#vault) items: name, kind, exposure, field names, notes, tags, metadata, `connections` binding, timestamps. Never values. Takes an optional `tag` filter. Returns `{ items, shared }`: `shared` lists other callers' items [granted](#access-requests-and-grants) to this caller, as `{owner, name, kind, fields, mode, connections?}` with the effective `mode`. |
| `vault_create` | Save a new vault item (`name`, `kind`, `values`, and optional `exposure`, `notes`, `tags`, `metadata`, `connections`). Fails if the name exists. Returns the item's metadata. |
| `vault_update` | Change a vault item. `values` replaces the whole value map, `rename` renames it. The agent can only tighten an item: `exposure` may go from `reveal` to `inject` but not back, and `connections` may only narrow. |
| `vault_delete` | Delete a vault item. |
| `vault_get` | The values of a `reveal` item (or one `field`), or with `owner` of another caller's item granted to this caller at effective mode `reveal`. Each call is written to the owner's audit log before the value is returned, and fails if that write fails. `inject` items, and other callers' items without a reveal grant, are refused: use an `inject` item as `${vault:<name>}` (or `${vault:<owner>/<name>}`) in `secure_request`. |
| `vault_request_access` | Ask the operator for access to another caller's item (`owner`, `name`, `reason`, optional `mode`: `inject`, the default, or `reveal`). Returns `{requestId, status: "pending"}` whether or not that caller or item exists, or `status: "granted"` when a grant already covers it. Grants nothing itself ([Access requests](#access-requests-and-grants)). |
| `vault_list_requests` | This caller's own access requests: `id`, `owner`, `itemName`, `mode`, `status`, `createdAt`, and `decidedAt` / `decidedNote` once decided. |
| `vault_cancel_request` | Cancel one of this caller's pending requests (`requestId`). |

`set_secrets` and `set_connection_enabled` let an agent change its own caller's configuration, which can grant it more access: secrets resolve per caller by name, so a connection the agent enables for itself starts with any secret it shares a name with (a second `google-*` connector picks up the existing `GOOGLE_API_TOKEN`). The agent still can't read secret values or reach URLs outside the allowlists, and OAuth2 connections are operator-only even with `selfManage` allowed: the agent can't enable one or set its credentials, because OAuth2 credentials are shared by name (every user-OAuth `google-*` template reads `GOOGLE_OAUTH_REFRESH_TOKEN`). Set [`selfManage: false`](#callers) on a caller to refuse both tools to its agent. The dashboard can still make the change. Callers that drawlatch creates (dashboard **New caller**, `issue-caller` for a new alias, local Callboard provisioning) start with `selfManage: false`. A caller entry without the field allows both tools, so existing configs behave as before.

The daemon also accepts `wait_for_events`, a long-poll over all of a caller's event streams. The local MCP server doesn't expose it; long-running clients such as Callboard call it over the encrypted channel. See [INGESTORS.md](INGESTORS.md#reading-events).

It likewise accepts `ingest_logs`, which appends records to the caller's audit log. The local MCP server doesn't expose it either. See [Audit log](#audit-log).

The vault tools aren't gated by `selfManage`: they touch only the caller's own vault, and reaching another caller's item takes a grant that only the operator can give. No tool grants, denies, or revokes access.

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
vault.enc.json         encrypted vault, created on the first save (see Vault)
keys/vault.key         the vault's key, mode 0600, created with vault.enc.json (SENSITIVE)
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
| `connections` | Required. Built-in connection names or custom connector aliases. See [Overlapping connections](#overlapping-connections) for two whose allowlists overlap. |
| `name` | Display name for logs and the dashboard. |
| `env` | Per-caller secret values (see [Secrets](#secrets)). |
| `ingestorOverrides`, `listenerInstances` | Listener settings ([INGESTORS.md](INGESTORS.md#per-caller-listener-settings)). |
| `triggerRules` | Forward matching events to Claude Code remote triggers ([INGESTORS.md](INGESTORS.md#trigger-rules-experimental)). |
| `selfManage` | Whether the caller's agent may run `set_connection_enabled` and `set_secrets` on itself ([MCP tools](#mcp-tools)). Absent means `true`. Callers drawlatch creates are written with `false`. The admin API and dashboard aren't affected. |
| `oauth2Overrides` | Per-connection [OAuth2](#oauth2-token-minting) settings: `{ "<alias>": { "scopes": [...], "subject": "user@example.com" } }`. `scopes` narrows the requested scopes and must be a non-empty subset of the connection's `oauth2.scopes`. `subject` is the user a `jwt_bearer` (service-account) connection acts as, through domain-wide delegation; it replaces a connector's `oauth2.subject`. An invalid entry drops that connection for this caller and is logged at boot. Only `remote.config.json` sets it: no tool can write it, and the dashboard only displays it. |

Caller public keys are read from `keys/callers/<alias>/`. Aliases must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`.

### Secrets

Connections reference secrets as `${NAME}` (for example, `${GITHUB_TOKEN}`). For caller `<alias>`, the daemon looks up `NAME` in this order:

1. A literal value in the caller's `env` map: `"env": { "GITHUB_TOKEN": "ghp_..." }`.
2. The environment variable `<ALIAS>_<NAME>`, with the alias uppercased and `-` replaced by `_`. Examples: `DEFAULT_GITHUB_TOKEN`, `MY_AGENT_GITHUB_TOKEN`.

A bare `GITHUB_TOKEN` is never used. This keeps one caller from picking up another's credentials. The daemon loads `.env` at startup, so restart after editing it by hand. The dashboard and `set_secrets` write `<ALIAS>_<NAME>` to `.env` and apply the change immediately.

Agents can also keep their own secrets in a per-caller, encrypted [vault](#vault). Vault items are separate from connection secrets: they don't resolve as `${NAME}`. A request uses them as `${vault:<name>}` instead ([Using vault items in requests](#using-vault-items-in-requests)).

If a secret isn't set, its placeholder is sent literally (for example, `Authorization: Bearer ${GITHUB_TOKEN}`), and the upstream API will usually answer `401`. An [`awsSigV4`](#aws-sigv4-signing) connection without its signing keys fails the request instead of sending it. `drawlatch doctor`, `drawlatch config`, and the dashboard's Secrets page show what's missing. They check only built-in templates, and only secrets used in a template's headers or, for an `awsSigV4` or `oauth2` template, its signing keys or `secretRefs`: custom connectors are skipped, and a token that goes in the URL (Telegram, Trello) isn't flagged. `doctor` also prints the unprefixed name ("Set GITHUB_TOKEN in …/.env"); whatever it says, set `<ALIAS>_<NAME>` (`DEFAULT_GITHUB_TOKEN` for the default caller).

> **Known issue:** an `env` value that redirects to another variable, such as `"GITHUB_TOKEN": "${ALICE_TOKEN}"`, is ignored; the prefixed variable (`<ALIAS>_GITHUB_TOKEN`) is used if set. Status checks still report the redirected secret as set. Use a literal value or the prefixed variable instead.

#### Header-only secrets

A secret that a connection's own `headers` reference is **header-only**: it is injected into those headers, and nowhere else. A request may not reference it as `${NAME}` in its URL, its headers, or a `resolveSecretsInBody` body; such a request is rejected before anything is sent, and the daemon logs the connection and secret name. Upstreams echo identifiers back in error messages, so `GET https://www.googleapis.com/drive/v3/files/${GOOGLE_API_TOKEN}` would otherwise answer `File not found: ya29…` and hand the token to the agent.

Header-only secrets are one kind of **withheld** secret. The others are a webhook listener's `signatureSecret`, anything a connector lists in `withheldSecrets` (the `slack` template lists `SLACK_APP_TOKEN`, which Socket Mode reads directly), any secret whose value contains a withheld value of 4 or more characters, and [AWS SigV4](#aws-sigv4-signing) signing keys and [OAuth2](#oauth2-token-minting) credentials, which, unlike the others, don't resolve in `headers` or listener configs either: only drawlatch's signer or token manager reads them. `list_routes` reports them as `withheldSecretNames`. `placeholderSecrets` releases only header-only secrets, not the other kinds.

**Scrubbing.** Withheld values, and on an OAuth2 connection the minted access token (as `${OAUTH2_ACCESS_TOKEN}`), are replaced with `${NAME}` in response bodies, `statusText`, and listener output: buffered events (`poll_events`, `wait_for_events`, triggers) and `ingestor_status` errors, which are scrubbed of every secret.

- JSON bodies, including `+json` types such as `application/problem+json`, are parsed, and their string values and keys are scrubbed.
- Text bodies, headers, `statusText`, URLs and error messages are scrubbed of every form of the **whole** value that can appear on the wire:
  - as-is, and `encodeURIComponent`-encoded;
  - as a URL path serializes it (`'` and `|` kept, a space as `%20`, `"` as `%22`, `\` as `/`);
  - as a URL query serializes it (`'` encoded too);
  - form-encoded (a space as `+`), and as a form parser decodes the query form (a `+` as a space, and `%XX` escapes decoded, so a value written `%41%41%41%41` is also scrubbed as `AAAA`);
  - as UTF-8 read back as Latin-1 (how a non-ASCII header value can echo);
  - each of those JSON-string-escaped (with and without `\/`).
- Only whole values are scrubbed, never a piece of one, so ordinary text that happens to contain part of a secret (`Summer` from `Summer#2024!xyz`) is left alone. The catch, for `${VAR}` connection secrets: URL parsing cuts a value at a `#` and splits it at a `?` into path and query parts, and an `&` splits a query value into parameters. An upstream that echoes only one part (say, the decoded path) hands that part back as is. Don't put a connection secret containing `#`, `?` or `&` in a URL; send it in a header instead. [Vault values](#using-vault-items-in-requests) containing one are refused in a URL, so the gap doesn't apply to them.
- Scrubbing is best-effort defense in depth: base64, case-changed, or otherwise transformed copies aren't recognised, and values under 4 characters are never scrubbed.

Secrets a request may reference are left alone in bodies and events, since the caller can use them by design and many are ordinary values (`REDDIT_SUBREDDIT`, `TWITCH_USER_ID`) that appear in real responses. Values that are public but sent in a header are withheld too: Twitch's `Client-Id` and Reddit's `User-Agent` show up as `${TWITCH_CLIENT_ID}` and `${REDDIT_USER_AGENT}` in responses. A custom connector that needs them verbatim lists them in `placeholderSecrets`.

Built-in templates that authenticate in the URL keep working, because their tokens aren't in `headers`: Trello (`?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`) and Telegram (`/bot${TELEGRAM_BOT_TOKEN}/`). An upstream can still echo those back.

**Template requests.** `testConnection`, `testIngestor`, and `listenerConfig` option lookups come from the connection, not the agent. They run against their own connection only, may use withheld secrets (never signing keys), and their headers override the connection's headers of the same name, so Slack's listener test sends its app token instead of the bot token. Their responses are still scrubbed. Listeners also receive withheld secrets (the Discord gateway needs its bot token).

**Upgrading custom connectors.** A custom connector whose agents were told to write a header secret into a URL, body, or request header now has those requests rejected. If the API really needs the secret there, list it in `placeholderSecrets`. At startup the daemon logs a warning, and `drawlatch doctor` fails a check, for a connector whose `description`, `name`, or `listenerConfig.description` references a withheld secret, or whose `placeholderSecrets` entry can't take effect. It suggests `placeholderSecrets` only for a secret withheld because the headers use it; the other kinds can't be released.

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
| `allowedEndpoints` | Required. URL globs: `*` matches within a path segment, `**` across segments. An entry starting with `!` is an exclusion: a URL it matches is refused even when another entry allows it (the Calendar templates use `!…/events/watch` next to `…/events/*`). Exclusions are also checked with unreserved percent-escapes decoded (`w%61tch` is `watch`), and only subtract: a list of nothing but exclusions allows nothing. A URL's fragment (`#…`) is never matched or sent: fetch would drop it anyway, so `…/events/watch#x` is `…/events/watch`. An empty list matches nothing. Matched against the request URL in parsed form (see below). |
| `headers` | Headers injected into every request. `${VAR}` resolves against `secrets`. A request that sets the same header itself is rejected. |
| `awsSigV4` | Sign every request with AWS Signature Version 4: `{}`, or `{ "service": "…", "region": "…" }` to override what's inferred from the hostname. See [AWS SigV4 signing](#aws-sigv4-signing). |
| `oauth2` | Mint the bearer token from OAuth2 client credentials instead of a static header. See [OAuth2 token minting](#oauth2-token-minting). |
| `secrets` | `NAME → value`. The value is a literal, or `${VAR}` resolved per caller as in [Secrets](#secrets). A secret referenced in `headers` is [header-only](#header-only-secrets). |
| `withheldSecrets` | Extra secret names to withhold from request URLs, headers, and bodies, like header-only ones. They still resolve in `headers` and listener configs. |
| `placeholderSecrets` | Header secrets that requests may also reference as `${NAME}`, for an API that needs the same credential in a header and the URL or body. The upstream can echo these back. Releases only header-only secrets, not a `signatureSecret`, a `withheldSecrets` entry, or SigV4 signing keys. |
| `resolveSecretsInBody` | Resolve `${VAR}` in request bodies. Default `false`, which stops an agent from writing a placeholder into a resource and reading the secret back. |
| `requestTimeoutMs` | Default outbound timeout for this API, and the most a caller may request (see [Request timeouts](#request-timeouts)). |
| `name`, `description`, `docsUrl`, `openApiUrl` | Shown to agents by `list_routes`. |
| `testConnection`, `ingestor`, `listenerConfig`, `testIngestor` | Credential test and event listener definitions. Built-in templates in `src/connections/` are the reference. |

**Upgrading: URL matching.** Request URLs are matched, and sent, in the form the URL parser produces (see [Security model](#security-model)). A pattern's scheme and host are compared the same way (case-insensitive, `:443`/`:80` and a trailing dot ignored), so `https://API.example.com:443/**` keeps working. Paths and queries are not rewritten in patterns, though, and the parser percent-encodes some characters in requests: a space becomes `%20`, `{` and `}` become `%7B`/`%7D`, `"`, `<`, `>` and `` ` `` are encoded, and `'` is encoded in the query. A custom pattern that spells one of those literally (`https://api.example.com/search?q=a b*`) no longer matches; write the encoded form (`q=a%20b*`) or use a wildcard.

#### AWS SigV4 signing

AWS APIs need a signature computed per request, so a static header can't authenticate them. A connector with `awsSigV4` gets one from the daemon instead. After the URL, headers, and body are final, the daemon signs the exact bytes it sends and adds `Authorization`, `X-Amz-Date`, `X-Amz-Content-Sha256` (the SHA-256 of the body), and `X-Amz-Security-Token` when a session token is set. The built-in [`aws`](CONNECTIONS.md#notes-by-connection) template uses it.

- **Credentials** are the connector's `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets, plus `AWS_SESSION_TOKEN` for temporary credentials. They resolve per caller like any other secret, so `"AWS_ACCESS_KEY_ID": "${PROD_AWS_ACCESS_KEY_ID}"` in `secrets` points a connector at different variables. The first two count as required. If either is missing, the request fails without being sent. Only the signer reads these three. They, and any other secret whose value contains one of them, are never substituted for `${VAR}` in a URL, a header, a connector's own `headers`, a body with `resolveSecretsInBody`, or a listener's requests; a request that references one is rejected.
- **Service and region** come from the request hostname: `<service>.<region>.amazonaws.com`, `<id>.<service>.<region>.amazonaws.com` (API Gateway, SageMaker runtime), `<id>.<region>.<service>.amazonaws.com` (OpenSearch), interface VPC endpoints (`vpce-….<service>.<region>.vpce.amazonaws.com`), and S3's virtual-hosted, path-style, dual-stack, and legacy `s3-<region>` hosts, with `s3-outposts` and `s3-object-lambda` as their own signing names. A global endpoint such as `sts.amazonaws.com` or `iam.amazonaws.com` signs for `us-east-1`, and `iam.us-gov.amazonaws.com` for `us-gov-west-1`. A few endpoint prefixes map to a different signing name (`bedrock-runtime` and `bedrock-agent*` → `bedrock`, `email` → `ses`, `aps-workspaces` → `aps`). For anything else, set `service` and `region` explicitly, which overrides the inference for every request on that connector.
- **Reserved names.** A request may not set `Authorization`, `Host`, `X-Amz-Date`, `X-Amz-Content-Sha256`, or `X-Amz-Security-Token`, or carry presigned-URL query parameters (`X-Amz-Signature`, `X-Amz-Credential`, and so on). Such a request is rejected. Other `x-amz-*` headers, such as `X-Amz-Target` or `x-amz-meta-*`, are sent and signed.
- **What's signed:** `host`, every header sent except hop-by-hop ones (`connection`, `user-agent`, `content-length`, and similar), and the body. A string body is sent as UTF-8, with fetch's default `text/plain;charset=UTF-8` content type unless you set one. Multipart uploads are serialized before signing. Paths are normalized and encoded per segment as SigV4 requires. S3 paths are encoded once and not normalized. S3 keys with a `.` or `..` path segment (including `%2E%2E` forms) are unsupported: every request with one is refused before it is parsed or signed (see [Security model](#security-model)).
- **Redirects** aren't followed, even to the same host: the signature covers the original URL. A 3xx comes back to the caller with its `Location` header (see [Redirects](#redirects)).

#### OAuth2 token minting

A connector with an `oauth2` block gets its `Authorization: Bearer` token from the daemon, which runs an OAuth2 grant against the provider's token endpoint and caches the result. The agent never sees the client credentials, the refresh token, the service-account key, or the minted access token. The scoped Google templates (`google-gmail-readonly`, `google-drive-readonly-sa`, …) are built on this; see [CONNECTIONS.md → Google (scoped)](CONNECTIONS.md#google-scoped).

```json
{
  "connectors": [
    {
      "alias": "acme",
      "allowedEndpoints": ["https://api.acme.example/v2/**"],
      "secrets": {
        "ACME_CLIENT_ID": "${ACME_CLIENT_ID}",
        "ACME_CLIENT_SECRET": "${ACME_CLIENT_SECRET}",
        "ACME_REFRESH_TOKEN": "${ACME_REFRESH_TOKEN}"
      },
      "oauth2": {
        "tokenUrl": "https://auth.acme.example/oauth/token",
        "grant": "refresh_token",
        "clientAuth": "body",
        "secretRefs": {
          "clientId": "ACME_CLIENT_ID",
          "clientSecret": "ACME_CLIENT_SECRET",
          "refreshToken": "ACME_REFRESH_TOKEN"
        },
        "scopes": ["items.read", "items.write"]
      },
      "testConnection": { "url": "https://api.acme.example/v2/me" }
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `tokenUrl` | Required. The token endpoint. Must be `https` (`http` only on `localhost`, `127.0.0.1`, or `[::1]`). |
| `grant` | Required. `refresh_token` (user OAuth: trade a long-lived refresh token for access tokens), `client_credentials` (the client acting as itself), or `jwt_bearer` (a Google service account: a signed JWT assertion, [below](#service-accounts-jwt_bearer)). |
| `clientAuth` | Required for `refresh_token` and `client_credentials`, not allowed with `jwt_bearer`. `basic` sends `Authorization: Basic base64(client_id:client_secret)`; `body` sends `client_id` and `client_secret` as form fields. |
| `secretRefs` | Required. Names of keys in `secrets`: `clientId` and `clientSecret` (not for `jwt_bearer`), `refreshToken` (`refresh_token` only), `serviceAccountKey` (`jwt_bearer` only). |
| `scopes` | Scopes to request. Sent as `scope` on every grant, sorted and de-duplicated (for `jwt_bearer`, as the assertion's `scope` claim, and required). |
| `verifyGrantedScopes` | Refuse a token whose response doesn't say which scopes it grants. Default `true` when `scopes` is set, except for `jwt_bearer` (default `false`: its scopes are bound by the signed assertion, and the response may omit them; scopes it does report are still checked). |
| `subject` | `jwt_bearer` only: the user to act as (the JWT `sub`, domain-wide delegation). An email address. Custom connectors only: a built-in template may not set it. Per caller, use `oauth2Overrides`. |
| `subjectRequired` | `jwt_bearer` only: the connection is dropped for any caller without a `subject` (logged at boot). The `google-gmail-readonly-sa` template sets it. |
| `refreshSkewMs` | Mint a new token this long before the cached one expires. Default `300000`, at most `3600000`. For each token it is capped at half the token's lifetime, so short-lived tokens aren't re-minted on every request. |

Unknown fields are rejected. An invalid block on a built-in template fails when it loads; on a custom connector it drops that connection for each caller, with a message in the daemon log at boot.

- **Credentials are signer-only.** Every `secretRefs` secret, and any secret whose value contains one, is never substituted for `${VAR}` anywhere: not in a request URL, header, or body, not in the connector's own `headers`, not in a listener config. A request that references one is rejected. They count as required secrets for a built-in template.
- **Not combinable** with an `Authorization` entry in `headers`, a header that references a credential, `awsSigV4`, or `resolveSecretsInBody`. No `allowedEndpoints` pattern may match the token endpoint URL: checked against the URL with a query, with a trailing slash, and with its host written with or without a trailing dot. Other paths on the same host are fine (Dropbox, Box, and X serve their API and token endpoint from one host). A pattern without `scheme://host` matches every host and is refused. Only a `poll` listener is allowed: a webhook or websocket listener would make its own requests (webhook auto-registration, a gateway connect) without the token, so it is refused until supported.
- **Requests:** a request may not send `Authorization` (any case) or an `access_token` query parameter. The token is minted after every other check, so a rejected request never mints one.
- **Scopes:** a token whose granted `scope` includes anything not requested is refused, whatever `verifyGrantedScopes` says, and so is one without `scope` when verification is on. Fewer scopes than requested is accepted, and `test_connection` lists the missing ones. Per caller, [`oauth2Overrides`](#callers) narrows the requested scopes; widening them takes a custom connector.
- **Caching:** tokens are kept in memory only, per caller, connection, grant, token URL, credentials, and scopes, so rotating a secret or changing scopes mints a new token instead of serving the old one. Verification and skew settings are part of the key too. A rotated refresh token returned by the provider is used until the configured one changes; it is lost on restart, and forgotten after 30 days unused. Concurrent requests for the same token share one token-endpoint call, and `refresh_token` requests that share a refresh token (two callers, two connections, two scope sets) go one at a time, each sending the latest rotation, so a provider that rotates (or revokes a reused token's family) never sees the same refresh token twice.
- **Retries:** a `401` from the API mints a fresh token and resends the request once. It doesn't when the current token is under 30 s old (an agent can make any allowlisted URL answer `401`, and must not be able to turn that into a token request per call) or when another request already replaced the token that got the `401`; the `401` is returned as is. Anything else, `403` included, isn't retried. A `403` result carries a `hint` naming the token's scopes.
- **Scrubbing:** the minted token is replaced with `${OAUTH2_ACCESS_TOKEN}` in response bodies, headers, the final URL, and error messages, like a [withheld secret](#header-only-secrets).
- **Token endpoint:** called without following redirects, with a timeout, and reading at most 64 KiB of response. Errors name the connection, the HTTP status, and a recognised OAuth2 error code (`invalid_grant`, `invalid_scope`, `invalid_client`, `unauthorized_client`, `access_denied`, `admin_policy_enforced`, Google's `invalid_rapt`) with a fixed hint. They never include the response body. Those codes are terminal: the same credentials aren't tried again for 60 s.
- **Listeners:** poll listeners on an `oauth2` connection get managed tokens too ([INGESTORS.md](INGESTORS.md#polling)). Other listener types are refused (see above).
- **Overlapping connections:** if more than one of a caller's connections matches a request URL and any of them is OAuth2, the request is refused with an error naming them, rather than using whichever is listed first. See [Overlapping connections](#overlapping-connections).

##### Service accounts (`jwt_bearer`)

The daemon signs an RS256 JWT assertion with the service-account key ([RFC 7523](https://www.rfc-editor.org/rfc/rfc7523)) and exchanges it at `tokenUrl` for an access token; there is no refresh token.

- **Key format:** the `serviceAccountKey` secret holds base64 of the JSON key file (`base64 -w0 key.json`), which survives `.env` files and the dashboard's single-line input. The JSON itself is accepted too, including after a `.env` round trip has turned its `\n` escapes into real newlines. A malformed key fails with one fixed message naming only the secret, never its content. Only the signer reads the key: like every `secretRefs` secret it is never substituted anywhere.
- **Claims:** `iss` is the key's `client_email`, `scope` the connection's scopes, `aud` the connection's `tokenUrl` (never the key file's `token_uri`), `iat` now, and `exp` an hour later. `sub` is present only when `subject` is set, which only admin config can do: a custom connector's `oauth2.subject` or the caller's `oauth2Overrides[alias].subject`.
- **Caching:** the token cache key includes the subject and a fingerprint of `client_email`, `private_key_id`, and a hash of the private key, so a new key or subject mints a new token.
- **Errors** carry service-account hints: `unauthorized_client` means the service account isn't authorized for domain-wide delegation in the Admin console; `access_denied` means the requested scopes aren't authorized for its client ID there; `invalid_grant` means the key is revoked, the subject isn't a user in the domain, or the daemon's clock is off.

| Constant (`src/shared/config.ts`) | Value | Meaning |
| --- | --- | --- |
| `OAUTH2_TOKEN_TIMEOUT_MS` | `10000` | Longest one token-endpoint request may take. A request's remaining budget can make it shorter. |
| `OAUTH2_TERMINAL_BACKOFF_MS` | `60000` | How long a terminal token failure is remembered before the same credentials are tried again. Changing a secret or scopes clears it. |
| `DEFAULT_OAUTH2_REFRESH_SKEW_MS` | `300000` | Default `refreshSkewMs`. |
| `MAX_OAUTH2_REFRESH_SKEW_MS` | `3600000` | Largest `refreshSkewMs` accepted. |
| `OAUTH2_MIN_REMINT_INTERVAL_MS` | `30000` | A `401` doesn't re-mint a token younger than this. |
| `OAUTH2_ROTATED_TOKEN_IDLE_MS` | `2592000000` (30 days) | A rotated refresh token unused this long is forgotten. |
| `OAUTH2_TOKEN_RESPONSE_MAX_BYTES` | `65536` | Largest token-endpoint response read. |

#### Overlapping connections

A request goes to the first of the caller's connections whose `allowedEndpoints` match its URL, in `connections` order. When two connections can match the same URL, that order silently decides which credential the request carries.

- The daemon logs a warning at boot for each pair of a caller's connections with a pair of allowlist patterns that can match a common URL, naming the patterns. Hosts are compared as globs and paths by their literal prefix up to the first wildcard; a wildcard host on both sides, or a pattern without `scheme://host`, counts as overlapping. Among the built-in templates, the overlapping ones are alternatives for one API: `discord-bot` and `discord-oauth`; the static `google` and any scoped `google-*` template; two scoped templates for one Google service (`google-gmail-metadata` and `google-gmail-readonly`, a template and its `-sa` twin). Enable one per caller. Scoped templates for different services (`google-calendar-readonly` and `google-drive-readonly`, both on `www.googleapis.com`) don't overlap.
- If an [OAuth2](#oauth2-token-minting) connection is among the matches for a request, the request is refused with an error naming the connections. Narrow the allowlists or remove one of the connections. The check compares the URL in parsed form, so host case, an explicit default port, or a trailing dot don't dodge it, but it is best-effort: a path spelled differently (`/%63alendar/` for `/calendar/`) matches patterns only as written, so don't rely on the refusal to keep two connections apart. Non-overlapping allowlists do.
- Between connections without OAuth2, the first match still wins, as before.

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
- On an [OAuth2](#oauth2-token-minting) connection, minting the token (and re-minting after a `401`) comes out of the same deadline as the API call, and a single token request is further capped at `OAUTH2_TOKEN_TIMEOUT_MS` (10 s). `test_connection` does the same: its test request gets what minting left of the budget.
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

`awsSigV4` connections never follow redirects, and an OAuth2 token endpoint is never followed either. Listener requests (polls, webhook auto-registration, Slack Socket Mode connect) and trigger dispatch follow redirects only on the request URL's own origin; see [INGESTORS.md](INGESTORS.md#polling).

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

The `drawlatch.*` fields are set by the daemon: the caller is the authenticated session's, `sequence` counts up within each file, and `source` is `client` for caller records. The daemon's own lines (`quota_exceeded` below, and [vault events](#vault)) have `source: "daemon"`. Everything else is what the client sent, flattened (attribute lists become objects, `AnyValue`s become plain JSON; an `intValue` too big for a JSON number stays a string). Optional fields are left out when absent. Use `jq`, for example `jq -c 'select(.trace_id == "…")' ~/.drawlatch/audit/*/*.jsonl`.

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

### Vault

Each caller has its own vault: named items (passwords, tokens, notes, key/value sets) that its agent saves and manages with the `vault_*` [MCP tools](#mcp-tools). A caller sees only its own items, plus the items the operator has [shared with it](#access-requests-and-grants). No tool lists or changes another caller's vault.

**Items.** An item has a `name` (1-64 letters, digits, `_` or `-`, starting with a letter or digit, unique within the caller's vault; `constructor` and `prototype` are reserved), a `kind`, secret `values`, and plain-text `notes`, `tags`, and `metadata`:

| `kind` | `values` fields |
| --- | --- |
| `token`, `note` | exactly `value` |
| `password` | `value`, and optionally `username` |
| `key-value` | 1-16 fields named `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` |

Everything in `values` is secret, `username` included, and only field names ever leave the daemon. `notes`, `tags`, and `metadata` are not secret: `vault_list` returns them, so don't put secrets in them. An item also has a stable `id` (it survives a rename), `createdBy` (`agent` or `admin`), `createdAt`, `updatedAt`, and `valueUpdatedAt` (the last change to `values`), and an optional `connections` list: the connections the item may be used on ([binding](#using-vault-items-in-requests)).

**Exposure.** `inject` (the default) means no tool ever returns the value: not `vault_list`, not `vault_get`, not any other tool. `reveal` means the caller's agent can read it back with `vault_get`, and every such read is written to the caller's [audit log](#audit-log) first; if that write fails, `vault_get` fails and returns nothing. Items of either exposure can be used in requests as `${vault:<name>}` ([below](#using-vault-items-in-requests)).

**Agents can only tighten.** On the agent's side, `vault_update` may change `exposure` from `reveal` to `inject` but never back, and may add a `connections` list or narrow one but never widen or remove it. Otherwise an `inject` item could be switched to `reveal` and read. Only the operator can loosen an item, on the dashboard's [Vault page](#admin-dashboard) or through the admin API.

What the agent saves passes through its own context: `vault_create` and `vault_update` carry the values. `inject` keeps a saved value out of later responses, not out of the conversation that saved it. For a secret the agent should never see, create the item on the dashboard instead (**Vault → New item**): it is stored with `createdBy: "admin"` and the agent can only use it by reference.

**Limits** (errors name the field and the limit, never the value): 64 KiB per field, 128 KiB per item, 500 items per caller, 32 MiB for the whole vault; `notes` 4 KiB; 16 tags of up to 64 characters; 32 `metadata` entries, keys up to 64 and values up to 256 characters. Every field of an `inject` item must be at least 4 characters long.

**Storage.** The vault is one file, `vault.enc.json`, holding every caller's items in a single AES-256-GCM envelope:

```json
{"format":"drawlatch-vault","version":1,"alg":"aes-256-gcm","keyId":"3fa1c09e7b2d4e51",
 "iv":"…","tag":"…","ciphertext":"…"}
```

Item names, notes, and tags are encrypted too; only the header is plain. The key is `keys/vault.key`: 32 random bytes, base64 on one line, mode `0600`. The daemon creates both files on the first successful save, not at `init` or startup, and never creates a key while `vault.enc.json` exists. `keyId` is a public fingerprint of the key (the first 8 bytes of a SHA-256 over it), so a file paired with the wrong key fails with a key-id message rather than a decryption error. Every save writes a temporary file (mode `0600`) and renames it over the old one, so a crash leaves the old vault or the new one, never a torn file, and nothing on disk is ever plaintext. Only the daemon reads or writes the vault; two daemons on one config dir aren't supported (the PID file prevents it).

If `keys/vault.key` is missing while `vault.enc.json` exists, every vault tool fails with `Vault key keys/vault.key is missing; restore it from backup.` and everything else keeps working. A key file readable by group or others is refused with the `chmod` to fix it. A vault file from a newer drawlatch is refused. `drawlatch doctor` checks that the key is present when the file is, that the key is `0600`, and that the file decrypts, and prints the key id and item count (never the key).

**Backup and key loss.**

- Back up `vault.enc.json` anywhere: it's useless without the key.
- Back up `keys/vault.key` **separately**, for example in a password manager (`cat ~/.drawlatch/keys/vault.key` is a single base64 line). Anyone with both files can read every caller's vault.
- **Lose the key and the vault is gone.** There's no recovery. To start over, move the old file aside (`mv vault.enc.json vault.enc.json.lost`); the next save creates a new key and an empty vault.
- Syncing the whole config dir also syncs the key (and `.env`, which is already plaintext). Exclude `keys/` from sync if you want the vault backup to be safe.

**Deleting a caller** (dashboard, `DELETE /api/admin/callers/:alias`) deletes its vault items too, revokes every grant to or from it, withdraws every pending request by it or for its items, and drops its own request history, so a new caller with the same alias starts empty and inherits no access. If the vault can't be read (its key is missing, say), the deletion fails and the caller is left in place.

**Audit events.** Vault events are daemon lines (`drawlatch.source: "daemon"`) in the **owner's** audit log, whoever acted. They carry `vault.owner`, `vault.item` (the name at the time), `vault.item_id`, `vault.actor` (a caller's alias, or `admin` for the dashboard), and `vault.via` (`mcp` or `admin`), plus:

| `drawlatch.event` | Extra fields |
| --- | --- |
| `vault.item.created`, `vault.item.updated`, `vault.item.deleted` | `vault.kind`, `vault.exposure`, `vault.fields` (names), `vault.changed` (which properties an update set), `vault.renamed_from` |
| `vault.reveal` | `vault.fields` revealed; `vault.grant_id` when another caller read it through a grant |
| `vault.inject` | `vault.grantee`, `vault.grant_id`, `vault.connection`, `vault.fields`: another caller used the item in a request (own-item uses aren't logged per request) |
| `vault.request.created`, `.cancelled`, `.denied`, `.withdrawn` | `vault.request_id`, `vault.requester`, `vault.mode`, `vault.reason` (agent-written, at most 1 KiB), `vault.note` (the operator's deny note) |
| `vault.grant.created`, `vault.grant.revoked` | `vault.grant_id`, `vault.grantee`, `vault.mode`, `vault.request_id`, `vault.revoked_reason` |

Request events are written only when the owner has a vault, so a request naming a made-up caller creates no audit directory. Events never carry a value, ciphertext, or key, and don't count against the caller's `ingest_logs` byte budget.

#### Using vault items in requests

A `secure_request` can reference the caller's own vault items. The daemon substitutes the value on the way out, and the value never comes back to the agent:

| Placeholder | Resolves to |
| --- | --- |
| `${vault:<name>}` | The item's `value` field. An item without one (a `key-value` item can have none) needs an explicit field. |
| `${vault:<name>.<field>}` | That field, for example `${vault:login.username}`. |
| `${vault:<owner>/<name>}`, `${vault:<owner>/<name>.<field>}` | Another caller's item, when an active [grant](#access-requests-and-grants) shares it with this caller (at either mode). The caller's own alias as `<owner>` means its own item. |

Names, owners, and fields can't contain `/`, `.`, `:`, or `}`, so a placeholder parses only one way.

| Where in the request | `${vault:…}` |
| --- | --- |
| URL path and query | Resolves, unless the value contains `#`, `?` or `&`, which is refused. |
| URL scheme, user info, host, port | Refused: `a vault placeholder can't choose the host`. |
| Request headers | Resolves. |
| Body (string, JSON, multipart `payload_json`) | Resolves only when the connection sets `resolveSecretsInBody`, the same rule as `${VAR}`. Otherwise it's sent as written. In a body given as an object, the value is JSON-escaped. |
| `files`, `bodyFieldName` | Never: sent as written. |
| Connection headers, template requests (`test_connection`, `test_ingestor`, `resolve_listener_options`), listener configs and params | Never: sent as written. |

- **Checked before sending.** Every placeholder in a position where it resolves is looked up before anything is sent, OAuth2 token minting included. A placeholder for an item that doesn't exist, a field the item lacks, a malformed placeholder, another caller's item that isn't shared with the caller, or an item bound to other connections fails the request with the position, the placeholder, and the reason, for example `Header "X-Key" references ${vault:nope}, which can't be used: no such item "nope" in your vault.` Unlike an unknown `${VAR}`, an unknown vault placeholder is never sent literally. A request without one doesn't read the vault at all, so it works even when the vault key is missing.
- **No URL delimiters in a URL.** A value containing `#`, `?` or `&` is refused in the URL path or query, before anything is sent: `The request URL references ${vault:pw}, which can't be used: it contains a URL delimiter (#, ? or &); send it in a header instead.` URL parsing would cut such a value or split it across components, and an echo of one piece couldn't be scrubbed. The message never says which character. The same value works in a header, or in a body where the connection resolves placeholders.
- **One pass.** `${VAR}` and `${vault:…}` placeholders are substituted together, over the string as written. A vault value containing `${GITHUB_TOKEN}` is sent as is, and so is a connection secret containing `${vault:x}`. `${VAR}` placeholders work as before: withheld ones are refused, unknown ones are sent literally.
- **Same checks after.** The substituted request goes through every usual check: the URL is matched against the allowlist again (a value that adds a `..` segment is refused), header values with a carriage return, newline, or NUL are refused by header name, and SigV4 signs the final request.
- **Scrubbing.** Every substituted value, `reveal` items included, is handled like a [withheld secret](#header-only-secrets). It's replaced with `${vault:<owner>/<name>.<field>}` (for example, `${vault:alice/gh-token.value}`) in the response body, headers, `statusText`, the final URL after redirects, and error messages, in every whole-value wire form listed under [Scrubbing](#header-only-secrets), so an upstream that echoes the request URL as it received it doesn't hand the value back. A header carrying one is dropped on a cross-origin redirect, and a body carrying one isn't resent to another origin by a 307 or 308. Scrubbing is best-effort in the same way, and skips values under 4 characters (only a `reveal` item can have one).
- **Binding.** When an item has a `connections` list, it resolves only on those connections: `item "gh-token" is not allowed on connection "slack" (it is bound to "github")`. Without one, it resolves on any connection the caller has. An agent can add or narrow a binding, never widen or remove it.
- **Round trips.** Scrubbing covers echoes in the same response only. An agent can still write an injected value into a resource on an API that accepts writes (a card titled with `${vault:x}` through a query parameter, say) and read it back in a later request. Trello's and Telegram's URL tokens have the same gap. Bind a sensitive `inject` item to the one connection that needs it.
- Before this version `${vault:…}` meant nothing and went out literally. A request that still contains one where it resolves is now refused unless the item exists.
- **Another caller's item.** Without an active grant, the request fails with one answer whether or not the item exists: `no such item "gh" shared with you by "alice" (using another caller's item needs a grant from the operator; ask with vault_request_access)`. Each use is written to the owner's audit log as `vault.inject` before anything is sent; if that write fails, the request fails and nothing is sent. Right before sending, the daemon checks the vault again, so a revoke, delete, rename, rebind, or value change that lands while the request is being prepared fails it rather than sending past it. The item's `connections` binding applies to the grantee too.
- Own-item uses aren't written to the audit log per request. The daemon's `[audit]` request line names the tool, not the values.

#### Access requests and grants

An agent can **ask** for another caller's item. Only the operator, on the dashboard, can approve.

1. bob's agent calls `vault_request_access` with `owner: "alice"`, `name: "forgejo-token"`, a `reason`, and optionally `mode: "reveal"` (the default is `inject`). It gets `{requestId, status: "pending"}`.
2. The request appears on the dashboard's **Vault → Requests** tab, with the reason labelled as text the requesting agent wrote.
3. The operator grants it (choosing the mode) or denies it (with an optional note bob sees in `vault_list_requests`).
4. Once granted, bob uses the item as `${vault:alice/forgejo-token}` in `secure_request`, within the item's `connections` binding, and sees it in `vault_list`'s `shared`. At mode `reveal` it can also read the value with `vault_get` and `owner: "alice"`.
5. The operator can revoke the grant at any time (**Vault → Grants**). The next request or `vault_get` fails.

- **No existence oracle.** `vault_request_access` answers the same way whether or not alice has that item and whether or not a caller named alice exists, and `vault_list_requests` doesn't tell them apart either. The operator sees "no such item" and can only deny. Asking for your own item is refused.
- **One pending request** per requester, owner, and item name: asking again returns the existing request unchanged. If an active grant already covers the mode asked for, the answer is `{status: "granted"}` and nothing is created. After a deny or a cancel, a new request may be made. Each requester may have at most 20 pending requests.
- **Effective mode** is the lower of the grant's mode and the item's exposure. Reveal can be granted only on a `reveal` item, and if the item later becomes `inject`, the grant works inject-only until the operator loosens the item again.
- **Item changes.** Grants and requests are bound to the item's `id`. A value change keeps them. A rename keeps them too and `shared` shows the new name, but placeholders using the old name stop resolving (`no such item`). Deleting the item revokes its grants (`item_deleted`) and withdraws its pending requests; re-creating the name makes a new item with no grants.
- **The owner's agent** isn't told who asked and can't approve or veto. It may still rename or delete its item, with the effects above.
- **History.** Decided requests are kept, the newest 500; revoked grants are kept for 90 days. Neither expires on its own: deny or revoke.
- No MCP tool grants, denies, or revokes. Those exist only on the admin API, behind the dashboard login.

### Webhooks and the tunnel

Webhook listeners (GitHub, Stripe, Trello) receive `POST /webhooks/<path>` on the daemon's port, so the daemon must be reachable from the internet. `drawlatch start --tunnel` (or `"tunnel": true`) runs a Cloudflare quick tunnel; [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) must be installed. The tunnel URL appears in `drawlatch status`, and the daemon sets any unset callback-URL variable a webhook template references (for example, `TRELLO_CALLBACK_URL`) before starting listeners. Details: [INGESTORS.md](INGESTORS.md#webhooks).

## Admin dashboard

The daemon serves a web dashboard and its JSON API from the same port as the MCP protocol: `http://127.0.0.1:9999/` by default. From it you can create, issue, and delete callers; choose whether a caller's agent may manage its own connections and secrets (**Agent permissions** on the caller page); enable connections; set secrets; configure, test, and control listeners; manage each caller's [vault](#vault) items and decide access requests; and watch events, ingestors, sessions, and a secrets matrix. Connection and secret changes apply to open sessions immediately. Running listeners pick up new secrets, or a newly enabled connection, only when they are (re)started: use the listener controls or `drawlatch restart`. Listener parameter changes restart the listener.

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
  - `/api/admin`: 300/min, with credential issuance and vault reveal each limited to 10/min (separate counters)
- Without a password, the MCP protocol still works. Login, auth checks, and `/api/admin/*` return `503`.

**Vault.** The **Vault** page (`/vault?caller=<alias>`, also linked from each caller page as "Vault: N items"; the nav entry shows a badge with the number of pending access requests) has three tabs. **Items** lists a caller's items: name, kind, exposure, tags, bound connections, who each is shared with ("bob (inject)"), and when each changed, never a value. From it you can:

- **New item**: an item created by the admin (`createdBy: "admin"`). It defaults to `inject` and to being bound to one of the caller's enabled connections; keep the binding unless the item really needs every connection ([Round trips](#using-vault-items-in-requests)).
- **Edit** the name, exposure, binding, tags, notes, and metadata. Unlike the agent, the admin may loosen an item: `inject` → `reveal`, or a wider or removed binding.
- **Replace value**: write-only inputs with a show/hide toggle while typing. The current value is never shown.
- **Delete**, after a confirmation.
- **Reveal**, after a confirmation that says it is recorded: the values appear in masked fields with show and copy buttons, and are cleared when you close the panel, after 60 seconds, or when you navigate away. A reveal works on `inject` items too, since the admin could loosen them anyway, and writes `vault.reveal` with `vault.actor: "admin"` to the caller's [audit log](#audit-log) before anything is returned; if that write fails, the reveal fails.

**Requests** is the pending [access-request](#access-requests-and-grants) queue: requester, owner and item, the mode asked for, and the reason, shown as plain text under a label saying the requesting agent wrote it. **Grant** opens a mode choice with inject preselected; reveal is disabled unless the item's exposure is `reveal`. **Deny** takes an optional note. A request for an item the owner doesn't have shows "no such item" and can only be denied. Decided requests are in a collapsible history below. **Grants** lists active grants with **Revoke** (after a confirmation), noting when a reveal grant works inject-only because the item is `inject`; revoked grants are collapsed below.

Edits, value replacements, and deletes are sent with the vault revision the page loaded (`If-Match`). There is one revision for the whole vault, not one per item or caller, so a save made meanwhile by *any* caller's agent, or from another dashboard tab, makes a pending edit fail with `409` instead of being overwritten. The dialog then says so and the list reloads with the current revision, so you can check the item and save again.

**OAuth2 connections.** The caller page and the configure dialog show each OAuth2 connection's grant and the scopes that caller gets (after its `oauth2Overrides`), the service-account subject if one is set, and why the daemon drops a connection for that caller, if it does. They are read-only: edit `oauth2Overrides` in `remote.config.json`.

**API.** The dashboard is a client of `/api/admin/*` (paths below are relative to it). Read endpoints report secrets as booleans only. `/connections` includes each template's `auth`; `/callers/:alias/connections` and `/callers/:alias/connection-status` add the caller's effective `auth`/`callerAuth` and a `problem` for a dropped connection:

- `GET /meta`, `/health`, `/connections`, `/callers`, `/ingestors`, `/sessions`, `/secrets`
- `GET /callers/:alias/connections`, `/callers/:alias/connection-status`, `/callers/:alias/ingestors`, `/callers/:alias/events`, `/callers/:alias/listener-configs`
- `GET /vault/status`: `{keyPresent, keyId, fileExists, revision, callers: {alias: itemCount}, pendingRequests}`, plus `error` when the vault can't be read. `keyId` is the key's public fingerprint, never the key.
- `GET /callers/:alias/vault/items`: `{revision, items}`, each item's metadata and `fields` (names only) with `grants: [{grantee, mode, effectiveMode}]` for its active grants. Never a value.
- `GET /vault/requests?status=<pending|granted|denied|cancelled|withdrawn>`: access requests, newest first, each with `item` (`{name, kind, exposure}` as it is now, or `null` when the owner has no such item). `reason` is agent-written text.
- `GET /vault/grants?status=<active|revoked>`: grants, newest first, each with `item` and `effectiveMode` (`null` once revoked).

`GET /callers` includes `vaultItems` per caller (`null` when the vault can't be read).

Write endpoints (`…` = `/callers/:alias/connections/:connection`):

| Method and path | Action |
| --- | --- |
| `POST /callers` `{alias, name?, connections?}` | Create a caller with a keypair on drawlatch's disk |
| `POST /callers/:alias/issue` `{connections?, endpointUrl?, passphrase?, name?}` | Issue or rotate a credential bundle (10/min) |
| `DELETE /callers/:alias` | Delete a caller, its keys, its [vault](#vault) items, and the secrets recorded in its `env` map (set via the dashboard or `set_secrets`; hand-added `.env` lines remain). `default` is protected |
| `PUT /callers/:alias/self-manage` `{enabled}` | Set the caller's `selfManage` flag (applies immediately). `GET /callers` reports it |
| `PUT /tunnel` `{enabled}` | Persist the tunnel flag (applies on restart) |
| `POST …` `{enabled}` | Enable or disable a connection |
| `PUT …/secrets` `{secrets}` | Set secrets; empty string deletes |
| `POST …/test`, `POST …/test-ingestor` | Run the connection or listener test |
| `POST …/listener/control` `{action, instance_id?}` | Start, stop or restart a listener |
| `GET`/`PUT …/listener/params` | Read or set listener params |
| `GET`/`POST …/listener/instances`, `DELETE …/listener/instances/:instanceId` | Manage listener instances |
| `POST …/listener/resolve-options` `{paramKey}` | Fetch dynamic field options |
| `POST /callers/:alias/vault/items` `{name, kind, values, exposure?, notes?, tags?, metadata?, connections?}` | Create an item (`createdBy: "admin"`). `201` with its metadata; `409` if the name exists |
| `PATCH /callers/:alias/vault/items/:name` `{values?, rename?, exposure?, notes?, tags?, metadata?, connections?}` | Update an item. The admin may loosen it; `connections: null` removes the binding, `notes: null` clears notes |
| `DELETE /callers/:alias/vault/items/:name` | Delete an item |
| `POST /callers/:alias/vault/items/:name/reveal` `{field?}` | Return the item's values (or one field), after writing `vault.reveal` to the caller's audit log; fails if that write fails. 10/min |
| `POST /vault/requests/:id/grant` `{mode?}` | Grant a pending request: `{request, grant}`. `mode` defaults to `inject`; `reveal` is `400` unless the item's exposure is `reveal`. An active grant for the same grantee and item gets the new mode instead of a second grant. `409` (with the current `status`) if the request isn't pending or names no item |
| `POST /vault/requests/:id/deny` `{note?}` | Deny a pending request (note at most 1 KiB): `{request}`. `409` if it isn't pending |
| `DELETE /vault/grants/:id` | Revoke a grant: `{grant, changed}`. Revoking a revoked grant is a no-op `200` with `changed: false` |

The vault endpoints answer with `Cache-Control: no-store`, errors included, and an unknown request or grant id is `404`. `PATCH` and `DELETE` take an optional `If-Match: <revision>` (from `GET …/vault/items`) and answer `409` with the current `revision` when the vault has changed since. Only `…/reveal` ever returns a value. If `vault.enc.json` exists but `keys/vault.key` is missing, every item, request, and grant endpoint answers `503` with the restore-from-backup message (a create with an invalid body still gets its `400` first) and no new key is created; `/vault/status` still answers, with `error` set, and `GET /callers` shows `vaultItems: null`. With no vault file yet, the item endpoints work normally: `GET …/vault/items` returns `{revision: 0, items: []}`, a `PATCH`, `DELETE`, or reveal of an item answers `404`, and the first create makes the key and the file.

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
doctor                   Check config, keys, required secrets, custom connectors' withheld
                         secrets, the vault and daemon health; exits 1 if any check fails
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

- **Endpoint allowlisting:** requests go only to URLs matching the caller's connections. A URL with a control character (tab, CR, LF, NUL, DEL), which URL parsing would silently delete, and a path with a `.` or `..` segment (including `%2e` forms, and `%2f`, `%5c`, or `\` as separators), are refused on every connection, since either would change the path after it was checked. The allowlist is matched against the URL as parsed, and that parsed form is exactly what is sent. Double-encoded forms (`%252e%252e`) and `..;` aren't resolved by drawlatch or fetch, so they reach the upstream as written. Poll listener URLs get the same checks after listener params are substituted ([INGESTORS.md](INGESTORS.md#polling)). Redirects are followed only to allowlisted URLs, never from `https` to `http`, and without credential headers across origins ([Redirects](#redirects)).
- **Per-caller isolation:** each caller sees only its connections, and secrets resolve only from its own `env` or `<ALIAS>_`-prefixed variables.
- **No secrets on the client:** the MCP server never holds API credentials. Secret placeholders resolve server-side, in request bodies only when a connection opts in. Secrets a connection injects in its own headers can't be placed in a request at all, and are scrubbed from response bodies ([Header-only secrets](#header-only-secrets)).
- **OAuth2:** on an [`oauth2`](#oauth2-token-minting) connection the agent never sees the client credentials, refresh token, service-account key, or minted access token, and only the operator chooses scopes and the user a service account acts as. The agent can't reconfigure that: on the agent path, `set_connection_enabled` refuses to enable any OAuth2 connection (one that reuses the same credentials at broader scopes, say) and `set_secrets` refuses to set or delete an OAuth2 credential, whatever `selfManage` says. The dashboard and admin API can. Set [`selfManage: false`](#callers) on these callers anyway, so the agent can't add other connections either. Scopes bound what a token can reach, not what the agent does with it.
- **Mutual authentication:** Ed25519-signed handshake against a pinned server key and registered caller keys.
- **Encryption:** AES-256-GCM with per-session X25519 ECDH keys, and monotonic counters against replay.
- **Sessions** expire after 30 minutes idle.
- **Rate limits** apply per session (`rateLimitPerMinute`) and per IP on unauthenticated endpoints.
- **Request log:** every request and response is logged with caller and session (`drawlatch logs --requests`).
- **Caller audit log:** `ingest_logs` is append-only and write-only over the protocol, stamped with the authenticated caller ([Audit log](#audit-log)).
- **Vault:** each caller's [vault](#vault) is encrypted at rest under a key file only the daemon reads. No tool returns a vault value except `vault_get` on an item the caller may reveal (its own `reveal` item, or one granted to it at effective mode `reveal`), which is audit-logged first, and none returns the vault file, its ciphertext, or the key. Access to another caller's item needs a grant, and only the operator can grant, deny, or revoke: no MCP tool can, since any authenticated caller can call any tool by name. A value injected with `${vault:…}` is scrubbed from the response like a withheld secret and can't choose the request's host. An agent can only tighten an item's exposure, never loosen it.
- **Vault on the dashboard:** no admin API response carries a vault value except the explicit `POST …/reveal`, which needs a confirmation in the UI, is limited to 10/min, is `no-store`, and is written to the owner's audit log (`actor: "admin"`) before it answers. The dashboard keeps a revealed value only in the reveal panel's state, never in a shared cache or storage, and clears it on close, after 60 seconds, and on navigation. Values are write-only everywhere else on the dashboard. Anyone with the dashboard password can reveal every caller's items.

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
