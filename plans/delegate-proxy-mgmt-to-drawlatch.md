# Plan: Delegate all proxy/connection management to drawlatch

Status: **Approved (Ben, 2026-06-16).** Paired with the drawlatch plan
`self-managed-admin-ui.md` (branch `feat/self-managed-admin-ui`). **Depends on that PR** —
land drawlatch first.

## Architecture decision

callboard **stops owning drawlatch's management surface entirely.** drawlatch becomes a
fully independent daemon (see the drawlatch plan) that self-manages connections, secrets,
callers, listeners, and its own cloudflared tunnel through its own password-gated
dashboard. callboard's relationship to drawlatch collapses to exactly two things it already
does over the protocol:

1. **Consume** the MCP tool/route surface (the encrypted `ProxyClient`), and
2. **Enroll** as a caller.

Crucially, **local and remote drawlatch become the same code path.** Today "local mode"
means drawlatch runs *in-process* (no daemon, no port, `LocalProxy` hand-rolls the whole
tool surface). We replace that with: callboard **spawns and supervises a local drawlatch
daemon** and talks to it via `ProxyClient` — identical to how it talks to a remote one. All
the management UI moves to (and is deleted in favor of) drawlatch's dashboard.

## Work items

### 1. Run drawlatch as a daemon in local mode too (unify local/remote)

- **Delete `LocalProxy`** (`backend/src/services/local-proxy.ts`) and its ~500-line
  hand-rolled tool surface. drawlatch's daemon now exposes the full surface via its single
  tool-dispatch (drawlatch plan item D), so `ProxyClient` gets all tools for free.
- `IngestorManager` **no longer runs in callboard's process** — it runs inside the drawlatch
  daemon, where the connections/secrets it needs already live.
- Rework `proxy-singleton.ts` into a **daemon supervisor + single `ProxyClient` factory**:
  start/stop/restart/health/PID supervision of a callboard-managed local drawlatch child
  process, OR connect to an external daemon URL — same `ProxyClient` either way.
- Collapse `proxyMode` local/remote into "drawlatch endpoint" (callboard-managed-local vs
  external-URL). `getProxy()` always returns a `ProxyClient`.

### 2. Stop writing drawlatch config

- **Delete `connection-manager.ts` write paths** and the deep
  `@wolpertingerlabs/drawlatch/shared/*` mutation imports (`saveRemoteConfig`,
  `setCallerSecrets`, `setEnvVars`, `loadEnvIntoProcess`, etc.). callboard no longer
  reads/writes `remote.config.json` or `.env`.
- Anything callboard still needs to *display* about connections comes from drawlatch over
  the protocol (read-only), or callboard just deep-links to the dashboard.

### 3. Remove the connections management UI

- **Delete** `frontend/src/pages/settings/ConnectionsSettings.tsx`,
  `components/ConfigureConnectionModal.tsx`, `components/ListenerConfigPanel.tsx`,
  `pages/settings/ConnectionEventsView.tsx`, and the backing `backend/src/routes/
  connections.ts` + the mutation/relay endpoints in `routes/proxy.ts`.
- Replace the Settings **Connections** tab with a thin panel: connected drawlatch daemon
  (URL + `/health` + caller-enrollment status) and a **deep link / embed to drawlatch's
  dashboard** for all actual connection/secret/listener/logs management.

### 4. Caller enrollment

- For a callboard-managed **local** daemon, enroll via drawlatch's new
  programmatic/auto-enroll path (drawlatch plan item E) — zero invite-code friction
  (shared filesystem).
- For an **external/remote** daemon, keep the `sync` invite-code flow.
- Slim `ProxySettings.tsx` down to: drawlatch endpoint (managed-local vs URL) + enrollment
  status + (per-agent) caller selection.

### 5. Tunnel removal

- **Delete `tunnel-manager.ts`** and the callback-URL injection ordering in
  `proxy-singleton.ts`. drawlatch owns and self-manages the cloudflared tunnel now
  (drawlatch plan item C).

### 6. Agent-facing wiring — keep, simplify

- Keep injecting the MCP proxy tools into SDK sessions, but from **one** `ProxyClient`-backed
  server. Drop the dual `mcp-proxy` (`proxy-tools.ts`) / `n` (`mcp-tool-registry.ts`)
  duplication — pick one server name and delete the other path.
- The per-agent read-only `frontend/src/pages/agents/dashboard/Connections.tsx` becomes a
  thin `list_routes` read and/or a deep link into drawlatch's dashboard (it already tells
  the user "connections are managed by drawlatch, not callboard").

### 7. Dependency management

- Bump `@wolpertingerlabs/drawlatch` to the version that ships the daemon tool-dispatch +
  admin mutations + auto-enroll.
- **During development**, use the dev switch (`scripts/drawlatch-switch.cjs` →
  `file:../drawlatch.feat-self-managed-admin-ui`) to build against the sibling worktree.
- **Before opening the PR**, restore a clean version spec — do **not** leak the `file:` pin
  into the PR (see MEMORY "dev pins leak into merged PRs"; `prepublishOnly` guard already
  refuses `file:`). The published drawlatch alpha won't exist until its PR lands, so the
  callboard PR must **clearly state it depends on the drawlatch PR** and pin to the
  forthcoming alpha version (placeholder is fine if marked); it must not be merged before
  drawlatch publishes.

## What stays in callboard

- The **agent → caller binding** (`mcpKeyAliasLocal`/`Remote` → simplified to one alias):
  which drawlatch caller identity each agent uses. Pure callboard concern.
- Spawning/supervising the local daemon (new responsibility, item 1) — smaller than the
  embedding + config-writing + tunnel complexity it retires.

## Acceptance

- callboard has **no** connection/secret/listener management code or UI of its own.
- callboard supervises a local drawlatch daemon (or connects to an external one) and reaches
  all connections through `ProxyClient` over the protocol; `LocalProxy`,
  `connection-manager.ts` writes, `tunnel-manager.ts`, and the connections UI are gone.
- Local ≈ remote (one code path).
- `npm install && npm run build && npm run lint && npm test` all green.
- No leaked `file:` drawlatch pin in the PR; dependency on the drawlatch PR clearly noted.
