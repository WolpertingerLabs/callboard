# Model-aware reasoning effort

## Implementation plan
1. Trace execution routing, model aliases and configured/environment defaults before adding a backend capability resolver. The UI and validation consume one serializable contract; no API-key-presence routing heuristics.
2. Preserve OpenRouter reasoning metadata (including absent versus null versus empty supported efforts) in the existing catalog/cache. Intersect advertised capabilities with the actual adapter transport vocabulary, conservatively withholding unknown capabilities.
3. Discover native Codex efforts/default from the live debug catalog. Keep legacy native `none` as summary suppression, not reasoning disabled. Verify OpenRouter disable semantics against installed transport with local tests before exposing it.
4. Integrate the shared picker with asynchronous route/model resolution, stale-response protection and visible invalid saved selections. Preserve max/ultra through persistence and API schemas; do not widen Cline/pi SDK inputs.
5. Validate explicit updates before mutation and defend execution of stale settings across chats, cron and jobs using execution's resolved model and route. Never downgrade an unsupported level silently.
6. Add focused catalog/resolver/adapter/API/UI regressions, run build and relevant/full checks where feasible, document limitations. Commit, fetch/rebase at clean milestones and before completion. No publishing, merging, credentials changes or server restart.

## Sources and decisions
- https://learn.chatgpt.com/docs/app-server#list-models-modellist — model-specific reasoning discovery, rather than a harness-wide enum.
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens — per-model `reasoning` metadata; gateway vocabulary none/minimal/low/medium/high/xhigh/max. Explicit null permits all gateway efforts, omission exposes no effort selector, empty permits none; mandatory excludes none. `supported_parameters` alone is insufficient.
- User-provided installed CLI/SDK baseline is 0.153.4. Catalog, not SDK union, determines advertised native levels. No hand-maintained model-ID mappings or stronger-to-weaker translation.
- Initial official documentation tool retrieval failed with expired tool authentication; use public HTTP retrieval if further research is required, without changing credentials.

## Validation/results
Pending implementation.

## Implemented design
- `shared/types/reasoning.ts` is the serializable capability contract plus conservative pure catalog interpretation. Storage vocabulary includes max/ultra/persistent, but native options require live catalog advertisement; SDK membership alone never adds a choice. Cline/pi adapters explicitly refuse those additional strings.
- `reasoning-capabilities.ts` shares `resolveReasoningTarget` with actual Codex/Cline/pi execution. It resolves model aliases and mode-specific settings defaults with `resolveSessionModel`, distinguishes injected Codex OR routing from ambient OR routing, and does not mistake an unrelated key for routing. Cline/pi provider IDs and explicit OpenRouter base URLs determine their route.
- `/api/codex/reasoning` serves the contract for all reasoning harnesses. Every shared picker keys async results by provider/model/config, discards stale responses, displays unsupported persisted values rather than defaulting them, and offers explicit clearing. No new native summary-only `none` choice is advertised; saved native `none` remains visibly labelled and supported.
- Native model discovery retains the existing live Codex catalog. OR uses parsed reasoning metadata and the existing bounded TTL/retry/single-flight cache, now invalidated on endpoint changes. Last-good data is retained for same-endpoint transient failure, never borrowed from a previous endpoint.
- Cline preserves its SDK `supportsReasoning` flag; pi preserves model-specific thinking-level maps and null exclusions. OR capabilities are intersected with each adapter's transport vocabulary; max is not passed into Cline/pi simply because Codex accepts it.
- Explicit effort validation occurs before mutations in chat create/update/fork, cron/trigger config, job create/update/import/tools and session-start tools. Execution revalidates saved settings in `sendMessage`/agent execution; stale unsupported choices fail with model/route, supported choices and clearing instructions. Job effort forwarding and job-default model resolution are now consistent with validation.

## Transport verification and limitations
- Actual installed SDK → CLI → isolated loopback HTTP test (fake HOME/CODEX_HOME/key, no model calls) verifies `reasoning.effort: "none"` and `"max"`. OR `none` uses `CodexOptions.config.model_reasoning_effort = "none"`, because the typed SDK ThreadOption omits it. Native saved `none` still sets only `model_reasoning_summary = "none"`. Adapter unit tests protect this distinction and native max/ultra.
- The same wire probe shows **unset Codex OR effort emits medium** for an unknown OR slug. `config: null` cannot suppress this (SDK rejects null; TOML has no null), and disabling reasoning-summary support does not remove the effort. Therefore the UI deliberately does not label OR `default_effort` as the transport's default: clearing delegates to the harness configuration/default, not necessarily the gateway. `default_enabled: false` is preserved as catalog data but does not imply that clearing disables reasoning. Explicit supported `none` is the verified off control. Nonreasoning/dynamic OR entries expose no explicit efforts; the existing CLI implicit-default behavior remains a transport limitation.
- When a model is left entirely to opaque CLI/runtime configuration (no resolvable settings default), or catalog discovery is unavailable, only default is offered (plus compatibility for saved native summary-none). No guessed model ID or effort is substituted. Select an explicit known model to enable discovery. Pi's unspecified runtime model is intentionally not guessed.
- Public HTTP retrieval of both official source pages succeeded after the documentation tool's expired-token failure. OR docs confirm absent/null semantics and mandatory reasoning; App Server docs recommend model-specific supported reasoning discovery.

## Verification
- Dependency installation: `npm ci --ignore-scripts --include=dev`; lockfile unchanged, no shared-worktree node_modules/dist symlinks.
- Focused tests include metadata malformed/absent/null/empty/mandatory, native max/ultra, OR vocabulary, route/alias/settings resolution, API pre-mutation validation, jobs and automation, adapter/wire behavior, persisted values, clear/model/provider transitions and stale frontend responses.
- Frontend suite: 76 files / 1107 tests passed during implementation; additional picker tests also passed.
- Initial concurrent full-suite run had a job-runner hook timeout and a test observing a mid-run source edit; targeted rerun passed 30/30. Final full suite runs with four workers after edits settle (results below).
- Final `npm test -- --maxWorkers=4`: **278 passed files, 3 skipped; 4381 passed tests, 32 skipped** (281 files / 4413 tests total).
- Full `npm run lint:all` equivalent (`npx eslint . --ext .js,.jsx,.ts,.tsx`): **0 errors, 933 warnings** (existing warning baseline/style debt).
- `npm run build`: shared/backend/frontend production builds pass; existing swagger annotation warning and Vite large-chunk warning remain. No lockfile changes.
