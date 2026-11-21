# Plan: Agent-namespaced, encrypted-at-rest secrets vault

Status: **proposed** (planner draft for review, 2026-11-21). Builds on #48 (withheld secrets,
scrubbing, `selfManage`), #49 (OAuth2 engine) and #50 (scoped Google templates, `set_secrets`
signing-credential refusal), all merged.
Owner: drawlatch. Consumer follow-ups: Callboard (separate repo).

## Goal

Give each caller (agent identity) its own **vault**: named items (passwords, tokens, notes,
key/value sets) that the agent saves through MCP tools and then **uses by reference**,
`${vault:name}` in a `secure_request`, so the value is resolved inside the daemon and never comes
back to the model. Items the agent marks `reveal` can be read back by their owner, and every
read is audit-logged. An agent can **ask** for another caller's item. Only the human admin, on the
dashboard, can approve that.

The store is one encrypted file that is safe to back up or sync anywhere. The only sensitive
artifact is a key file the daemon generates on first use.

## Non-goals

- Keyring, passphrase, KMS, HSM. The key is a file, `0600`, nothing else.
- Key rotation or value-rotation automation.
- Migrating existing `.env` / `env` secrets into the vault. Follow-up (see the end).
- Letting connection templates or custom connectors reference vault items
  (`"secrets": { "GITHUB_TOKEN": "${vault:gh}" }`). Follow-up.
- Vault placeholders in listener configs, listener params, or template-authored requests
  (`test_connection`, `test_ingestor`, `resolve_listener_options`).
