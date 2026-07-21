# Cross-Harness Model Aliases

**Goal:** One named alias (e.g. `planner`, `worker`) that resolves to the right
model *per harness* — `opus` under claude-code, `anthropic/claude-opus-4.8` under
openrouter, `gpt-5.5` under codex — so `model: "planner"` Just Works regardless of
which provider runs the session/step. Subsumes today's OpenRouter-only alias map.

## Current state (as-built)

- **Settings store:** `data/agent-settings.json` via `loadSettings`/`saveSettings`
  (`backend/src/services/agent-settings.ts`). `AgentSettings` in
  `shared/types/agentSettings.ts`.
- **Existing aliases are OR-only + callboard-side (NOT an OpenRouter feature):**
  `openRouterModelAliases?: Record<string,string>` (agentSettings.ts). Resolved by
  `resolveOpenRouterModel(value, settings)` at `agent-settings.ts:96` — lowercase
  match, one hop, alias shadows real slug.
- **Resolution call sites (openrouter only):**
  - `services/claude.ts:1269-1270` — OR chat: `requestedModel = metadata.model ||
    settings.openRouterModel`; `chatModel = resolveOpenRouterModel(...)`. Note
    `openRouterModelParamProfiles` is keyed by the **resolved** slug (`:1279`), so
    resolution must precede the profile lookup.
  - `services/model-routing.ts` — resolves `classifierModel` and the routed model.
- **No resolution on the other two paths:**
  - **codex** (`claude.ts:1344`): `requestedModel = metadata.model || settings.codexModel` — raw, no alias.
  - **claude-code**: model passed through (`claude.ts:881`) + env role-defaults
    `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` in `getApiEnvOverrides`
    (`agent-settings.ts:119-123`). The built-in names opus/sonnet/haiku/opusplan
    are fixed, NOT a user map.
- **Session chokepoint:** all sessions funnel through `services/claude.ts`
  `startSession`, branching by provider. Job runner (`job-runner.ts`), cron
  (`cron-scheduler.ts`), triggers (`trigger-debounce.ts`, `trigger-dispatcher.ts`)
  all compute `{provider, model, effort}` and hand off to that path.
- **Settings route:** `backend/src/routes/agent-settings.ts` — `normalizeAliases`
  (`:116`) validates `openRouterModelAliases` on write (`:310`).
- **MCP surface:** `tool-provider-args.ts` (`providerModelSchema` shared by
  start_chat_session/talk_to_agent/deploy_agent); `model-routing-config-tools.ts`
  (routing CRUD tools — the pattern to copy); `callboard-tools.ts` (registration);
  `openrouter-models.ts` (`getOpenRouterModelAliasesAsync`, subsequence search).
- **Frontend:** `frontend/src/pages/settings/ApiSettings.tsx` has an OR alias-rows
  editor; `frontend/src/api.ts` `getOpenRouterCatalog` returns `{models, aliases}`.
  Aliases ride inside the agent-settings blob (loaded/saved with everything else).

## Design: unified per-harness alias registry

### Data model (`shared/types/`)

```ts
export type HarnessProvider = "claude-code" | "openrouter" | "codex";

export interface ModelAlias {
  name: string;                 // "planner"; unique case-insensitive
  description?: string;
  targets: Partial<Record<HarnessProvider, string>>;
  //   "claude-code" -> "opus" | full Anthropic ID
  //   "openrouter"  -> OR slug
  //   "codex"       -> codex slug
}
```

Add to `AgentSettings`:
```ts
/** Cross-harness model aliases. Supersedes openRouterModelAliases. */
modelAliases?: ModelAlias[];
```
Keep `openRouterModelAliases` field marked `@deprecated` for back-compat.

### Migration (in `loadSettings`, one-time, idempotent)

If `openRouterModelAliases` present and a matching `modelAliases[name].targets.openrouter`
is absent, fold each `{name -> slug}` into `modelAliases` as
`{name, targets:{openrouter: slug}}`. Leave legacy field in place (read-only
fallback) so a rollback still works; drop it in a later release.

### Resolver (`agent-settings.ts`)

Replace the OR-specific resolver with a provider-aware one:
```ts
export function resolveModelAlias(
  value: string | undefined,
  provider: HarnessProvider,
  settings?: AgentSettings,
): string | undefined {
  if (!value) return value;
  const needle = value.trim().toLowerCase();
  const alias = (settings ?? loadSettings()).modelAliases
    ?.find(a => a.name.trim().toLowerCase() === needle);
  if (!alias) return value;                     // real slug passes through (existing behavior)
  const target = alias.targets[provider];
  if (target) return target;
  // alias exists but no target for THIS provider → use provider default + warn,
  // never send the bare alias name as a model id.
  log.warn(`alias "${value}" has no ${provider} target; using provider default`);
  return undefined;
}
// Back-compat shim so existing imports keep working:
export const resolveOpenRouterModel = (v, s) => resolveModelAlias(v, "openrouter", s);
```

