# Remove the OpenRouter Agent Harness engine

Remove OpenRouter as a **selectable agent harness**, while keeping every other
use of OpenRouter in the product intact: the credential-override modes for the
other engines, the model catalog, and the AI-generated chat metadata (titles,
branch names, themes).

Status: planned. Execute the phases in order — each is a separate commit/PR and
each leaves the tree compiling and green.

## Why this is not a simple deletion

"OpenRouter" names four separable things in this tree. Only the first is going
away.

| # | Thing | Where | Fate |
|---|-------|-------|------|
| 1 | **The engine** — an `AgentProviderKind` backed by `@wolpertingerlabs/openrouter-agent-harness` | `backend/src/agents/adapters/openrouter/` | **Remove** |
| 2 | **Credential overrides for other engines** — run a *native* harness against OpenRouter | `claudeCodeUseOpenRouter`, `codexUseOpenRouter`, `acpUseOpenRouter`, `clineProviderId: "openrouter"`, `piProviderId: "openrouter"`, all resolved in `getApiEnvOverrides()` | **Untouched** |
| 3 | **The model catalog** | `services/openrouter-models.ts`, `GET /api/openrouter/models`, `list/search_openrouter_models` MCP tools | **Keep** |
| 4 | **Utility completions** — chat titles, branch names, themes | `services/quick-completion.ts` | **Keep, re-plumbed** |

#2 is the whole point of the exercise: a user who pays for OpenRouter keeps
using OpenRouter for everything. They just do it through the native Claude
Code / Codex / Cline / pi harnesses instead of through a separate one.

#3 is load-bearing for #2 — every OR-slug picker in the settings UI reads the
catalog, and `getLatestAnthropicRoleModels()` uses it to fill in role-model
defaults when Claude Code is routed through OpenRouter.

#4 is the part that currently depends on #1, and re-plumbing it is Phase 2.

## Decisions

These were settled before work started. Do not relitigate them mid-phase.

1. **Model routing is deleted, not re-scoped.** It is gated on
   `providerKind === "openrouter"` and is unreachable once the engine is gone.
2. **OR-only settings are deleted** — but only the ones that are *provably*
   engine-only. See the triage table in Phase 3; two fields fail that test and
   must survive.
3. **Old OpenRouter chats are dropped.** No read-only session provider, no
   migration. The chat list is filesystem-discovery driven, so they simply stop
   appearing. Their records under `~/.callboard/chats/` and session logs under
   `~/.openrouter-agent-harness/logs/` become unreferenced files.
4. **Utility completions get a dedicated OpenRouter section** on the API
   settings page, with an **explicit opt-in toggle** and **three model tier
   fields** (haiku/sonnet/opus). Not implicit-on-key-present.
5. **The `openrouter` model-alias target is retained.** It is engine-only for
   *resolution*, but it is user data, and dropping the column silently discards
   slugs users typed. Cost of keeping: one union member.

## Phase 1 — Stop offering it — **DONE** (`04d171e`)

Goal: OpenRouter disappears from every user-facing surface that lets you *pick*
a harness. The adapter still exists and existing chats still run. Tree compiles,
tests green.

Four things the plan got wrong, corrected in the implementation — later phases
should read these as fact:

1. `INTERNAL_PROVIDER_KINDS` was `[...ROUTABLE_PROVIDER_KINDS]`, so "leave it
   alone" was not achievable; it is now `[...ROUTABLE, "openrouter"]`. **The
   guard you use on a persisted provider value matters**: `isRoutableProvider`
   silently degrades a legacy OR chat to `claude-code`. Use `isInternalProvider`
   for anything read out of chat metadata or a job definition.
2. The `SettingsTab` widening in 2d below was a Phase 1 requirement — the page
   stops compiling once `"openrouter"` leaves `UiAgentProviderKind`. **Already
   done**; Phase 2 only fills in the section body.
3. `job-store`'s model-validity checks run again at run start, so `"openrouter"`
   is still *accepted* there (just no longer advertised in the error message).
   Removing it would fail every persisted OR job at run time.
