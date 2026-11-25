# Plan: Merge drawlatch-ui into drawlatch

> Executable plan for the `merge-drawlatch-ui` callboard job. Each unchecked step below is
> implemented as one iteration (worker → review → check off). Implement **only the first
> unchecked step** each iteration. Do not touch Phase 7 — it is manual/post-merge and excluded
> from this run.

## Context

`drawlatch` is a config-driven MCP proxy daemon (Express 5, TS ESM, single package). It already
serves a **loopback-only, read-only `/admin/*` API** purpose-built so a dashboard could read
daemon state. `drawlatch-ui` (separate repo at `/home/cybil/drawlatch-ui`) is a thin backend that
only (a) proxies `/api/admin/* → drawlatch :9999/admin/*`, (b) adds a scrypt password + cookie
auth gate, and (c) serves a React/Vite SPA. That two-process split was scaffolding.

This plan **collapses the UI into the daemon**: one process, one port, no proxy hop. Confirmed
decisions:
1. **Collapse into the daemon** (not just relocate as workspaces).
2. **Password-gate the admin + UI surface and allow host bind** — drop loopback-only on those
   routes; the scrypt password becomes the trust boundary so `DRAWLATCH_HOST=0.0.0.0` can expose
   the dashboard to a LAN. Matches drawlatch-ui's strict-always posture.
3. **Single source of admin DTO types in drawlatch** — delete the duplicated `shared` mirror.

Outcome: `drawlatch start` runs the daemon *and* serves the authenticated dashboard on the same
port (9999). Source repo for ports: `/home/cybil/drawlatch-ui`.

## Target shape

`drawlatch` becomes a minimal 2-package monorepo: **root** = daemon (current `src/`, `bin/`, tsc
build) + ported auth layer; **`frontend/`** = new Vite/React/RR6 workspace moved from
`drawlatch-ui/frontend`. The `shared`/`backend` workspaces and `bin/drawlatch-ui.js` are NOT
carried over — their logic folds into the daemon.

---

## ⚠️ Two traps every step must respect

- **Express 5 wildcard:** drawlatch-ui's `app.get("*", …)` is **invalid in Express 5** (drawlatch
  is Express 5). Use a terminal middleware mounted last instead:
  `app.use((req, res) => res.sendFile(path.join(distDir, "index.html")))`.
- **No `process.exit` on missing password:** drawlatch-ui's backend `process.exit(1)`s when no
  password is set. **Do NOT port that** — it would kill the MCP daemon. The daemon must always
  start; when no password is configured, `requireAuth` returns `503` and the SPA shows a locked
  state.

---

## Steps

### [x] Step 1 — Port admin DTO types + auth layer (no wiring)
Pure relocation, nothing wired into the running app yet. Must build & lint clean.
- **New** `src/remote/admin-types.ts`: pure interfaces ported verbatim from
  `/home/cybil/drawlatch-ui/shared/types/admin.ts` (`AdminMeta`, `AdminHealth`,
  `AdminIngestorCounts`, `AdminCaller`, `ConnectionCategory`, `AdminConnectionTemplate`,
  `AdminSecretRef`, `AdminListenerInstance`, `AdminCallerConnection`, `IngestorState`,
  `AdminIngestor`, `AdminSession`, `AdminSecret`, `DaemonOfflineEnvelope`). Type-only → compiles
  to nothing.
- `src/remote/admin.ts`: import the DTOs and annotate each handler's response shape so the daemon
  is the type authority. Update the file header: the trust boundary for the admin surface is now
  the password gate, not loopback (wired in Step 2).
