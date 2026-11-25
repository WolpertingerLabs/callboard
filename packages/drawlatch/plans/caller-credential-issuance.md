# Plan: Caller Credential Issuance (single-bundle flow)

Status: proposed — follow-up to `feat/self-managed-admin-ui` (PR #22, merged to main 2026-06-17).
Owner: drawlatch (the identity authority). Consumer: callboard.

## Goal

Make it trivial to create and manage **caller identities** in drawlatch and hand the
resulting **credential bundle** to a callboard instance — over UI download or CLI/file —
with no two-server handshake, and **no loss of security guarantees**.

drawlatch becomes the sole issuer of all key material. One primitive, two delivery modes.
This **supersedes** the earlier B1/B2 split (bundle vs pairing): we go bundle-only, and
park the `sync`/pairing handshake (kept in-tree, removed from the UI; delete once the
bundle flow has proven out).

## Two "credentials" — keep the wall

1. **Caller identity credentials** — alias + Ed25519 signing keypair + X25519 exchange
   keypair. callboard holds the **private** keys. This is what we issue and share.
2. **Connection secrets** — upstream API tokens (`GITHUB_TOKEN`, AWS keys, …) held in
   `~/.drawlatch/.env`. These **never** enter a bundle and never leave drawlatch. callboard
   only ever receives an *identity* that is *authorized* for connections; drawlatch resolves
   the real secrets server-side per request.

## Why server-minted keys are safe here (the security argument)

The "private key never crosses the wire" property of the pairing handshake protects against
a server you *don't* trust learning your secret. But drawlatch **already holds everything of
value** (the upstream secrets, the allowlists, the authorization). The caller keypair is not
a secret callboard owns and reveals — it is a **capability drawlatch issues to grant access
to itself.** drawlatch momentarily knowing the caller private key grants it nothing it does
not already have.

This is the **AWS IAM access-key model**: the authority generates the secret server-side,
shows it once, and that is not a vulnerability — because the authority is issuing a credential
to access itself. The guarantees that matter are *one-time delivery, secure transport,
rotation, revocation* — not "the server never saw it."

Cross-domain risk is nil because each bundle **pins one endpoint + one server key**; a caller
identity is scoped to exactly one drawlatch server.

### The one property we trade, and how we neutralize it

We give up: the caller private key never existing on the server, even transiently. Four moves
restore the **end state** to be identical to the old pairing flow:

1. **Mint in memory; persist public-only.** drawlatch generates the keypair in-process,
   serializes it into the bundle, writes **only the caller public key** into the authorized
   set, and zeroes the private key from memory. The caller private key **never touches
   drawlatch disk.** (Contrast `caller-bootstrap.ts` today, which writes priv+pub to
   `keys/callers/<alias>/`.)
2. **One-time issuance; re-issue to rotate.** Shown/downloadable once. Re-issue mints a fresh
   keypair and invalidates the old one. Bounds exposure like an AWS key.
3. **Optional passphrase-wrap of the private key in the bundle.** For transfer to a *remote*
   callboard over media we don't fully trust (scp/paste), the private key is encrypted at rest
   in the file; passphrase shared out-of-band. Skipped for same-host/local.
4. **Transport over an already-authenticated channel.** UI download rides the password-gated
   dashboard over TLS/loopback; CLI/local rides the shared filesystem (0600). No new trust
   surface.

Resulting steady state: **caller private key lives only on callboard; drawlatch holds only the
public key** — bit-for-bit the posture the two-server handshake left behind.

### Where it's actually *stronger*

The bundle ships the **server's public signing + exchange keys** in-band with the authenticated
download. callboard **pins the server identity at import** (it trusts the exact key baked into
the bundle from the authenticated dashboard) — eliminating the trust-on-first-connect step the
pairing flow effectively relied on.

## Bundle format

```jsonc
// {alias}.drawlatch-caller.json   (v1)
{
  "version": 1,
  "callerAlias": "callboard-prod",
  "fingerprint": "a3:f2:1b:...",          // SHA256 of caller pubkeys, display/verify
  "createdAt": "2026-06-17T14:00:00Z",
  "expiresAt": null,
  "endpointUrl": "https://drawlatch.example.com",   // prefilled, user-overridable on issue
  "serverKeyFingerprint": "9c:11:...",    // lets callboard confirm it pinned the right server
  "connections": ["github", "slack"],     // informational (authorization lives server-side)
  "caller": {
    "signing":  { "priv": "<pem-or-enc>", "pub": "<pem>" },
    "exchange": { "priv": "<pem-or-enc>", "pub": "<pem>" }
  },
  "server": {                              // public-only — verify drawlatch + derive session keys
    "signing":  { "pub": "<pem>" },
    "exchange": { "pub": "<pem>" }
  },
  "encryption": null                       // or { "kdf":"scrypt", "salt":"...", "alg":"aes-256-gcm" }
                                           // when --passphrase wraps caller.*.priv
}
```

When passphrase-wrapped, only `caller.signing.priv` and `caller.exchange.priv` are ciphertext;
everything else is plaintext so callboard can show alias/fingerprint/endpoint before asking for
the passphrase.

## drawlatch implementation

### Server: issuance primitive
- New `issueCallerBundle({ alias, name, connections, endpointUrl, passphrase? })` in
  `src/remote/caller-bootstrap.ts` (sibling to `createCallerWithKeys`):
  - generate keypair in memory (`generateKeyBundle()`),
  - register caller in `remote.config.json` (`connections`, optional `name`),
  - write **only** the public keys to `keys/callers/<alias>/` (extend `key-manager` with a
    `savePublicOnly` path),
  - assemble the bundle, optionally scrypt+AES-GCM wrap the two private PEMs,
  - zero private key material from memory, return the bundle object.
- Reuse the existing `dispatchTool()` discipline so logic is single-sourced, then live-reload
  routes/peers (same as the other admin mutations).

### Admin API (behind `requireAuth`, audit-logged)
- `POST /api/admin/callers/:alias/issue` — body `{ connections?, endpointUrl?, passphrase? }`,
  returns the bundle JSON. **One-time**: server does not persist the private material, so it is
  unreturnable afterward (re-issue mints new). Rate-limit + audit-log every issuance.
- Rotation = call issue again (new keypair replaces the authorized pubkey).
- Revoke = existing `DELETE /api/admin/callers/:alias` (removes the authorized pubkey → caller
  can no longer authenticate). Add a lighter `POST .../disable` if we want revoke-without-delete.
- Keep the existing read-only surface and the `{name, present}` secret invariant untouched —
  the bundle path must never serialize any connection secret.

### UI (Callers page, dashboard)
Per-caller card gains a **credential lifecycle** section:
- **Issue credentials** → modal: confirm alias, edit endpoint URL (default from server meta),
  pick connections, optional "protect private key with passphrase". On submit → download
  `{alias}.drawlatch-caller.json`, with a one-time "private keys included — won't be shown
  again" banner and the fingerprint to verify out-of-band.
- **Source badge** on the card: `local-auto` / `bundle-issued`.
- **Rotate** (re-issue, invalidates prior) and **Revoke** (delete/disable) actions.

### CLI
- `drawlatch issue-caller <alias> [--name N] [--connections a,b] [--endpoint URL] [--passphrase] [-o bundle.json]`
  — same primitive; prints to stdout or writes the file. Same-host convenience: `--into <callboard-keys-dir>`
  writes the unpacked key files directly (see Local below).

### Local mode (auto-share) — unify onto the same primitive
Today local uses the `enroll.token` filesystem-proof + on-disk mint. Replace with: on first boot
of a callboard-supervised daemon, run `issueCallerBundle` for a default caller (e.g.
`callboard-local`) and write the unpacked key files **straight into callboard's keys dir over the
shared filesystem** — same-host write *is* the trust proof. No token dance, no codes, no download.
This **retires** the `enroll.token` / `/sync/auto-enroll` path: three enrollment mechanisms
(local token, remote double-code, programmatic) collapse to **one issuance primitive with two
delivery modes** (write-to-path vs download). The Callers page still shows local callers with the
`local-auto` badge and lets the user grant/revoke connections — governance without friction.

### Runtime crypto — unchanged
The Ed25519/X25519 mutual-auth handshake, AES-256-GCM channel, HKDF transcript binding, and
anti-replay window are **not touched**. This plan changes only key *distribution*.

### Parking `sync`
Remove `sync` from the dashboard and from the documented happy path. Keep `src/shared/protocol/sync.ts`,
`/sync/listen`, `/sync/status`, and the CLI `sync` command in-tree but undocumented as a
high-assurance escape hatch (private key literally never touches the server). Delete in a later
pass once the bundle flow is proven.

## callboard implementation — close the loop in Proxy Settings

Import lives in **`frontend/src/pages/settings/ProxySettings.tsx`** (the page that already shows
daemon status, MCP config dir, mode, and the now-removed sync flow).

- Replace the multi-step "Sync with Remote Server" section with a single **Import caller bundle**
  control:
  - file picker (or paste JSON) for `{alias}.drawlatch-caller.json`,
  - if `encryption != null`, prompt for the passphrase and decrypt client-side-of-backend,
  - show parsed alias + fingerprint + endpoint + serverKeyFingerprint for the user to confirm
    **before** writing anything,
  - on confirm, POST to a new backend route that unpacks the bundle into the active config dir:
    `{configDir}/keys/callers/{alias}/{signing,exchange}.{key,pub}.pem` (0600/0644) and
    `{configDir}/keys/server/{signing,exchange}.pub.pem`, and records the endpoint URL into
    agent settings (`remoteServerUrl`).
- Backend: new `POST /api/agent-settings/import-bundle` in
  `backend/src/routes/agent-settings.ts` — validates the bundle (alias regex via the existing
  `CALLER_ALIAS_REGEX` import, key PEM shape, server fingerprint), writes files atomically, then
  refreshes the ProxyClient singleton so it picks up the new alias immediately (existing
  `discoverKeyAliases()` scan already detects it).
- Bind the imported alias to agents via the existing `mcpKeyAliasRemote` / `mcpKeyAliasLocal`
  fields — no new agent wiring needed.
- Local mode: no import UI needed; the daemon auto-writes keys (above). ProxySettings just shows
  the auto-shared caller with its badge.

## Deletions enabled

- callboard: remove the sync/invite/confirm-code UI in ProxySettings and the
  `sync/start` + `sync/complete` routes (replaced by import-bundle).
- drawlatch: `enroll.token` mechanism and `/sync/auto-enroll` (replaced by local write-to-path).
- drawlatch: `sync` dashboard surface (code parked, then removed later).

## Security checklist (must hold)

- [ ] Connection secrets never serialized into any bundle or admin response.
- [ ] Caller private key never persisted to drawlatch disk; zeroed from memory post-issue.
- [ ] Issuance one-time; re-issue mints fresh keypair and invalidates prior.
- [ ] Bundle issuance behind `requireAuth`, rate-limited, audit-logged.
- [ ] Passphrase-wrap available for untrusted-transport (remote) bundles.
- [ ] Bundle pins endpoint + server key fingerprint; callboard confirms before writing.
- [ ] Local auto-share trusts shared-filesystem co-location only; keys written 0600.
- [ ] Revoke (delete/disable caller pubkey) immediately ends that caller's access.

## Sequencing

1. drawlatch: `issueCallerBundle` primitive + bundle format + unit tests (no UI).
2. drawlatch: `POST /callers/:alias/issue` admin endpoint + audit log + tests.
3. drawlatch: Callers-page issue/rotate/revoke UI; CLI `issue-caller`.
4. drawlatch: local-mode write-to-path; retire `enroll.token`; park `sync`.
5. callboard: `import-bundle` backend route + ProxySettings import UI; remove sync UI/routes.
6. Repin callboard to the new drawlatch alpha; e2e: issue → download → import → first proxied call.