4. The composer popover and its fork menu entry are hidden for a legacy OR chat,
   and editing a legacy OR cron job re-targets it to Claude Code.

The mechanism is the existing `ROUTABLE_PROVIDER_KINDS` /
`INTERNAL_PROVIDER_KINDS` split in `backend/src/agents/ports/AgentProvider.ts` —
it is documented as exactly the seam that lets a kind be *implemented* without
being *offered*. Run it in reverse.

- `ROUTABLE_PROVIDER_KINDS` — drop `"openrouter"`. Leave `AgentProviderKind` and
  `INTERNAL_PROVIDER_KINDS` alone for now so the backend keeps compiling.
- `shared/types/providers.ts` — drop `"openrouter"` from `UiAgentProviderKind`.
- `shared/types/modelAlias.ts` — `HarnessProvider` currently aliases
  `UiAgentProviderKind`. Decouple it: `type HarnessProvider = UiAgentProviderKind
  | "openrouter"`, and keep `"openrouter"` in `HARNESS_PROVIDERS`, per Decision 5.
  Comment why.
- Frontend pickers: the provider toggle in `components/ProviderConfigPicker.tsx`,
  `components/NewChatPanel.tsx`, `components/ForkHandoffModal.tsx`,
  `pages/agents/dashboard/CronJobs.tsx`, and the `ForkProvider` union in
  `frontend/src/api.ts`.
- Route + tool validation: the fork `provider` enum in `routes/chats.ts`, the
  provider enums in `services/tool-provider-args.ts`,
  `services/mcp-tool-registry.ts` (several tools), and the
  `["openrouter", "claude-code"]` model-validity checks in `services/job-store.ts`.
- `frontend/src/utils/localStorage.ts` — `KNOWN_PROVIDERS`.

Keep in this phase: the settings page's OpenRouter tab (Phase 2 rewrites it),
`ProviderBadge`, and everything under `adapters/openrouter/`.

## Phase 2 — OpenRouter becomes a service, not an engine — **DONE**

Goal: chat titles, branch names and themes keep working on OpenRouter
credentials, with no harness involved. **Must land before Phase 3**, because the
current OR utility path runs through `OpenRouterAdapter`.

Two things later phases should read as fact:

1. The shared base-URL resolution landed as its own module,
   `backend/src/services/openrouter-endpoint.ts` (`OPENROUTER_DEFAULT_BASE_URL`
   + `resolveOpenRouterApiUrl`), rather than as an export of
   `openrouter-models.ts` — neither the catalog nor the completion client owns
   the other, and the completion client has no business importing a module whose
   side effect is a startup cache.
2. `model-routing.ts` now calls `runOpenRouterCompletion` **directly** rather
   than going through `quickCompletion`. It needs a caller-supplied classifier
   slug, which the tier-based `QuickModel` option cannot express; routing is
   gated on OpenRouter being configured anyway. Phase 3 deletes the file, so
   this is a one-line import to remove, not a dependency to unwind.

### 2a. Settings fields (`shared/types/agentSettings.ts`)

Keep, with rewritten doc-comments:

- `openRouterApiKey` — no longer "enables the OpenRouter provider". It is now the
  credential for utility completions **and** the account-wide fallback for ACP
  agents (`claude.ts` reads `acpOpenRouterApiKey?.trim() || openRouterApiKey?.trim()`).
- `openRouterBaseUrl` — read by `openrouter-models.ts` for the catalog and by the
  new completion client.

Add:

- `openRouterUtilityCompletions?: boolean` — explicit opt-in.
- `openRouterUtilityHaikuModel?`, `openRouterUtilitySonnetModel?`,
  `openRouterUtilityOpusModel?` — replace the hardcoded `QUICK_MODEL_TO_OPENROUTER`
  map in `quick-completion.ts`. Blank ⇒ `~anthropic/claude-{tier}-latest` (OR's
  own server-resolved aliases). Naming matches the existing
  `claudeCodeOpenRouter*Model` convention.