- **New** `src/auth/` ported from `/home/cybil/drawlatch-ui/backend/src`, adapting all paths from
  `~/.drawlatch-ui` to the daemon's `~/.drawlatch` config dir:
  - `auth/auth.ts` ← `auth.ts` (handlers `loginHandler`/`logoutHandler`/`checkAuthHandler`/
    `changePasswordHandler`, `requireAuth`, `isPasswordConfigured`). Logic unchanged.
  - `auth/sessions.ts` ← `services/sessions.ts` (file-backed sessions, mode `0o600`, now at
    `~/.drawlatch/data/sessions.json`).
  - `auth/password.ts` ← `utils/password.ts` (scrypt hash/salt/timing-safe verify). Unchanged.
  - `auth/env-writer.ts` ← `utils/env-writer.ts` (writes `AUTH_PASSWORD_HASH`/`AUTH_PASSWORD_SALT`
    into the daemon's `~/.drawlatch/.env`, mode `0o600`).
  - Reuse the daemon's existing `getEnvFilePath()` and config-dir helpers in `src/shared/config.ts`
    rather than re-deriving `~/.drawlatch`.
- Add deps to root `package.json`: `cookie-parser`, `express-rate-limit` (v7+/v8 — Express-5
  compatible). Do **not** add them yet to any code path; just declare + install.
- Verify: `npm run build` and `npm run lint` clean. No behavior change to the running daemon yet.

### [x] Step 2 — Wire auth + admin + SPA into the daemon (SECURITY-CRITICAL)
In `src/remote/server.ts` `createApp()` (the existing app factory):
- Add `cookie-parser`; mount a scoped `express.json()` only on the `/api/auth/*` routes (keep the
  daemon's per-route body-parser pattern — do not add a global JSON parser).
- Add two `express-rate-limit` limiters: 3/min for login + change-password, 20/min for check +
  logout (same config as drawlatch-ui).
- Mount **public** routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/check`,
  `POST /api/auth/change-password` (the last behind `requireAuth`).
- Mount the **admin router behind `requireAuth` at `/api/admin`** (the path the frontend already
  uses). **Remove** the old unauthenticated loopback `/admin` mount and its `requireLoopback`
  guard for admin — the password gate replaces it. **Leave the protocol endpoints unchanged**
  (`/handshake`, `/request`, `/sync`, `/events/stream`, `/webhooks`, `/health` keep their own
  guards). Only the admin surface changes.
- Serve the SPA in production from `frontend/dist` via an **Express-5-safe** terminal middleware
  (see trap above), mounted after all API routes and skipping `/api`, `/handshake`, `/request`,
  `/sync`, `/events`, `/webhooks`, `/health`.
- **Do NOT** add the `process.exit(1)` startup guard (see trap above). The daemon starts
  regardless; `requireAuth` already 503s when unconfigured.
- Drop the proxy + ECONNREFUSED offline-envelope logic from drawlatch-ui's backend — same-origin
  calls can't refuse themselves.
- Verify: `npm run build`, `npm run lint`, `npm test` clean. Manually confirm `/api/admin/meta`
  returns 401 without a session cookie and the daemon still boots with no password set.

### [x] Step 3 — Move the frontend in as a workspace
- Move `/home/cybil/drawlatch-ui/frontend/**` → `frontend/**` in this repo.
- Root `package.json`: add `"workspaces": ["frontend"]`; add `build:frontend`
  (`npm -w frontend run build`); extend the root `build` so it builds the daemon **and** the
  frontend (so `frontend/dist` exists for production serving); keep the existing `connections`
  copy step. Frontend React/Vite/lucide deps stay in `frontend/package.json` (keep the daemon's
  dep tree lean).
- `frontend/src/api.ts`: keep the `/api/admin/*` base (now served same-origin). No offline-envelope
  changes needed.
- `frontend/vite.config.ts`: point the dev proxy `/api` → `http://127.0.0.1:9999` (the daemon).
- Replace `import … from "drawlatch-ui-shared/types/admin.js"` with the daemon's single source via
  a TS path alias + matching Vite alias (e.g. `drawlatch-admin-types` →
  `../src/remote/admin-types.ts`). Type-only — no daemon runtime enters the bundle.
- Drop the `shared` workspace / `drawlatch-ui-shared` dependency entirely.
- Verify: `npm install` resolves the workspace; `npm run build` produces `frontend/dist`;
  `npm run lint` clean.

### [x] Step 4 — Fold the CLI
In `bin/drawlatch.js`:
- Add `drawlatch set-password` and `drawlatch change-password` subcommands — port the TTY + piped
  interactive logic from `/home/cybil/drawlatch-ui/bin/drawlatch-ui.js`; write to
  `~/.drawlatch/.env` (reuse `src/auth/env-writer.ts` / config helpers).
- `drawlatch start` is unchanged in surface — the daemon it starts now also serves the dashboard.
- `drawlatch status`: add the dashboard URL (`http://<host>:<port>/`) and whether a password is
  configured.
- The separate `drawlatch-ui` supervisor is not ported.
- Verify: `drawlatch set-password` (both TTY and piped) writes the hash; `drawlatch status` shows
  the URL + password state.

### [x] Step 5 — Tests + CI
- Port `/home/cybil/drawlatch-ui/backend/src/auth.test.ts` into the daemon's vitest suite
  (supertest against `createApp()`): login/logout/check/change-password, both rate limits, session
  rolling, and the 503-when-unconfigured path.
- New integration test: `/api/admin/*` returns **401 without** a session cookie and **200 with**
  one (proves the loopback→password boundary swap); the SPA fallback serves `index.html` on a deep
  link under Express 5.
- Keep the existing `src/remote/admin.test.ts` security invariants (no secrets / channel keys /
  env values serialized) and ensure they run against the auth-gated mount.
- **New** `.github/workflows/ci.yml` (Node 22): install with
  `NODE_ENV=development npm ci --include=dev` (avoids the production-devDep strip), then build
  (daemon + frontend), lint, test.
- Update `README.md`: document the merged dashboard, `set-password`, host-bind, and that
  `~/.drawlatch-ui/` is abandoned (operator re-runs `set-password`; no migration).
- Verify: `npm run build && npm run lint && npm test` all green.

---

## Verification (full run, after all steps)

1. `NODE_ENV=development npm ci --include=dev` then `npm run build` — clean (daemon + frontend).
2. `npm run lint && npm test` — green.
3. Fresh start with **no** password: daemon serves MCP normally; `GET /api/admin/meta` → 503;
   daemon does **not** exit.
4. `drawlatch set-password`, restart → login sets cookie; `/api/admin/meta` → 401 without cookie,
   200 with it.
5. Browser `http://127.0.0.1:9999/` → login → all pages (Overview/Connections/Callers/Ingestors/
   Sessions/Secrets) render same-origin; deep-link reload serves the SPA (Express-5 fallback).
6. `DRAWLATCH_HOST=0.0.0.0 drawlatch restart` → dashboard reachable from another host, still
   password-gated; protocol endpoints unaffected.
7. `src/remote/admin.test.ts` invariants still pass.

---

## Phase 7 — Manual / post-merge (NOT executed by the automated job)

Done by hand after the PR is reviewed and merged:
- Archive the `WolpertingerLabs/drawlatch-ui` GitHub repo with a README pointer to drawlatch.
- `gio trash` the `~/drawlatch-ui` checkout and the `~/drawlatch-ui.*` worktrees (all merged/clean).
- History: default to clean copy-in. If frontend git history must be preserved, redo Step 3 with
  `git subtree add --prefix=frontend` from the drawlatch-ui remote instead of a plain move.
