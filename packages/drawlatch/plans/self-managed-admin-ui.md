# Plan: Self-managed admin — drawlatch owns all management + full dashboard UX

Status: **Approved (Ben, 2026-06-16).** Paired with callboard plan
`delegate-proxy-mgmt-to-drawlatch.md`. This is the **foundation** PR — land/merge this first.

## Architecture decision

drawlatch becomes a **fully independent daemon** that owns 100% of its own state
management through its own password-gated dashboard. **Nothing external writes drawlatch's
config.** Running drawlatch **locally** (a callboard-supervised child process) and
**remotely** (a standalone server) become as close to identical as possible — same code,
same UI, same management surface; the only differences are host binding and the password.

Today the bundled UI + `/api/admin/*` is **read-only** (8 GET endpoints; Logs page is a
"Coming Soon" stub). All mutation lives one layer up in **callboard** (`connection-manager.ts`
writes `remote.config.json`/`.env` through drawlatch's *own* `saveRemoteConfig` /
`setCallerSecrets` primitives; `ConnectionsSettings.tsx` etc. are the UI). We are pulling
that entire management layer **down into drawlatch, where the config format, templates,
crypto, and ingestor engine already live.**

Because callboard will stop driving drawlatch, **there is no separate "programmatic
management API for callboard to consume."** drawlatch only needs the mutation endpoints its
**own** UI calls (behind `requireAuth`), plus the existing caller protocol, plus a
zero-friction local caller bootstrap. That is the whole point: collapse two half-built
management layers into one, owned by drawlatch.

## Work items

### A. Mutating admin API (`src/remote/admin.ts` / new `src/remote/admin-mutations.ts`)

Mount behind `requireAuth` at `/api/admin/*`, alongside the existing read endpoints. Port
the logic from callboard's `backend/src/services/connection-manager.ts` — it already calls
drawlatch's own primitives, so this is mostly relocation. Preserve the existing security
invariants (never serialize secret values, AES channel keys, or `process.env`; secrets are
write-only and read back as booleans only).

- **Connections** — `POST /api/admin/callers/:alias/connections/:connection` `{enabled}`:
  enable/disable a connection for a caller (writes `remote.config.json`, then
  `reinitialize()`).
- **Secrets** — `PUT /api/admin/callers/:alias/connections/:connection/secrets`
  `{secrets}`: set/clear caller-scoped secrets (empty string = delete). Caller-prefixed env
  vars + `${VAR}` mapping, via `setCallerSecrets` + `saveRemoteConfig`.
- **Callers** — `POST /api/admin/callers` `{alias,name}` create; `DELETE
  /api/admin/callers/:alias` delete (block `default`). Non-interactive (see item E).
- **Listeners/ingestors** — expose as authed admin endpoints (reusing the single
  tool-dispatch from item D): `control_listener` (start/stop/restart `+instance_id`),
  `test_connection`, `test_ingestor`, `list/create/update/delete listener_instance`,
  `get/set_listener_params`, `list_listener_configs`, `resolve_listener_options`.
- Everything **caller-scoped** (`:alias`/`caller` param, default `"default"`). Return
  shapes should mirror callboard's REST responses so the UI port (item B) is mechanical.