**Migration**: alongside the existing `migrateOpenRouterRoutingModels` in
`services/agent-settings.ts`, set `openRouterUtilityCompletions: true` on load
when an `openRouterApiKey` is already present and the flag is absent. Without
this, everyone relying on today's implicit OR fallback silently loses title
generation on upgrade. These are settings-JSON fields, **not** `shared/types/stream.ts`
— the wire-compat rules do not apply.

### 2b. The client — `backend/src/services/openrouter-completion.ts` (new, ~100 LOC)

```
runOpenRouterCompletion({ systemPrompt, prompt, model, effort, signal })
  → { text, usage: { inputTokens, outputTokens, costUsd }, durationMs }
```

- `POST {base}/chat/completions` with `Authorization: Bearer`, `X-Title: callboard`
  (mirrors the old `appTitle`).
- Body: system + user message, `reasoning: { effort }`, `usage: { include: true }`.
  **No `tools`** — no caller passes any, so none of the `return_result` MCP
  apparatus is needed on this path.
- Answer is `choices[0].message.content`.
- Map `usage.prompt_tokens` / `completion_tokens` / `cost` onto the existing
  `QuickCompletionResult.usage` shape so the four helper functions are untouched.
- **Retry 2× on 429/5xx/network with backoff.** This is a real bug fix: HTTP-level
  500s from OpenRouter previously carried no `statusCode` property, so the
  harness's retry never fired.
- `AbortSignal` timeout ~60s — theme generation on the sonnet tier is the long pole.

Use plain `fetch`. Do **not** add `@openrouter/sdk` as a runtime dependency:
`openrouter-models.ts` already talks to the OR API this way, and the surface
needed here is one non-streaming POST. (`@openrouter/sdk` is currently in the
lockfile only transitively via the harness, so it disappears in Phase 3 anyway.)
`@openrouter/agent` is the wrong tool outright — it is an agent loop; this is a
one-shot.

Factor the base-URL resolution currently inside `openrouter-models.ts`
(`resolveModelsUrl`) into a shared helper so the catalog and the client cannot
disagree about which endpoint the key belongs to.

### 2c. Rewire `services/quick-completion.ts`

- Delete `QuickCompletionOptions.provider` and `.openRouterModel`,
  `canRunQuickCompletion`, `resolveQuickCompletionProvider`,
  `buildOpenRouterExtras`, `QUICK_MODEL_TO_OPENROUTER`, and the
  `OpenRouterOptionsExtras` import.
- Drop the `provider` argument from `generateChatTitle` / `generateBranchName`
  and their call sites (`services/claude.ts`, `routes/git.ts`, `routes/stream.ts`).
  "Prefer the chat's own harness" was only meaningful while OR *was* a harness;
  with two backends differing solely in credential it is dead weight.
- `quickCompletion()` becomes a two-branch dispatch:
  - OR utility client when `openRouterUtilityCompletions` is on and a key exists;
  - else the Claude Code SDK path — which additionally gains
    `...getApiEnvOverrides()` in its `env` spread. This is a **bug fix on its own**:
    that path currently spreads only `process.env`, unlike every other SDK call
    site, so a user with `claudeCodeUseOpenRouter` on was not getting their
    override applied to utility calls.
- Keep the `return_result` MCP server, `allowedTools`, `RETURN_RESULT_INSTRUCTION`
  and the drain loop — but only on the claude-code branch.

### 2d. Settings UI (`frontend/src/pages/settings/ApiSettings.tsx`)

Keep the OpenRouter entry in the provider tab row, relabelled — it is no longer a
harness tab, it is the OpenRouter service config. `activeProvider` and
`providerReferenceLinks` are keyed on `AgentProviderKind`, which `"openrouter"`
is leaving; widen to a local `type SettingsTab = AgentProviderKind | "openrouter"`.

Section contents:

- **Keep**: reference links (the existing usage/billing/limits entries are exactly
  right for a credential page), API key `SecretField`, base URL.
- **Add**: the `openRouterUtilityCompletions` toggle labelled for what it does
  ("Use OpenRouter for chat titles, branch names and themes"), the three tier
  fields using the existing `OpenRouterModelSelector` so slugs come from the live
  catalog, and a one-line note that this key also backs ACP agents when
  `acpOpenRouterApiKey` is blank.