Fallback semantics (call out explicitly):
- **no alias match** → return `value` unchanged (real slug, current behavior).
- **alias match, has provider target** → return target.
- **alias match, no provider target** → `undefined` (caller falls back to that
  provider's configured default) + warn. This is the "planner defined for OR but
  you ran it on codex" case.

### Wiring — centralize at the session chokepoint

Apply `resolveModelAlias(requestedModel, provider, settings)` in **each provider
branch of `claude.ts` startSession**, so chat/job/cron/trigger/subagent all inherit
it from one place:
- **openrouter branch** (`:1270`): swap `resolveOpenRouterModel` → `resolveModelAlias(..., "openrouter", ...)`. Keep it BEFORE the param-profile lookup (`:1279`).
- **codex branch** (`:1344`): wrap `requestedModel` in `resolveModelAlias(..., "codex", ...)`.
- **claude-code branch**: resolve `requestedModel` via `resolveModelAlias(..., "claude-code", ...)` before it becomes the SDK `model`/`ANTHROPIC_MODEL`. Built-in
  names (opus/sonnet/haiku/opusplan) are untouched unless the user deliberately
  defines an alias of that name (soft-warn in UI, don't hard-block).
- **model-routing.ts:** keep as-is but call `resolveModelAlias(..., "openrouter", ...)` (routing is OR-only).
- **Verify** job-runner/cron/trigger genuinely funnel through startSession (they
  appear to). If any bypass it, add the resolve call there too.

### Settings route validation (`routes/agent-settings.ts`)

Add `normalizeModelAliases`: names non-empty + unique (case-insensitive); `targets`
object with only the three provider keys; values non-empty strings; **targets must
be real model ids, never another alias name** (keeps resolution one-hop, cycle-free
— mirror the existing rule). Accept legacy `openRouterModelAliases` still and merge.

### MCP tools (`model-alias-tools.ts`, new — copy `model-routing-config-tools.ts`)

- `list_model_aliases` → returns aliases + per-provider targets (+ resolved model
  display names where discoverable).
- `set_model_alias` → upsert `{name, description?, targets}`.
- `delete_model_alias` → by name.
Register in `callboard-tools.ts`. Update `providerModelSchema` description
(`tool-provider-args.ts`) and job-step `model` description (`shared/types/jobs.ts`)
to note aliases now resolve per provider on any harness.

### Frontend

New **Settings → Model Aliases** page: table with columns `name | description |
claude-code | openrouter | codex`. Reuse the `aliasRows` editor pattern from
`ApiSettings.tsx`, expanded to per-harness target columns (each a model picker/free
text). Aliases already live in the agent-settings blob, so the page reads/writes
`settings.modelAliases` exactly like ApiSettings does today — no new API endpoint
needed. Remove the OR-only alias editor from ApiSettings (or leave a link to the new
page). Update `getOpenRouterCatalog` consumers / add a `ModelAliasInfo` display type.

## Edge cases / precedence to preserve

1. Alias shadows a real slug of the same name — keep, now per-provider.
2. Param-profiles keyed by **resolved** OR slug — resolution stays before lookup.
3. claude-code reserved names (opus/sonnet/haiku/opusplan) — soft-warn if a user
   alias collides; don't hard-block.
4. Model-routing matrix cells / ranks could theoretically hold an alias — out of
   scope for v1; note it.

## Testing

- Extend `agent-settings.resolveModel.test.ts`: per-provider match / miss-passthrough
  / alias-without-target→undefined+warn / case-insensitive / one-hop.
- Route validation tests (dup names, alias-pointing-at-alias, bad provider key).
- Migration test: legacy `openRouterModelAliases` → `modelAliases`.
- Job-step + codex + claude-code resolution integration checks.
- Mind the OR **global coverage gate** (~99.7L/99.1S/96.4B) — spread-guards inflate
  branch count; keep the resolver branch-lean.

## Phasing

- **Phase 1 (backend core):** types + migration + `resolveModelAlias` + route
  validation + wire the three provider branches + tests. Ships working
  `model:"planner"` for MCP tools, jobs, cron, triggers. ✅ DONE — branch
  `feat-cross-harness-model-aliases`. Files: `shared/types/modelAlias.ts` (new),
  `shared/types/agentSettings.ts` (`modelAliases` field, deprecate legacy map),
  `shared/types/index.ts` (exports), `backend/src/services/agent-settings.ts`
  (`migrateModelAliases` in loadSettings + `resolveModelAlias` + shim),
  `backend/src/services/claude.ts` (3 provider branches wired),
  `backend/src/routes/agent-settings.ts` (`normalizeModelAliases` validator),
  `agent-settings.resolveModel.test.ts` (12 tests). Backend `tsc -b` clean, tests
  green, 0 lint errors.
- **Phase 2 (MCP tools):** list/set/delete_model_alias + schema-description updates.
  ✅ DONE. Extracted shared `validateModelAliases` (shared/types/modelAlias.ts;
  route now uses it too). New `backend/src/services/model-alias-tools.ts`
  (`buildModelAliasTools`) registered in callboard-tools.ts. Writing the registry
  retires the deprecated `openRouterModelAliases` map (else migration resurrects
  deleted entries) — done in both the tools and the route. Updated
  `providerModelSchema` + job-step `model` descriptions. `modelAlias.validate.test.ts`
  (7 tests).
- **Phase 3 (frontend):** dedicated Model Aliases settings page; migrate OR editor.
  ✅ DONE. New `frontend/src/pages/settings/ModelAliasesSettings.tsx` (per-harness
  table: name | description | Claude Code | OpenRouter | Codex; OR col uses
  OpenRouterModelSelector, Codex col uses CodexModelSelector; live client
  validation via the shared validator). Registered a "Model Aliases" tab in
  Settings.tsx. Excised the OR-only alias editor from ApiSettings.tsx, leaving a
  pointer note. Frontend `tsc -b` + vite build clean; 0 lint errors.

Callboard-only — no drawlatch change, so no version-lockstep bump required.