- Callboard UI changes, npm publish, version bumps, deploys.
- Defending against an agent that has shell access to its own caller's private keys. That agent
  *is* the caller (see [CLI](#cli-and-the-git-credential-helper)). Ben isn't focused on attack
  vectors yet. Everything here aims for **low complexity and no value leaks**, not adversarial
  completeness.

## Hard invariants (hold in every PR)

1. **No value in any MCP tool response**, except `vault_get` returning an item the caller may
   reveal (its own `reveal` item, or one granted to it at `reveal`).
2. **No value in logs**: the daemon log (`[audit]` request lines, `console.error` of request
   errors), the per-caller audit files, or error messages of any kind (validation, decrypt,
   upstream, fetch errors that echo resolved input).
3. **No value in dashboard API responses**, except the explicit admin reveal endpoint
   (`POST …/reveal`), which is audit-logged.
4. **No plaintext on disk.** The vault file holds only ciphertext. No temp file, `.prev`, or crash
   dump holds plaintext.
5. **No tool returns ciphertext or key material**: not the vault file, not `keys/vault.key`, not
   the key id beyond its public fingerprint.
6. **Agents can't approve.** No `toolHandlers` entry grants, denies, or revokes access.
   `toolHandlers` is reachable by name by any authenticated caller over `/request`, whether or not
   `src/mcp/server.ts` registers it, so grant, deny, and revoke exist **only** on the
   `requireAuth` admin router.
7. **Agents can only tighten.** On the agent path, an update may not loosen an item: no
   `inject` → `reveal`, and no widening or removing its `connections` binding. Otherwise an
   `inject` item, admin-created or saved by an earlier session, could be flipped and read back.
8. The **audit-log write-only rule** in CLAUDE.md still holds. Vault events are appended through
   an export of `audit-log.ts`. No vault code builds a path to `audit/`, and no tool reads it.

## Data model

### Item

```jsonc
{
  "id": "5f0c…-uuid",            // stable across renames; grants and requests bind to it
  "name": "forgejo-token",        // ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$, unique per owner
  "kind": "token",                // "password" | "token" | "note" | "key-value"
  "exposure": "inject",           // "inject" (default) | "reveal"
  "values": { "value": "fake-0000-example" },   // SECRET. Field names only ever leave the store
  "notes": "CI token for the example Forgejo",  // NOT secret: returned by list
  "tags": ["git", "ci"],                       // NOT secret
  "metadata": { "url": "https://forgejo.example.com" },  // NOT secret, string → string
  "connections": ["forgejo"],     // optional inject binding: aliases this item may be used on
  "createdBy": "agent",           // "agent" | "admin"
  "createdAt": "2026-11-21T12:00:00.000Z",
  "updatedAt": "…",               // any change
  "valueUpdatedAt": "…"           // last change to `values`
}
```

- **Fields per kind.** `token` and `note` have exactly `value`. `password` has `value` and an
  optional `username`. `key-value` has 1–16 arbitrary fields matching `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`
  (`value` is optional). `kind` only drives validation and the dashboard's icon/label. The
  daemon treats every kind the same way.
- **Everything in `values` is secret**, including `username`. `notes`, `tags`, and `metadata` are
  plain text that `vault_list` returns. The tool descriptions say so: "don't put secrets in
  notes/tags/metadata".
- **Limits**, enforced in the daemon. Errors name the field and the limit, never the value:
  - 64 KiB per field value, 128 KiB per item, 500 items per caller, 32 MiB for the whole file;
  - `notes` 4 KiB, 16 tags of 64 characters, 32 `metadata` entries with keys of 64 and values of
    256 characters;
  - `inject` fields must be at least `MIN_SCRUBBED_SECRET_LENGTH` (4) characters, since shorter
    ones can't be scrubbed.
- **Prototype-safe**: names and field names are checked against the regexes plus the reserved list
  in `src/shared/safe-keys.ts` (`constructor` passes the name regex). Maps are null-prototype or
  read by own property only.

### Access request

```jsonc
{
  "id": "uuid", "requester": "bob", "owner": "alice",
  "itemName": "forgejo-token",     // as asked; shown to the admin
  "itemId": "uuid" | null,         // resolved at creation; null = no such item (see below)
  "mode": "inject",                // what was asked: "inject" (default) | "reveal"
  "reason": "Need to push release tags for repo X",  // ≤ 1 KiB, agent-written text
  "status": "pending",             // pending | granted | denied | cancelled | withdrawn
  "createdAt": "…", "decidedAt": "…", "decidedNote": "…", "grantId": "uuid"
}
```

### Grant

```jsonc
{ "id": "uuid", "owner": "alice", "itemId": "uuid", "grantee": "bob",
  "mode": "inject",                // "inject" | "reveal"
  "status": "active",              // active | revoked
  "requestId": "uuid", "grantedAt": "…", "revokedAt": "…",
  "revokedReason": "admin" }       // "admin" | "item_deleted" | "caller_deleted"
```

**What a grant confers.** The grantee may use the item as `${vault:alice/forgejo-token}` in its
own `secure_request` calls, subject to the item's `connections` binding. At `mode: "reveal"` it may
also read the value with `vault_get`. The effective mode is always
`min(grant.mode, item.exposure)`: a `reveal` grant on an item that is (or later becomes) `inject`
works as inject-only. The grant form defaults to inject. Reveal is offered only when the item's
exposure is `reveal`.

## Storage, file format, crypto

### Files

```
<config dir>/vault.enc.json   encrypted store (safe to back up or sync anywhere)
<config dir>/keys/vault.key   32-byte AES key, base64, one line, mode 0600 (SENSITIVE)
```

`keys/vault.key` sits next to `keys/server/` and `keys/callers/`. `migrateKeyLayout` only moves
`keys/local`, `keys/remote`, and `keys/peers`, so it leaves the key alone, and a test pins that.

### Key file

- **Generated on first write**, not at `init` or boot, and only when `vault.enc.json` doesn't exist:
  `crypto.randomBytes(32)` written with `open(O_CREAT | O_EXCL | O_WRONLY, 0o600)`, then `fsync` on
  the file and on `keys/`. `chmod 0o600` afterwards to undo umask, the same as audit files. `O_EXCL`
  makes a race between two first writes harmless: the loser re-reads the winner's key.
- **Key id** = the first 8 bytes (hex) of `SHA-256("drawlatch-vault-key-id" || key)`. The envelope
  records it, so a mismatched key gives a clear error and not a GCM failure.
- **Missing key with an existing vault file:** every vault operation fails with
  `Vault key keys/vault.key is missing; restore it from backup. The vault file can't be read
  without it.` The daemon **never** generates a new key while `vault.enc.json` exists, because that
  would orphan the data. Requests that don't touch the vault keep working.
- **Mode check:** on load, refuse a key file readable by group or others (`mode & 0o077`) and say
  why. `drawlatch doctor` reports the same.

### Envelope (`vault.enc.json`)

```json
{
  "format": "drawlatch-vault",
  "version": 1,
  "alg": "aes-256-gcm",
  "keyId": "3fa1c09e7b2d4e51",
  "iv": "<base64, 12 bytes>",
  "tag": "<base64, 16 bytes>",
  "ciphertext": "<base64>"
}
```

- **Whole-document encryption.** The plaintext is one JSON document holding every caller's items,
  plus the requests and grants:

  ```jsonc
  { "schema": 1, "revision": 42,
    "callers": { "alice": { "items": { "<name>": Item } } },
    "requests": [ … ], "grants": [ … ] }
  ```

  I chose this over per-item ciphertext with AAD binding owner and name. Per-item encryption
  leaves item names, notes, tags, request reasons, and the grant graph in plaintext in every
  backup. Encrypting the whole document hides all of it, and there's nothing left to swap between
  owners, because one tag covers everything.
- **AAD** = UTF-8 `drawlatch-vault|v1|<keyId>`. It binds format, version, and key id, so a
  downgraded or relabelled header fails authentication.
- **Nonce:** a fresh random 96-bit IV for every write. With a few writes a minute, the random-IV
  bound for one key (2³² messages) is never close. This matches `channel.ts` and
  `caller-bundle-crypto.ts`.
- **`revision`** increments on every write. It's for diagnostics and the dashboard's optimistic
  concurrency (see below). It doesn't defend against rollback, which is out of scope.
- **Version handling:** an unknown `format` or a `version` > 1 refuses to load
  (`vault file version N is newer than this drawlatch`). Future versions migrate in memory and
  write back at their own version.

### Writes and concurrency

- **Synchronous read-modify-write.** Every store operation uses `fs.*Sync`, like
  `saveRemoteConfig`. Node runs one operation at a time on the main thread, so agent tools and
  admin endpoints in the daemon can't interleave, and no mutex is needed.
- **Atomic write:** write `vault.enc.json.tmp-<pid>-<rand>` (`0600`, `O_EXCL`), `fsync`, `rename`
  over the target, `fsync` the directory. A crash leaves either the old file or the new one, plus
  at worst a stray temp file. Both are ciphertext. Stray temp files are removed on the next write.
- **Read cache:** decrypt once, keep the plaintext document in memory, and reuse it while the file's
  `(ino, size, mtimeMs)` is unchanged. Every write updates the cache. A file restored from backup
  while the daemon runs is picked up on the next operation. The daemon already holds `.env` secrets
  in `process.env`, so this adds no new class of exposure.
- **Single writer:** only the daemon touches the vault. The CLI goes through the daemon too (see
  below). Two daemons on one config dir aren't supported (the PID file already prevents it), and
  the docs say so.

### Backup and key loss (docs text)

- Back up `vault.enc.json` anywhere: it's useless without the key.
- Back up `keys/vault.key` **separately**, for example in a password manager: `cat ~/.drawlatch/keys/vault.key`
  is a single base64 line. Anyone with both files can read every caller's vault.
- **Lose the key and the vault is gone.** There's no recovery or escrow. To start over, move the old
  file aside (`mv vault.enc.json vault.enc.json.lost`). The next save creates a new key and an empty
  vault.
- Syncing the whole config dir also syncs the key (and `.env`, which is already plaintext). Exclude
  `keys/` from sync if you want the vault backup to be safe.

## Code layout

```
src/remote/vault/
  crypto.ts      key file load/create, key id, envelope seal/open (node:crypto only)
  store.ts       load/cache/atomic save of the document; the only module that names the files
  service.ts     item CRUD, exposure rules, requests, grants, purgeCaller; origin-aware
  placeholders.ts  parse `${vault:…}`, resolve for a caller + route, build scrub map
  audit.ts       thin wrapper over audit-log.ts's new appendDaemonEvent()
```

Agent tools live in `src/remote/tool-dispatch.ts` like every other tool, and call `service.ts`.
Admin endpoints go in a new `src/remote/admin-vault.ts`, mounted inside the existing admin router.
The CLAUDE.md "Where things live" section gets a vault line.

## MCP tool surface (agent-facing)

Each tool is registered in `src/mcp/server.ts` and implemented in `toolHandlers`. Every one acts as
the authenticated caller. No tool takes a caller or owner it can act *as*: `owner` only selects
whose item to **read**, and only through a grant. The zod schemas in the MCP server stay loose
(`z.record(z.string())` for values). The daemon validates, so a validation message can never quote
input.

| Tool | Params | Returns |
| --- | --- | --- |
| `vault_list` | `tag?` | `{ items: ItemMeta[], shared: SharedMeta[] }`. `ItemMeta` = item minus `values`, plus `fields: string[]` (names only). `SharedMeta` = `{ owner, name, kind, fields, mode }` for each active grant to me. |
| `vault_create` | `name, kind, values, exposure? = "inject", notes?, tags?, metadata?, connections?` | `{ success, item: ItemMeta }`. Fails if the name exists. |
| `vault_update` | `name, values?, rename?, exposure?, notes?, tags?, metadata?, connections?` | `{ success, item: ItemMeta }`. `values` replaces the whole map. `exposure` may only go `reveal`→`inject` and `connections` may only narrow (invariant 7). The error says the dashboard can loosen. |
| `vault_delete` | `name` | `{ success, deleted: name, revokedGrants: n, withdrawnRequests: n }` |
| `vault_get` | `name, owner?, field?` | `{ name, owner, kind, values }` (or `{ …, value }` with `field`). Only for an item the caller may reveal. Otherwise: `Item "x" is inject-only: reference it as ${vault:x} in secure_request.` Audit-logged **before** the value is returned. If the audit append fails, the call fails. |
| `vault_request_access` | `owner, name, reason, mode? = "inject"` | `{ requestId, status }`, see lifecycle |
| `vault_list_requests` | (none) | My requests (as requester): `id, owner, itemName, mode, status, createdAt, decidedAt, decidedNote` |
| `vault_cancel_request` | `requestId` | `{ success, status: "cancelled" }` (own pending requests only) |

The tool descriptions state that `vault_create` / `vault_update` inputs pass through the model's
context (unavoidable when the agent itself saves a value), and that for a secret the agent should
never see, the human creates the item on the dashboard. `list_routes` is unchanged. Vault tools
aren't gated by `selfManage`: they touch only the caller's own namespace and grant no connection or
credential the caller doesn't already have.

## Placeholder resolution (`${vault:…}`)

**Grammar:** `${vault:<name>}`, `${vault:<name>.<field>}`, `${vault:<owner>/<name>}`,
`${vault:<owner>/<name>.<field>}`. Names, owners (caller-alias regex), and fields can't contain `/`,
`.`, `:`, or `}`, so parsing is unambiguous. The default field is `value`. An item without a
`value` field (a `key-value` without one) needs an explicit `.field`.

**No interaction with `${VAR}`:** `resolvePlaceholders` matches `\$\{(\w+)\}`, which `vault:`
never matches, so the existing behaviour, withheld checks (`assertNoWithheldSecrets`), and the
unknown-placeholder warning are unchanged.

**Where it resolves:** only in `secure_request` (`http_request`), only in caller-supplied strings:

| Position | Vault placeholders |
| --- | --- |
| URL path and query | yes |
| URL scheme, host, port | **no**: rejected (`a vault placeholder can't choose the host`) |
| Request headers | yes |
| Body (string, JSON, multipart `payload_json`) | only when the route has `resolveSecretsInBody`, same rule as `${VAR}` |
| `files` content, `bodyFieldName` | no |
| Route `headers`, templates, listeners | no (non-goal) |

**Pipeline changes in `executeProxyRequest`:**

1. **Match first.** Route matching (Step 1) uses connection-secret resolution only, leaving vault
   tokens literal. `*` and `**` already match `${vault:x}` inside a segment. The origin of the raw
   URL must not contain `${vault:`.
2. **Authorize.** For each vault token, `placeholders.ts` resolves the item: the caller's own item,
   or with an `owner/` prefix an item covered by an active grant. It also checks the item's
   `connections` binding against `matched.alias`. Any failure rejects the request **before
   anything is sent**, with a message naming the token and the reason (`no such item`,
   `not granted`, `not allowed on connection "x"`), never a value. An unknown token is a hard error.
   It isn't sent literally (unlike `${VAR}`), so the upstream never sees `${vault:…}` in plaintext.
3. **Single-pass substitution.** URL, header, and (when allowed) body strings resolve with one combined
   regex, `\$\{(vault:[^}]+|\w+)\}`, over the **original** string. Each token gets one lookup, so a
   connection secret whose value contains `${vault:x}` isn't expanded, and neither is a vault value
   containing `${GITHUB_TOKEN}`. This replaces the separate `resolvePlaceholders` calls on those
   three caller strings. Route headers keep using `resolvePlaceholders`.
4. Step 4b's CR/LF/NUL header check, Step 6's normalize-and-re-check of the resolved URL against the
   allowlist, the overlap check, SigV4 signing, and OAuth2 minting all run as before, on the fully
   resolved values. A vault value that adds a `..` segment is refused by the existing dot-segment
   check.
5. **Scrubbing.** Every vault value substituted into this request is added (under the name
   `vault:<owner>/<name>.<field>`, so it scrubs to `${vault:…}`) to:
   - `withheldValues` (response body),
   - `allSecrets()` (status text, response headers, final URL, error messages through
     `leaksSecret` and `scrubSecrets`),
   - `crossOriginSafeHeaders` (a header carrying a vault value is dropped on a cross-origin
     redirect),
   - `bodyCarriesSecrets` (no 307/308 resend of a body with a vault value to another origin).

   This applies to `reveal` items too. It's simpler, and the caller can read those anyway.
6. **Audit:** a cross-caller use (an `owner/` token) appends `vault.inject` to the owner's audit
   log before the request is sent. Own-item injections aren't logged per request, because they'd
   be too noisy. The `[audit]` request line in the daemon log stays as it is (tool name and ids
   only).

**Known gap (documented, same class as Trello/Telegram URL tokens):** scrubbing covers echoes in
*the same* response. An agent can still write an injected value into a resource on a write-capable
API, say a card titled `${vault:x}` via a URL query, and read it back in a later request. The
`connections` binding is the mitigation: bind a sensitive `inject` item to the one connection that
needs it. Admin-created items should always be bound. The dashboard's create form defaults to
"bind to a connection", and the docs recommend it.

## Access-request lifecycle

```
            vault_request_access                admin Grant
  (none) ─────────────────────────► pending ─────────────────► granted ──(grant)──► active ──admin Revoke──► revoked
                                      │  │                                   ▲          └─ item/caller deleted ─► revoked
              requester cancels ◄─────┘  └────► denied (admin Deny)          │
                 cancelled           item or either caller deleted ─► withdrawn
```

| Who | Can |
| --- | --- |
| Requester agent | create, list own, cancel own pending. Uses the item once granted. |
| Owner agent | nothing new. It isn't shown who asked. It may delete or rename its item, with the effects below. |
| Admin (dashboard) | list all, grant (choosing the mode), deny (optional note), revoke any active grant |

- **No existence oracle.** `vault_request_access` gives the same answer (`{requestId, status:
  "pending"}`) whether or not the owner has that item. If it doesn't, `itemId` is `null`, the
  dashboard shows "no such item", and the admin can only deny. An unknown owner alias gets the
  same answer too, so the tool doesn't reveal which callers exist. Requesting your own item is
  refused.
- **Idempotency.** One pending request per `(requester, owner, itemName)`: asking again returns the
  existing request unchanged. If an active grant already covers the requested mode, the call
  returns `{status: "granted"}` and creates nothing. After a deny or cancel, a new request may be
  made. Each requester may have at most 20 pending requests.
- **Admin grant or deny on a non-pending request** returns `409` with the current status. Granting
  when an active grant already exists for `(grantee, itemId)` updates that grant's mode and doesn't
  add a second one. Revoking an already-revoked grant is a no-op `200`.
- **Item update:** grants and pending requests survive a value change, rotation included. Changing
  exposure to `inject` caps every grant at inject (effective mode is the minimum).
- **Item rename:** grants and requests are bound to `itemId`, so they survive. The grantee's
  `vault_list.shared` shows the new name. Placeholders that used the old name stop resolving, and
  the error says `no such item`. This is documented.
- **Item delete:** active grants become `revoked` (`item_deleted`), and pending requests become
  `withdrawn`. Re-creating the name makes a new `id` with no grants.
- **Caller delete** (`DELETE /api/admin/callers/:alias`, or anything that calls `deleteCaller`):
  `service.purgeCaller(alias)` deletes its items, revokes grants to and from it, and withdraws
  requests by it or to it, in the same handler, so a later caller with the same alias inherits
  nothing.
- **History:** terminal requests are kept, capped at the newest 500 (oldest pruned on write).
  Revoked grants are kept for 90 days.
- The admin sees the `reason` as **agent-written text**. It's rendered as plain text (React
  escapes it) under a label saying it came from the requesting agent, not from the owner.

## Dashboard and admin API

### Admin API (behind `requireAuth`, mounted in the existing `/api/admin` router)

All responses carry `Cache-Control: no-store`. Every mutation goes to the `[audit]` daemon log
(`deps.audit`, names only), and the durable events below go to the audit file.

| Method and path | Action |
| --- | --- |
| `GET /vault/status` | `{ keyPresent, keyId, fileExists, revision, callers: {alias: itemCount}, pendingRequests }`. Never the key. |
| `GET /callers/:alias/vault/items` | Item metadata (`ItemMeta[]`, plus `grants: [{grantee, mode}]`) |
| `POST /callers/:alias/vault/items` | Admin create (`createdBy: "admin"`). Same body as `vault_create`. |
| `PATCH /callers/:alias/vault/items/:name` | Admin update. May loosen (exposure, `connections`). `If-Match: <revision>` optional (409 on mismatch). |
| `DELETE /callers/:alias/vault/items/:name` | Delete (grant and request effects as above) |
| `POST /callers/:alias/vault/items/:name/reveal` `{field?}` | **Explicit reveal.** Returns values. Rate-limited to 10/min (the issuance limiter's budget). Audit-logged as `actor: "admin"` before it responds. POST, so it's never prefetched or cached. |
| `GET /vault/requests?status=pending` | Requests (all, or filtered) |
| `POST /vault/requests/:id/grant` `{mode?}` | Grant (default `inject`; `reveal` allowed only on a `reveal` item) |
| `POST /vault/requests/:id/deny` `{note?}` | Deny |
| `GET /vault/grants?status=active` | Grants |
| `DELETE /vault/grants/:id` | Revoke |

`GET /callers` gains `vaultItems: n` per caller. The existing read endpoints and the `/secrets`
matrix don't change and never include vault data. Caller aliases go through the same
`Object.hasOwn` lookup as #48.

### UI (`frontend/`)

- **Nav: Vault** (`/vault`), with a badge counting pending requests.
- **Items tab:** caller selector (from `/callers`), then a table of name, kind, exposure badge,
  tags, bound connections, grants ("shared with bob (inject)"), and updated time. Actions:
  - **New item** (admin-created; defaults: `inject`, bound to one connection picked from the
    caller's enabled connections), **Edit** (metadata, exposure, binding), **Replace value**
    (write-only fields with a show/hide toggle while typing, as in `ConfigureConnectionModal`),
    **Delete** (through `ConfirmDialog`);
  - **Reveal**: a `ConfirmDialog` ("This shows the value on screen and is recorded in alice's
    audit log"), then the value in a masked field with copy and show buttons. It's held only in
    that component's state, cleared on close, after 60 s, and on route change. It never goes into
    a react-query or global cache.
- **Requests tab:** a pending queue (requester → owner/item, requested mode, the agent's reason
  labelled as agent-written, "no such item" when `itemId` is null) with **Grant** (mode select,
  inject preselected, reveal disabled unless the item is `reveal`) and **Deny** (optional note).
  Below it, a collapsible history.
- **Grants tab:** active grants with **Revoke**. Revoked grants are collapsed.
- **Caller detail page:** a "Vault: N items" link to `/vault?caller=<alias>`.

## CLI and the git credential helper

**Decision: in scope as the last PR (PR 4), and it only serves items the caller may reveal.**

**How the CLI authenticates.** It uses exactly what the local MCP server uses: `proxy.config.json`'s
`remoteUrl`, `keys/callers/<MCP_KEY_ALIAS or --caller>/` private keys, and the pinned
`keys/server/` public keys, under `MCP_CONFIG_DIR`. It runs the normal Ed25519/X25519 handshake and
calls ordinary tools over the encrypted `/request` channel. There's **no new endpoint, key, admin
password path, or file access**: the CLI never opens `vault.enc.json` or `vault.key`, even when it's
on the daemon's host. To do this, PR 4 moves `establishChannel` / `sendEncryptedRequest` out of
`src/mcp/server.ts` (which starts the server on import) into `src/mcp/client.ts`, which both the
MCP server and the CLI import. The MCP server's behaviour doesn't change.

**Why reveal-only, not a per-item "helper may read inject" flag.** A git credential helper has to
print the value to git's stdin. The daemon sees only "caller bob's session called `vault_get`", and
can't tell git running a helper from an agent running `drawlatch vault git-credential` (or
`git credential fill`) in its shell with the same keys. A flag claiming "inject, but git can read
it" would be a promise drawlatch can't keep, and the item would really be revealable to that
agent. So the rule is the honest one: **an item the helper can read, the agent can read**, and
only `reveal` items (own, or granted at `reveal`) work. The helper still earns its place:

- the token isn't stored in `~/.git-credentials`, a repo URL, or a dotfile;
- it doesn't enter the model's context unless the agent deliberately asks for it;
- every use is audit-logged (`vault.reveal`, `via: "git-credential"`);
- rotating it on the dashboard takes effect for git at once.

**Commands:**

```
drawlatch vault list [--caller <alias>]               names, kinds, exposure (vault_list)
drawlatch vault git-credential --item <name> [--owner <alias>] [--caller <alias>]
                               [--username <u>] [--host <host>] <get|store|erase>
```

- `get` reads git's `key=value` lines from stdin. If `--host` is set and doesn't match git's
  `host`, it exits 1 without contacting the daemon, which guards against an unscoped helper
  answering for any host. Otherwise it calls `vault_get` with `purpose: "git-credential"`, which
  is recorded as `via` in the audit line. It prints `username=<field username | --username |
  "x-access-token">` and `password=<value>`, and exits 0.
- `store` and `erase` exit 0 and do nothing: the vault is managed by the agent or the dashboard,
  not by git.
- Errors go to stderr without values and exit 1, so git falls through to its next helper or
  prompt.
- Setup example for the docs (fake host):
  `git config --global credential.https://forgejo.example.com.helper '!drawlatch vault git-credential --item forgejo-token --host forgejo.example.com'`.
  The docs recommend URL-scoped helper config.
- Deliberately absent: `vault get` (printing to stdout; `vault_get` covers it) and `vault exec`
  (env injection into a child), as is any CLI path that could write a value. Both would be reveal
  by another name. They can come later if wanted.

## Audit events

These are durable lines in `audit/<owner>/<YYYY-MM-DD>.jsonl`, written through a new
`appendDaemonEvent(caller, fields)` export in `audit-log.ts` (same per-file lock, sequence,
`fsync`; `drawlatch.source: "daemon"`). They aren't charged to the caller's ingest byte budget.
Volume is bounded by `rateLimitPerMinute`, and an audit-before-reveal design must not refuse a
legitimate reveal because an agent flooded `ingest_logs`. They always go to the **owner's**
directory, with the actor named.

Common fields: `drawlatch.event`, `vault.owner`, `vault.item` (name at the time), `vault.item_id`,
`vault.actor` (a caller alias or `"admin"`), `vault.via` (`"mcp"` | `"admin"` | a client-asserted
`purpose` such as `"git-credential"`, marked `vault.via_asserted: true`).

| `drawlatch.event` | Extra fields |
| --- | --- |
| `vault.item.created` / `vault.item.updated` / `vault.item.deleted` | `vault.kind`, `vault.exposure`, `vault.fields` (names), `vault.changed` (which properties), `vault.renamed_from` |
| `vault.reveal` | `vault.fields` revealed, `vault.grant_id` when cross-caller |
| `vault.inject` | `vault.grantee`, `vault.grant_id`, `vault.connection` (cross-caller only) |
| `vault.request.created` / `.cancelled` / `.denied` / `.withdrawn` | `vault.request_id`, `vault.requester`, `vault.mode`, `vault.reason` (cut at 1 KiB), `vault.note` |
| `vault.grant.created` / `vault.grant.revoked` | `vault.grant_id`, `vault.grantee`, `vault.mode`, `vault.revoked_reason` |

**Never** in any event: a value, a ciphertext, the key, or a resolved URL or header. A unit test
renders each event type from a fixture whose values are canaries and asserts no canary appears.

## Migration and compatibility

- **Additive only.** No config-schema change. A daemon with no `vault.enc.json` behaves exactly as
  today, and no key is created until the first save.
- `${vault:` didn't resolve before, so existing requests containing it (unlikely) went out literally;
  now they're rejected unless the item exists. This is noted in the README.
- Older local MCP servers just don't list the new tools. Callboard doesn't call them.
- No new package exports in these PRs. Exporting `src/mcp/client.ts` for Callboard is a follow-up.
- `drawlatch doctor` adds a vault check: key present when the file exists, key mode `0600`, file
  decrypts, key id matches. `drawlatch config` / `status` print `vault: N items, key id …`, never
  the key.

## Docs to update (same PR as the code, per CLAUDE.md)

- **README.md**:
  - MCP tools table rows (PR 1, 3);
  - a new **Vault** section covering items, exposure, placeholders, the grammar table, the
    `connections` binding and the round-trip caveat, access requests, and backup and key loss;
  - config-dir listing (`vault.enc.json`, `keys/vault.key`);
  - a cross-link from the Secrets section;
  - admin API table, dashboard paragraph, CLI reference (PR 4), Security model bullets;
  - the `secure_request` row mentions `${vault:…}`.
- **CONNECTIONS.md**: one sentence in the intro: a vault item can be used on any enabled connection
  through `${vault:…}` (link to the README). Templates don't change.
- **INGESTORS.md**: one line under listener `${VAR}` resolution: vault placeholders don't resolve in
  listener configs or params.
- **CLAUDE.md**: a "Where things live" vault line and the new invariant: no tool returns a vault
  value except `vault_get` for reveal-permitted items, and no tool returns ciphertext or the key.
  Point to the vault canary test.

Every claim is checked by running the daemon against a temp `MCP_CONFIG_DIR`, not copied from this
plan.

## Test plan

- **crypto/store unit** (`src/remote/vault/*.test.ts`):
  - round trip; GCM failure on a tampered ciphertext, IV, tag, or AAD (`keyId` or `version`
    edited);
  - a wrong key gives the key-id-mismatch message;
  - missing key + existing file: refused, no new key created;
  - key file `0600` and `O_EXCL` race (two creators, one key);
  - group-readable key refused;
  - atomic write (simulate a throw between write and rename: old file intact, temp removed next
    time);
  - cache invalidation on an external file replace;
  - newer `version` refused;
  - `migrateKeyLayout` leaves `keys/vault.key` alone;
  - the file on disk never contains a canary value (grep the raw bytes).
- **service unit:**
  - each kind's field rules and every limit;
  - error messages never contain the input value (fuzz with canary values in every field);
  - reserved names (`constructor`, `__proto__`);
  - invariant 7 (agent loosen refused, admin allowed, tighten allowed);
  - every request/grant transition, including idempotency, 409s, the 20-pending cap, the
    no-existence-oracle response equality, rename/delete/purgeCaller effects, and effective mode
    `min()`.
- **Placeholder unit + server test** (local echo server, like `withheld-secrets.test.ts`):
  - resolution in path, query, and header;
  - body only with `resolveSecretsInBody`;
  - host/scheme refused; unknown item refused before sending (echo server sees no request);
  - `connections` binding;
  - cross-caller with and without a grant, after revoke, after rename;
  - single-pass (a vault value containing `${GITHUB_TOKEN}` and a secret containing `${vault:x}`
    are sent literally);
  - echoes scrubbed to `${vault:…}` in the JSON body, text body, headers, `statusText`, final URL,
    and a fetch error whose cause echoes the URL;
  - a cross-origin redirect drops the vault header; 307 to another origin isn't followed;
  - `..` in a value is refused; CR/LF in a header value is refused by name;
  - captured `console.*` output has no canary.
- **Vault canary sweep** (`src/remote/vault/vault.server.test.ts`), modelled on
  `audit-log.server.test.ts`:
  - store an `inject` canary item and a `reveal` canary item for alice, and give bob an inject
    grant;
  - call every `toolHandlers` entry as alice and as bob, with empty input and inputs pointing at
    `vault.enc.json`, `keys/vault.key`, and the item names (`name`, `owner`, `path`, `file`,
    `url: file://…`);
  - assert no response contains the inject canary, the raw key (base64 and hex), or any substring
    of the file's ciphertext;
  - assert the reveal canary appears **only** in alice's `vault_get` (and in bob's only if he's
    granted at reveal);
  - sweep every admin `GET` endpoint the same way;
  - a source scan: no file outside `src/remote/vault/` mentions `vault.enc.json` or `vault.key`;
  - `toolHandlers` has no `grant`/`deny`/`revoke` handler (invariant 6, by name pattern and by
    behaviour: bob calling every tool with a pending request id leaves it pending).
- **Existing sweeps still pass**: `audit-log.server.test.ts` (the new tools are included
  automatically), and the audit files after a reveal contain the event but no canary.
- **Admin API** (`admin-vault.test.ts`):
  - auth required;
  - `no-store`;
  - reveal rate limit;
  - reveal audit line written before the response, and a failed audit append makes reveal fail;
  - `If-Match`;
  - `__proto__` alias → 404.
- **CLI** (PR 4):
  - `git-credential get` against a running test daemon prints the right lines for a reveal item;
  - an inject item exits 1 with no value on stdout or stderr;
  - `--host` mismatch exits 1 without connecting;
  - `store`/`erase` do nothing;
  - the MCP server still works after the client extraction (existing server tests).
  - Skipped when `dist/` isn't built, like `doctor.test.ts`.

## PR breakdown (stacked; each mergeable on its own, in order)

### PR 1: `feat(vault): encrypted per-caller store and agent tools`

Scope: `src/remote/vault/{crypto,store,service,audit}.ts`, `appendDaemonEvent` in
`audit-log.ts`, the tools `vault_list/create/update/delete/get` in `tool-dispatch.ts`, their
registration in the MCP server, `purgeCaller` wired into caller deletion, the `doctor` check, the
canary sweep, and docs (README Vault section without placeholders, MCP tools, config dir, CLAUDE.md).

Acceptance:
- [ ] First `vault_create` creates `keys/vault.key` (`0600`) and `vault.enc.json`. Neither exists
  before it.
- [ ] An agent can create, list (metadata only), update, delete, and reveal (`reveal` items only)
  its own items. Another caller sees nothing of them.
- [ ] `inject` items can't be read by any tool (there's no consumer until PR 2, which is expected).
- [ ] Invariant 7 holds on the agent path.
- [ ] Every reveal writes `vault.reveal` to the owner's audit file before returning.
- [ ] Missing key + existing file: clear error, no new key. `doctor` flags it.
- [ ] Vault canary sweep and existing `audit-log.server.test.ts` green. `npm run build`, `lint`,
  `format:check`, `test` green.

Hard invariants: 1, 2, 4, 5, 7, 8.

### PR 2: `feat(vault): ${vault:…} placeholders in secure_request`

Scope: `placeholders.ts`, single-pass resolution and scrub wiring in `executeProxyRequest`, the
`connections` binding enforcement, and docs (README placeholder grammar and positions, the
round-trip caveat, `secure_request` row, CONNECTIONS.md and INGESTORS.md one-liners). Own items
only. The `owner/` grammar parses but is refused with `cross-caller access needs a grant
(available in a later version)` until PR 3.

Acceptance:
- [ ] An `inject` item works in URL path/query and headers, and in the body only with
  `resolveSecretsInBody`. It's refused in scheme/host and on connections outside its binding.
- [ ] An unknown token is refused before any upstream contact.
- [ ] Echoed values come back as `${vault:…}` in body, headers, `statusText`, URL, and errors.
  The redirect rules hold.
- [ ] No canary in console output across the placeholder test suite.
- [ ] The existing `withheld-secrets.test.ts` and `oauth2-request.test.ts` are unchanged and green.

Hard invariants: 1, 2, 5. The response path never carries an injected value.

### PR 3: `feat(vault): access requests, grants, admin API and dashboard`

Scope: request and grant model in `service.ts`; the tools `vault_request_access`,
`vault_list_requests`, `vault_cancel_request` and the `shared` section of `vault_list`; `owner/`
placeholders and cross-caller `vault_get`; `vault.inject` events; `admin-vault.ts` (every endpoint
above); the frontend Vault page (items, reveal, requests, grants) and the caller-page link; docs
(README access requests, admin API, dashboard).
If review finds this too large, split it into **3a** (admin API + dashboard items view/reveal/create)
and **3b** (requests and grants).

Acceptance:
- [ ] bob requests alice's item. It shows in the dashboard queue. The admin grants inject, and bob's
  `${vault:alice/x}` works while `vault_get` for it is refused. Revoke stops both at once.
- [ ] Reveal grants work only on `reveal` items, and the effective mode follows later exposure
  changes.
- [ ] The request call gives identical responses for an existing and a non-existent item.
  Idempotency and caps hold.
- [ ] Rename keeps grants. Delete and caller delete revoke and withdraw.
- [ ] No `toolHandlers` path changes request or grant state except the requester's own
  create/cancel (canary test).
- [ ] Admin reveal: confirm dialog, POST, `no-store`, 10/min, audit line. No vault value in any
  other admin response (sweep).
- [ ] The UI keeps a revealed value only in component state, cleared on close or after 60 s.

Hard invariants: all eight.

### PR 4: `feat(cli): drawlatch vault list / git-credential`

Scope: extract `src/mcp/client.ts` from `src/mcp/server.ts`; `drawlatch vault` subcommands in
`bin/drawlatch.js` and `src/cli/`; `purpose` → `via` in the audit line; docs (README CLI reference,
a git-credential how-to under Vault).

Acceptance:
- [ ] `git clone` against a URL-scoped helper config gets the token from a `reveal` item, with no
  credential file written. The audit line shows `via: git-credential`.
- [ ] Inject items, ungranted items, and a `--host` mismatch exit 1 with no value printed.
- [ ] The CLI authenticates only through the caller handshake (no admin password, no direct read
  of vault files; a source-scan test).
- [ ] MCP server behaviour unchanged (its tests green).

Hard invariants: 1, 2, 5. The CLI prints only what `vault_get` already permits.

## Ambiguity calls I made (for review)

1. **Whole-file encryption, not per-item AAD.** The brief suggested AAD binding owner and item
   name. That only matters with per-item ciphertexts, which leak names, notes, reasons, and the
   grant graph to every backup. One envelope hides all of it and is simpler. AAD still binds
   format, version, and key id.
2. **Key at `keys/vault.key`**, created on first *write* only, never while a vault file exists.
   "Alongside existing keys", and it can't orphan data.
3. **Admin can create and edit items in any caller's vault.** It's not in the brief, but without it
   `inject` only protects values the agent already saw when saving. Admin-created items are where
   "the agent never sees it" is actually true. It's small, since it's the same service call with
   `origin: admin`.
4. **Agents can only tighten** (exposure, binding). Without this, `inject` is a toggle away from
   `reveal`.
5. **`connections` binding is optional** (absent = any of the using caller's connections). It's
   kept optional for agent-saved items to keep things simple, and the dashboard defaults to binding
   for admin-created items. Making it mandatory for `inject` is a one-line policy change if the
   lead prefers.
6. **Placeholder positions mirror `${VAR}`**: URL and headers always, body only with
   `resolveSecretsInBody`, never host or templates or listeners. This reuses a rule people already
   know. The write-and-read-back caveat is documented, the same gap as the Trello and Telegram URL
   tokens.
7. **Scrub every injected vault value**, reveal items included. One rule, nothing to explain, and
   no cost to the caller.
8. **Unknown `${vault:…}` is a hard error**, unlike unknown `${VAR}`, which is sent literally. A
   literal vault token tells the upstream nothing, but failing loudly is clearer, and it keeps
   typos from turning into confusing 401s.
9. **The owner agent isn't told about requests for its items**, and can't veto. The brief puts
   approval with the human. Showing requests to owners invites agent-to-agent negotiation. This
   could be added later as read-only.
10. **No existence oracle in `vault_request_access`.** That costs the admin a "no such item" row.
    The alternative lets any caller enumerate other callers' item names.
11. **Vault tools aren't gated by `selfManage`.** They only touch the caller's own namespace, and
    gaining access to anyone else's item needs a human grant.
12. **Vault audit events skip the ingest byte budget** but are fail-closed: no audit line, no
    reveal. A reveal that can't be recorded mustn't happen, and an agent flooding `ingest_logs`
    mustn't be able to block reveals.
13. **No password re-prompt for admin reveal.** The dashboard session is already the trust boundary
    (README). Confirm dialog, POST, rate limit, and audit line make it deliberate. A re-prompt is
    easy to add.
14. **Git helper is reveal-only** (see [CLI](#cli-and-the-git-credential-helper)). No `vault get`
    or `vault exec` CLI in v1.
15. **Requests have no expiry**, and grants have no `expiresAt`. The admin denies or revokes.
    Expiring grants is a follow-up.

## Follow-ups (not in these PRs)

- `${vault:…}` in connection `secrets` and `env` values, so operators can move `.env` tokens into the
  vault. Then a migration command (`drawlatch vault import-env --caller X`).
- Admin-initiated grants without a request, and grant expiry.
- Owner-visible read-only "shared with" info.
- Exporting `src/mcp/client.ts` for Callboard, and Callboard UI: a vault panel per agent and a
  request-queue notification.
- `vault exec` (env injection into a child process) if a use case needs it, and still reveal-only.
- Key rotation (`drawlatch vault rotate-key`: re-encrypt under a new key, keep the old one until
  confirmed).
- A `DRAWLATCH_VAULT_KEY_FILE` override, so the key can live outside a synced config dir.