- **Delete**: default chat model, logs root, spend cap, the server-tools block and
  the param-profile block with its helpers.

`OpenRouterModelSelector` itself **stays** — the Claude-Code-via-OR and
Codex-via-OR pickers use it.

### 2e. Tests

`quick-completion.test.ts` and `quick-completion.generateTheme.test.ts` currently
mock an agent provider; rewrite against a mocked `fetch`. Add: shared base-URL
resolution, retry-on-5xx, usage mapping, missing-key error, and the settings
migration (alongside `agent-settings.openRouterEndpoint.test.ts`).

## Phase 3 — Delete the engine

- Delete `backend/src/agents/adapters/openrouter/` entirely (30 files, ~8,950 LOC).
- Delete model routing: `services/model-routing.ts`, `services/model-routing-tools.ts`,
  `services/model-routing-config-tools.ts`, `shared/types/modelRouting.ts`,
  `frontend/src/pages/settings/ModelRoutingSettings.tsx`,
  `frontend/src/components/ModelRouterField.tsx`, plus the `modelRouting` /
  `modelRoutingRankId` threading in `services/claude.ts`, `routes/stream.ts`,
  `routes/chats.ts`, `services/tool-provider-args.ts`, `frontend/src/pages/Chat.tsx`,
  and the routing tools in `services/mcp-tool-registry.ts`.
- Delete `shared/types/openrouterCatalog.ts` (763 LOC) — its only non-adapter
  consumers are the settings fields and the OR settings blocks deleted above.
- **Before deleting the adapter**, move `EffortLevel` (re-exported from
  `adapters/openrouter/optionsAdapter.ts`) and `OR_LIBRARY_DEFAULT_MAX_BUDGET_USD`
  into `shared/types/providers.ts`. About 15 import sites in `services/claude.ts`,
  `routes/stream.ts`, `backend/src/index.ts` reach into the adapter for these.
- Remove the `openrouter` cases from `agents/factory.ts` (both registries),
  `agents/permissions/categorizers.ts`, the OR config block in `services/claude.ts`,
  and `"openrouter"` from `AgentProviderKind` / `INTERNAL_PROVIDER_KINDS`.
- Drop `@wolpertingerlabs/openrouter-agent-harness` from `package.json`, and the
  now-orphaned `@openrouter/sdk` devDependency + `overrides` entry.

### Settings triage

Delete — all engine-only:

`openRouterModel`, `openRouterLogsRoot`, `openRouterMaxBudgetUsd`,
`openRouterServerTools`, `openRouterModelParamsDefault`,
`openRouterModelParamProfiles`, `modelRouting`, `openRouterModelAliases` (legacy).

Keep — **these two fail the engine-only test**, verify before touching:

- `openRouterApiKey` — ACP account-wide fallback in `services/claude.ts`.
- `openRouterBaseUrl` — catalog URL resolution in `services/openrouter-models.ts`.

`isOpenRouterConfigured()` loses every consumer except the `openRouterConfigured`
field on the config endpoint, which fed the now-deleted provider toggle. Remove
both; the ACP section reads `settings.openRouterApiKey` directly.

## Phase 4 — Verify the drop-old-chats decision — **DONE**

Outcome: the decision holds, with **two seams that did not implement it** and one
frontend regression introduced by Phase 3. Details below the original text.

Original scope:

Not an implementation phase. The chat list is driven by
`discoverSessionsPaginated()` over the registered session providers, with
`~/.callboard/chats/*.json` records only *augmenting* what filesystem discovery
returns — so deregistering the OR session provider makes those chats vanish
cleanly, with no orphan rows. Confirm that holds at three seams:

- `services/card-rollup.ts` / `services/card-membership.ts` — a card with
  OR-backed members loses them from its rollup. The `cardsOnly` filter in
  `routes/chats.ts` drops sessions with no discovered session file. Confirm no
  crash and no empty-card rendering bug.
- `services/chat-lineage.ts` — the lineage index is built from file records, not
  session files, so a claude-code chat forked from an OR parent will index a
  parent row that can no longer be opened. Confirm the tree tolerates it.
