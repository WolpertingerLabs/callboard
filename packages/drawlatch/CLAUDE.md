# Drawlatch contributor notes

Drawlatch is an encrypted MCP proxy. A local stdio MCP server (`src/mcp/server.ts`) forwards encrypted tool calls to a daemon (`src/remote/server.ts`) that holds secrets, calls allowlisted APIs, runs event listeners, and serves the admin dashboard (`frontend/`). The CLI is `bin/drawlatch.js` and imports from `dist/`, so build before running it from a checkout.

## Monorepo

Drawlatch lives in the callboard repo at `packages/drawlatch`, as an npm workspace. There is no lockfile here: install from the callboard root (`npm install` there), then run commands from this directory or as `npm -w @wolpertingerlabs/drawlatch <cmd>` from the root. It is published to npm by callboard's publish workflow; don't publish from a checkout. Its version is set from callboard's root `package.json` (`scripts/versions.mjs`). Don't run `npm version` here.

## Commands

```bash
npm run build                                     # tsc + copy src/connections to dist + build frontend
npx vitest run <file> --maxWorkers=2              # run the tests you touched
npm test                                          # all unit tests; test:e2e needs .env.e2e (live APIs)
npm run lint && npm run format:check
```

To try the daemon without touching your real setup, set `MCP_CONFIG_DIR` to a temp directory and use a non-default port in its `remote.config.json`.

## Where things live

- **Tool implementations:** `src/remote/tool-dispatch.ts`. They're shared by the encrypted `/request` path and the admin API (`src/remote/admin*.ts`). An agent-facing tool also has to be registered in `src/mcp/server.ts`.
- **Connection templates:** `src/connections/<category>/<alias>.json`. The alias is the filename. Secrets referenced in `headers` count as required; the rest are optional.
- **Config:** schema, defaults, secret resolution, and timeout constants are in `src/shared/config.ts`. Secrets resolve from a caller's `env` literal or `<ALIAS>_<NAME>` only, never a bare env var.
- **Google:** one built-in `google` connection. Catalog of services, levels, scopes, allowlists and tests in `src/connections/google-catalog.json` (top level, so it isn't a template); loader, validator and composer in `src/shared/google.ts`. Each caller's selection is `callers.<alias>.google` (admin-only: no tool reads or writes it; the canary is `src/remote/oauth2-overrides-immutable.test.ts`). The dashboard edits it through `src/remote/admin-google.ts` (admin router only, never `dispatchTool`) and `frontend/src/components/GoogleSelectionEditor.tsx`. `resolveCallerRoutesChecked` composes it into one ordinary `oauth2` route; the base template `google.json` matches nothing. The agent-path gates in `tool-dispatch.ts` must keep treating `google` as OAuth2 in both auth modes (`google-policy-gates.test.ts`). Removed `google-*` IDs are `REMOVED_CONNECTIONS` in `src/shared/connections.ts`.
- **Listeners:** `src/remote/ingestors/` (manager, plus `discord/`, `slack/`, `webhook/`, `poll/`).
- **Audit log:** `ingest_logs` in `src/remote/audit-log.ts`. Records land in `<config dir>/audit/<caller>/<YYYY-MM-DD>.jsonl` (UTC), one flattened JSON line each, stamped `drawlatch.caller`/`received_at`/`sequence`/`source` by the daemon; the daemon's own `quota_exceeded` lines have `source: daemon`. Keep it write-only: no tool may read, list, or modify those files (the canary sweep in `audit-log.server.test.ts` calls every tool to check this).
- **Vault:** `src/remote/vault/` (`crypto.ts` key file and envelope, `store.ts` load/cache/atomic save and the only module that names `vault.enc.json` / `keys/vault.key`, `service.ts` item rules and `purgeCaller`, `audit.ts` events through `appendDaemonEvent` in `audit-log.ts`, `placeholders.ts` the `${vault:…}` parsing, checks and single-pass substitution that `executeProxyRequest` calls for caller-authored requests only). The `vault_*` tools are thin wrappers in `tool-dispatch.ts`, and the admin API (`src/remote/admin-vault.ts`, the dashboard's Vault page) calls the same service with `origin: "admin"`; only its `POST …/reveal` returns a value. No tool may return a vault value except `vault_get` for an item the caller may reveal, and no tool may return the vault file, its ciphertext, or the key; agent-path updates may only tighten an item. Access requests and grants live in `service.ts` too; granting, denying and revoking exist only on the admin router (`admin-vault.ts`): no `toolHandlers` entry may grant, deny or revoke, because any authenticated caller can call any handler by name. The canary sweep in `src/remote/vault/vault.server.test.ts` calls every tool (and every admin `GET`) to check this, and fails if any other file names the vault files. The `drawlatch vault` CLI (`src/cli/vault.ts`) is a caller like any other: it goes through the channel client in `src/mcp/client.ts` (shared with the MCP server) and calls only `vault_list` and `vault_get`; `src/cli/vault.test.ts` scans what it loads to keep it off the daemon's code and files.
- **`plans/`:** design records. Leave them as they are.

## Docs

Each topic has one home. Update it in the same change as the code:

- `README.md`: setup, config keys and defaults, secrets, timeouts, MCP tools, dashboard, CLI, exports.
- `CONNECTIONS.md`: the template table and per-connection notes. Update it when adding or changing a template.
- `INGESTORS.md`: listener behaviour, listener tools, overrides, and template ingestor fields.

Check claims by running the code (`drawlatch <cmd> --help`, a temp `MCP_CONFIG_DIR`) rather than copying from older docs.