- After any config mutation, call the daemon's reinitialize path so ingestors/routes pick
  up changes (this replaces callboard's `needsRestart` banner with a live reload).

### B. Full management UI (drawlatch `frontend/`) — acceptance checklist

Upgrade the read-only pages into the **full callboard connections + logs UX**. Every
capability below (inventoried from callboard) MUST be present. Since drawlatch is now
single-process and always self-managed, **drop the local/remote split, the "Remote"
read-only badge, and the "upgrade your server" hint** — in drawlatch's own dashboard
everything is always manageable.

**Connections page** (upgrade `ConnectionList`/`ConnectionDetail`):
- [ ] Connections grouped by category (AI, Developer Tools, Gaming, Messaging,
  Productivity, Social Media, Other), enabled-first then alphabetical.
- [ ] Search box (name/alias/description, case-insensitive).
- [ ] Stability filter: Stable / + Beta / All(dev), cumulative; enabled items always shown.
- [ ] Caller selector with per-caller connection counts; **create caller** (validated
  alias) and **delete caller** (not `default`).
- [ ] Per-connection card: **enable/disable toggle** (optimistic, revert on failure);
  **Configure** (secrets modal); **Test** connection; **Test Listener** (if `hasIngestor`);
  quick **Start/Stop/Restart** listener; **Listener** button → config panel.
- [ ] Card badges: stability (beta/dev), **endpoint count**, **ingestor type + live state
  dot** (connected/error/starting color; multi-instance `connected/total`), **secret
  status** ("No secrets needed" / "Ready" / "X/Y secrets" / "N secrets needed"), **Docs**
  external link.
- [ ] Live ingestor statuses drive the state dots (from the ingestor-status endpoint).
- [ ] Config-changed → live reload (replaces callboard's restart banner).

**Secrets modal** (new, port of `ConfigureConnectionModal.tsx`):
- [ ] Required Secrets section + collapsible Optional Secrets section; "no secrets" state.
- [ ] Boolean-only status ("Set" + Clear, never the value); placeholders reflect state.
- [ ] Set a secret (only modified fields sent); Clear marks for deletion (empty string),
  with Undo; show/hide (Eye) toggle; Save (only when changed) → live reload.

**Listener config panel** (new, port of `ListenerConfigPanel.tsx`):
- [ ] Single-instance: status card (state, events received, buffered, last event, error) +
  Start/Stop/Restart.
- [ ] Multi-instance: list ALL instances (incl. stopped/disabled), Start/Stop/Restart All,
  per-instance Start/Stop/Restart, **create instance** (validated id), **delete instance**,
  **edit instance params**, per-instance disabled badge + param chips.
- [ ] Params form: grouped fields; field types **text / number(min/max) / boolean /
  select(+dynamic options on focus) / multiselect(+load from API) / secret / text[]**;
  per-field label, Required/Instance-Key tags, description, validation hints; save only
  changed.

**Events / Logs viewer** (new — **this fills the empty "Coming Soon" Logs page**, port of
`ConnectionEventsView.tsx`):
- [ ] Live event feed polled every ~5s (per caller), with manual refresh.
- [ ] Ingestor status cards (state, connection, instanceId, type, total events, last-event
  "time ago", error).
- [ ] Source filter pills (per-connection counts, "All (N)").
- [ ] Expandable event rows: source badge, instanceId, eventType, data preview, time-ago;
  expand → ids, received/stored timestamps, pretty-printed JSON.

**Per-agent read-only routes view** stays available conceptually (callboard will deep-link
here) — the existing read-only route cards are fine.

### C. Self-managed cloudflared tunnel

drawlatch brings up and supervises its **own** quick tunnel using the existing
`src/remote/tunnel.ts` helpers. When enabled (config flag in `remote.config.json` /
`proxy.config.json` or env), on startup drawlatch: starts `cloudflared`, learns its public
URL, and **injects that URL into callback-dependent connection configs** (e.g.
`TRELLO_CALLBACK_URL`, OAuth redirect/webhook URLs) **before** secret/route resolution and
**before** ingestors start. Because drawlatch owns tunnel + secret resolution + ingestors,
the whole chain is internal — **no external orchestration, and it is NOT exposed as a
control surface** (just a config flag). Surface the public URL in `/api/admin/meta`, the
Overview page, and `drawlatch status`. This lets callboard delete its `tunnel-manager.ts`
and the fragile callback-URL injection ordering entirely.

### D. Single tool-dispatch source (`src/remote/tool-dispatch.ts` / `createProxy`)

Extract the canonical MCP tool implementations (`http_request`, `list_routes`,
`poll_events`, `ingestor_status`, `test_connection`, `test_ingestor`, `control_listener`,
`list_listener_configs`, `resolve_listener_options`, `get/set_listener_params`,
`list/delete_listener_instance`) into **one** exported module consumed by the remote MCP
server (and the admin endpoints in A). Export it from the package's public entry. This is
what lets callboard **delete its `LocalProxy` ~500-line reimplementation** and talk to a
single surface — eliminating the drift the current code comments already warn about.

### E. Programmatic / non-interactive caller bootstrap

Add a path to create a caller **with keys** WITHOUT the interactive `sync` handshake:
- a library function (exported), and an admin endpoint (`POST /api/admin/callers` already in
  A), and
- a **loopback/shared-fs auto-enroll**: a co-located client that proves filesystem access
  to drawlatch's config dir (e.g. presents a one-time token drawlatch writes into the config
  dir, or any localhost admin-authed request) gets a caller provisioned with zero
  invite-code dance.

This is how a callboard-spawned local daemon gets its caller frictionlessly. The
interactive `sync` flow stays for remote enrollment.

### F. Daemon-first packaging & lifecycle

Ensure `drawlatch start` runs the full process (MCP + admin + UI + tunnel), and that local
vs remote differ only by host binding + password. Make the daemon cleanly supervisable as a
child process (deterministic start/stop, PID file, the existing `/health` endpoint). Document
the lifecycle callboard will supervise (start/stop/restart/status/health).

### G. Own the config-dir contract & layout migrations

Treat `MCP_CONFIG_DIR` + the on-disk layout (`remote.config.json`, `.env`, `keys/server`,
`keys/callers/<alias>`) as a **documented, stable contract**. Move the on-disk layout
migrations that currently live in callboard (`migrateDrawlatchDirs`,
`migrateKeyDirectories`) **into drawlatch**, so drawlatch owns its own layout evolution.

## Out of scope (separate callboard PR)

callboard-side deletion/delegation, agent→caller binding, daemon supervision — see
`delegate-proxy-mgmt-to-drawlatch.md` in the callboard repo.

## Acceptance

- drawlatch dashboard can do **everything** in the UX checklist (B) — connections, secrets,
  callers, listeners/ingestors, and the events/logs viewer.
- Mutating admin API behind `requireAuth`; security invariants preserved.
- Tunnel self-managed (C); single tool-dispatch (D); programmatic caller bootstrap (E);
  daemon lifecycle (F); config-dir/migrations owned (G).
- `npm install && npm run build && npm run lint && npm test` all green.
- Bump package version (next alpha) so callboard can depend on it.