- `services/job-runner.ts` — job runs referencing OR sessions lose their
  transcripts. Confirm graceful handling.

Roughly 426 of 7,656 chat records reference openrouter, and ~135 session logs
exist under `~/.openrouter-agent-harness/logs/`. Deleting those files is optional
housekeeping, explicitly **not** part of this work.

### What the audit found

**The 426 figure is wrong and was load-bearing.** It counted every chat file
*mentioning* the string. Of 7,665 records, **155** carry
`metadata.provider: "openrouter"`; the other 275 mentions are almost all a
`lastBranch` of `refactor/remove-openrouter-engine` written by this very
refactor's worktrees. Corrected at its three quoted sites (`claude.ts`,
`routes/chats.ts`, `agents.integration.test.ts`).

**The decision's premise is right; two structures did not follow it.** The rule
is "filesystem discovery decides what is live", and three paths read chat
*records* instead:

1. `routes/cards.ts` passes `chatFileService.getAllChats()` to
   `buildCardSummaries` — the rollup never consults discovery at all. The plan
   predicted a card would *lose* OR members; the opposite was true. They stayed,
   counted toward `chatCount`, and could carry `unread` — a board that disagrees
   with the sidebar about how many chats a card has. **Fixed** in
   `card-rollup.ts`.
2. The lineage-append pass in `routes/chats.ts` reaches outside the pagination
   window by file record and falls back to the bare record when no session is
   discovered — so an OR *parent* of a surviving claude-code child was appended
   to the sidebar as a live row. **Fixed**; the child stays and folds under a
   dangling root, which is the deleted-parent case `rootKeyOf` and the client's
   `lineageOf` already agree on.
3. `buildChatTree` also walks records — deliberately, and **left alone**. It is
   documented as a walk over stored records, and the tree is how you see where a
   chat came from. It reports the real `provider`, which is now badged honestly.

**Phase 3 regressed the frontend.** Collapsing `chatProvider` to the live kinds
made a legacy OR chat render as a Claude Code chat: "CC" badge, "Claude is
thinking", an Anthropic model popover, a fork entry the route 400s. The comment
at `Chat.tsx` claiming the popover is hidden for a retired harness survived the
behaviour it described. **Fixed** — `ProviderBadge` now tags a retired harness
by name, and `composerProvider` / `forkSourceProvider` are null for one.

**Clean, verified by fixture, nothing changed:** `card-membership.ts` (pure
metadata, never resolves a session), `folder-service.ts` and `folder-summaries.ts`
(discovery-driven, so OR chats vanish and `mostRecentChatProvider` can never name
one), `utils/session-log.ts` and `utils/chat-lookup.ts` (both return
null/`session_log_path: null` for an unresolvable session), the `cardsOnly` filter
(drops sessions with no stored record *before* augmentation, so it was already
correct), and `job-runner.ts` — a step naming the removed harness fails that step
with the actionable message via `handleAttemptSpawnFailure`, and
`readFinalAssistantText` degrades to `""` when no provider resolves the session.

**Known items, both resolved.** `RetiredProviderError` now answers **410 Gone**
(not 500) through a shared `utils/route-errors.ts`, applied to
`POST /api/chats/:id/message` and to `POST /api/queue/:id/execute`, which had the
same defect. The stranded `meta.provider === "openrouter"` in the effort branch
is gone — it sat ahead of the refusal, so it really could write an effort value
onto a chat that can never run.

**Observed, deliberately not changed:** `GET /api/chats/:id/messages` resolves an
unknown provider kind to `getSessionProviders()[0]`, so an OR chat's session ids
are parsed by the Claude Code provider, find nothing, and return `[]`. The
outcome is right (empty transcript, no crash) but it is right by accident rather
than by rule. Out of scope for this phase.

`RETIRED_PROVIDER_KINDS` / `isRetiredProvider` in `agents/ports/AgentProvider.ts`
is the third state the two existing guards could not express: not routable, not
internal, and *not unknown either* — `isInternalProvider` answers false for
`"openrouter"` and for a typo alike, and the two want opposite handling.
