# Plan: Codex Adapter — subscription-auth third provider, rollout as a callboard job

Add **OpenAI Codex** (`@openai/codex-sdk`) as the third agent provider in callboard,
alongside `claude-code` and `openrouter`, authenticating against a **ChatGPT
subscription** (this is a personal machine — subscription auth is the primary path, raw
API key is the fallback). This plan is written to be fed **directly into a callboard job**:
every implementation slice is expressed as a job step with a prompt sketch, declared
outputs, and a green-build gate, ordered so no step forward-references a later step's
outputs.

Status: **Ready to build.** Supersedes `plans/codex-adapter.md` (written pre-OpenRouter-
adapter; did not cover subscription auth or job-structured rollout). Keep the old file for
history; build from this one.

---

## Why this, and what it is *not*

- **It is** a third *engine* for the same callboard chat/session surface: OpenAI-native
  agentic coding (gpt‑5.x) with Codex's own tool loop, sandbox, and apply-patch.
- **It is not** a Claude replacement. Per the in-repo deep research
  (`deep-research-claude-agent-sdk-alternatives.md` §2.1, §4.1), Claude is post-trained
  for the Claude Code harness (Terminal-Bench #33 generic → #5 in-harness) and Codex's SDK
  has **no official Claude/local-model path** — it's OpenAI-first. So Codex is the right
  third option *for OpenAI models*, not a drop-in swap. Keep quick-completions (titles,
  branch names) on Claude regardless of session provider.
- **Closest precedent = the OpenRouter adapter.** It is fully built and is the structural
  template for everything here: deferred/async run construction, an event-translation
  `messageAdapter`, an `optionsAdapter` that maps callboard's Claude-SDK-shaped options
  into engine options, a `toolAdapter`, and a `SessionProvider` that scans an on-disk log
  tree. Mirror its file layout and test patterns. Where this plan is terse, read the
  corresponding `backend/src/agents/adapters/openrouter/*` file.

---

## The two things that make Codex different (design crux)

Everything novel about this adapter reduces to two facts. Both are de-risked by **Step 1
(the spike)** before any production code is written.

1. **Subscription auth via the CLI's stored credentials.** The SDK wraps the `codex` Rust
   CLI and inherits whatever auth the CLI holds. `codex login` performs a ChatGPT OAuth
   flow and writes credentials to `$CODEX_HOME/auth.json` (default `~/.codex`). Constructing
   `new Codex({})` **without** an `apiKey` then uses the subscription, drawing on the
   ChatGPT plan rather than API billing. So callboard does **not** set `OPENAI_API_KEY` in
   subscription mode — it points `CODEX_HOME` at a dir where the user has logged in and
   leaves auth to the SDK (including token refresh). ToS note: subscription-login Codex is
   scoped to *personal* use — acceptable here (personal box), not for shared infra.

2. **Codex is an MCP *client*, not an in-process tool host.** Claude Code and OpenRouter
   both receive callboard's ~48 tools *injected in-process* via `createSdkMcpServer`. Codex
   instead **connects out** to MCP servers declared in its config (`mcp_servers.<name> =
   { command, args, env }`). So callboard must *serve* its tool specs over MCP **stdio** and
   hand Codex a spawn command. This is the single highest-risk piece — it gets its own step
   with extra retry budget and a "one tool first, prove connectivity" rule.

Secondary differences, all minor: Codex lacks a native `abort()` (GitHub issue #5494) →
kill the subprocess; Codex default-requires a git repo → pass `skipGitRepoCheck: true`;
session-file format on disk is undocumented → captured empirically in Step 1.

---

## Architecture

### Backend — new adapter (mirror `adapters/openrouter/`)

```
backend/src/agents/adapters/codex/
  CodexAdapter.ts          # AgentProvider: thread start/resume, query() → CodexAgentQuery
  CodexAgentQuery.ts       # AgentQuery: async-iterates translated events; close()=kill subprocess
  messageAdapter.ts        # Codex stream items → AgentEvent union (events.ts)
  optionsAdapter.ts        # callboard options (Claude-shaped) → Codex Thread/Turn options
  permissionAdapter.ts     # callboard DefaultPermissions → sandbox_mode + approval_policy
  toolAdapter.ts           # ToolServerSpec → MCP-stdio server config (+ shim launcher)
  CodexSessionProvider.ts  # SessionProvider: scan $CODEX_HOME/sessions
  sessionParser.ts         # Codex session files → ParsedMessage[]
  mcp-server-shim.ts       # standalone: serves a ToolServerSpec over MCP stdio (Codex connects here)
  *.test.ts                # unit tests per adapter, fixtures captured in Step 1
```

### Backend — wiring touch points (exact, from code exploration)

| File | Change |
| --- | --- |
| `backend/src/agents/ports/AgentProvider.ts:52` | `"codex"` already in `AgentProviderKind` — no change |
| `backend/src/agents/factory.ts:51` | replace the `throw` with `return new CodexAdapter(...)` |
| `backend/src/agents/factory.ts:110` | add `new CodexSessionProvider()` to the providers array |
| `backend/src/services/claude.ts:48` | add `"codex"` to `ROUTABLE_PROVIDER_KINDS` (makes it user-routable) |
| `backend/src/services/claude.ts` (≈1070) | build `options.codex` sub-object from settings (mirror the `options.openRouter` block) |
| `backend/src/services/agent-settings.ts:85` (`getApiEnvOverrides`) | inject `CODEX_HOME` always; inject `OPENAI_API_KEY`/`OPENAI_BASE_URL` only in api-key mode |
| `backend/src/services/callboard-tools.ts` (≈678) | add `list_codex_models` tool (optional; can hardcode gpt‑5.x list v1) |
| `shared/types/agentSettings.ts` (≈114) | add `codexAuthMode`, `codexApiKey`, `codexBaseUrl`, `codexModel`, `codexHome`, `codexSandboxMode` |

### Frontend — touch points (exact, from code exploration)

| File | Change |
| --- | --- |
| `shared/types/providers.ts:16` | `UiAgentProviderKind = "claude-code" \| "openrouter" \| "codex"` |
| `frontend/src/utils/localStorage.ts:93` | add `"codex"` to `KNOWN_PROVIDERS` |
| `frontend/src/components/ProviderConfigPicker.tsx:185` | third provider button "Codex"; conditional model/sandbox controls |
| `frontend/src/components/ProviderBadge.tsx:14` | add `provider === "codex"` → label `"CX"` + styling |
| `frontend/src/pages/settings/ApiSettings.tsx:473` | third provider tab; Codex section with **auth-mode toggle** + model + sandbox |
| `frontend/src/components/CodexModelSelector.tsx` | new (or reuse ClaudeModelSelector pattern); gpt‑5.x + `o`-series |
| `frontend/src/pages/Chat.tsx` (≈2850/2890) | composer label arms for `codex`; effort control stays OR-only |
| `frontend/src/components/MessageBubble.tsx` | no change — adapter normalizes Codex items to standard tool_use/tool_result; cost via `usage.costUsd` if Codex reports it |

### Settings — auth-mode shape (the subscription-auth UX)

```ts
// shared/types/agentSettings.ts
codexAuthMode?: "subscription" | "api-key";  // default "subscription"
codexApiKey?: string;     // OPENAI_API_KEY — only used when mode === "api-key"
codexBaseUrl?: string;    // OPENAI_BASE_URL override — api-key mode
codexModel?: string;      // default model, e.g. "gpt-5.5"
codexHome?: string;       // CODEX_HOME (default ~/.codex) — where auth.json + sessions live
codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
```

ApiSettings Codex section renders:
- **Auth mode** toggle: *Subscription (ChatGPT login)* | *API key*.
  - Subscription: show login status (does `$CODEX_HOME/auth.json` exist + parse?) and the
    one-liner hint `codex login` (the user runs it once in a terminal; v2 could add a
    "Login" button that shells out). No key field.
  - API key: OPENAI_API_KEY + optional base URL fields (mirrors OpenRouter section).
- **Model** picker (CodexModelSelector).
- **Sandbox mode** select (maps to Codex sandbox; see permission table below).
- Backend exposes `codexConfigured` on `GET /api/system-info` (true when subscription
  auth.json parses OR an api key is set), same pattern as `openRouterConfigured`.

---

## Event, option, and permission mappings

### Codex stream item → `AgentEvent` (`messageAdapter.ts`)

Confirm exact event names against the Step-1 capture; expected shape:

| Codex item / event | AgentEvent |
| --- | --- |
| `ThreadStarted` | `{ type: "session_started", sessionId: threadId }` |
| `ItemUpdated` agentMessage delta | `{ type: "text", content }` |
| `ItemStarted` reasoning | `{ type: "thinking", content }` |
| `ItemStarted/Completed` commandExecution | `tool_use` / `tool_result` (toolName `"Bash"`, content=output) |
| `ItemStarted/Completed` fileChange | `tool_use` / `tool_result` (toolName `"Edit"`, content=diff) |
| `ItemStarted/Completed` mcpToolCall | `tool_use` / `tool_result` (toolName `server__tool`) |
| `ItemStarted/Completed` webSearch | `tool_use` / `tool_result` (toolName `"WebSearch"`) |
| context compaction | `{ type: "compaction_boundary" }` |
| `TurnCompleted` | `{ type: "result", status: "success", usage, durationMs }` |
| `TurnFailed` | `{ type: "result", status: "error", reason }` |

`usage` → `TokenUsage { inputTokens, outputTokens, costUsd? }`. In subscription mode Codex
may not report USD cost — leave `costUsd` undefined (UI already guards `costUsd != null`).

### callboard options → Codex (`optionsAdapter.ts`)

| callboard option | Codex |
| --- | --- |
| `cwd` / folder | `working_directory` (+ `skipGitRepoCheck: true`) |
| `systemPrompt` | write temp file → `model_instructions_file` |
| `model` | `model` (resolve via settings default) |
| `resume: sessionId` | `codex.resumeThread(threadId)` else `startThread()` |
| `abortController` | no native abort → `close()` kills subprocess (issue #5494) |
| DefaultPermissions | `sandbox_mode` + `approval_policy` (below) |

### Permissions → sandbox/approval (`permissionAdapter.ts`)

| callboard permissions | sandbox_mode | approval_policy |
| --- | --- | --- |
| all deny / read-only | `read-only` | `on-request` |
| fileWrite allow | `workspace-write` | `on-request` |
| codeExecution + fileWrite allow | `danger-full-access` | `never` |
| any "ask" | (as above) | `on-request` |
| all allow | (as above) | `never` |

---

## Rollout as a callboard job

The build is decomposed into **agent steps** (each produces a verified branch/PR), with an
**approval gate** after design signoff and before deploy, and a **gate + bounded rework**
loop around the riskiest step. This honors two house lessons:

- *Strict template refs* (`lesson-callboard-job-template-refs`): a step prompt may only
  reference `{{steps.X.outputs.Y}}` for a step **already run**. The order below is a DAG with
  no forward references — each step consumes only the prior branch and Step‑1 findings.
- *Work/rework split*: an `agent` step gets to green itself (runs `/lint-nodejs` +
  `npm test`), then **emits a verdict**; a following `gate` reads the verdict and loops
  back to a dedicated **rework** step on failure rather than retrying blind.

Recommended gating for a personal-machine build: **two approval gates** (after the spike,
before deploy) and an automated green-build gate after each code step. (A fully autonomous
variant — no human gates, per `project-prompt-classifier` — is possible but not advised
here since this modifies your daily driver.)

Each `agent` step's standard contract (state once in the job `defaults`, not per prompt):
> Work on branch `feat/codex-<slice>` off the previous step's branch. Implement only this
> slice. Run `npm run build`, `npm run lint:all`, and `npm test` until green. Commit. Report
> `complete_job_step` with `outputs.branch`, `outputs.build_status` ("pass"|"fail"),
> `outputs.summary`, and `outputs.notes` (anything the next step needs).

### Step sequence

| # | id | type | Purpose / prompt sketch | Declared outputs |
| --- | --- | --- | --- | --- |
| 0 | `spec-signoff` | approval | Show this plan. "Approve the Codex provider design before building." | — |
| 1 | `spike` | agent | In a scratch dir, `npm i @openai/codex-sdk`; `codex login` (subscription); run a script that `startThread()` + `runStreamed("create hello.txt")`; **capture** the raw event/item stream and the on-disk session-file format under `$CODEX_HOME/sessions`. Confirm: (a) `new Codex({})` with no apiKey uses subscription auth; (b) token refresh works headless; (c) current SDK version + whether `abort()` exists. | `sdk_version`, `event_schema` (sample JSONL), `session_format` (path + format notes), `subscription_ok` ("yes"/"no"), `findings` |
| 2 | `spike-gate` | gate | `subscription_ok == "yes"`. onPass→`scaffold`; onFail→`notify` (surface the blocker; subscription path may need a workaround). maxLoops 0. | — |
| 3 | `scaffold` | agent | Backend wiring only (no logic): add `codex*` settings fields + `getApiEnvOverrides` injection; `factory.ts` import `CodexAdapter`/`CodexSessionProvider` (stubs throwing "WIP"); `ROUTABLE_PROVIDER_KINDS += codex`; shared `UiAgentProviderKind += codex`; `KNOWN_PROVIDERS += codex`. Build/typecheck/existing tests green. Uses `{{steps.spike.outputs.session_format}}` to shape the settings. | `branch`, `build_status`, `summary` |
| 4 | `adapter-core` | agent | Implement `CodexAdapter` + `CodexAgentQuery` + `messageAdapter` per `{{steps.spike.outputs.event_schema}}`. Unit tests from captured fixtures. Subprocess `close()`=kill. | `branch`, `build_status`, `summary` |
| 5 | `options-perms` | agent | `optionsAdapter` + `permissionAdapter` (sandbox/approval table), system-prompt temp file, **subscription-vs-api-key Codex construction**. Tests. | `branch`, `build_status`, `summary` |
| 6 | `tool-bridge` | agent | **Highest risk.** `mcp-server-shim.ts` (serve a `ToolServerSpec` over MCP stdio) + `toolAdapter.ts` (emit Codex `mcp_servers` config). **Prove one tool connects end-to-end first**, then wire all specs. Tests + a live connectivity check. `retry: { attempts: 3 }`. | `branch`, `build_status`, `connectivity` ("pass"/"fail"), `summary` |
| 7 | `tool-bridge-gate` | gate | `connectivity == "pass"`. onPass→`session-provider`; onFail→`tool-bridge-rework`. maxLoops 2. | — |
| 8 | `tool-bridge-rework` | agent | `next: tool-bridge-gate`. Fix MCP-stdio connectivity using the failing run's logs; reduce to a minimal repro server if needed. | `branch`, `connectivity`, `summary` |
| 9 | `session-provider` | agent | `CodexSessionProvider` + `sessionParser` against `{{steps.spike.outputs.session_format}}`: discover/resolve/parse/preview/search/delete under `$CODEX_HOME/sessions`. Tests. | `branch`, `build_status`, `summary` |
| 10 | `wire-e2e` | agent | Flip factory stubs to real; build `options.codex` in `claude.ts` `sendMessage` from settings; route a real Codex chat end-to-end (subscription auth) headlessly; verify streaming + a tool call + resume. | `branch`, `build_status`, `e2e_status`, `summary` |
| 11 | `frontend` | agent | ProviderConfigPicker 3rd button; ApiSettings Codex tab with **auth-mode toggle** (subscription status + api-key fields); `CodexModelSelector`; ProviderBadge "CX"; Chat composer label arms; `codexConfigured` on system-info. `npm run build:frontend` + lint green. | `branch`, `build_status`, `summary` |
| 12 | `integration` | agent | Full manual+automated verify via the `/verify` flow: launch app, create a Codex (subscription) chat in the UI, run a small coding task, confirm streaming/tools/cost/resume/badge, and a regression pass that Claude + OpenRouter chats still work. Report verdict + screenshots. | `verdict` ("pass"/"fail"), `report`, `branch` |
| 13 | `deploy-gate` | approval | "Integration verdict = {{steps.integration.outputs.verdict}}. Approve deploy to your local callboard?" onReject→fail. | — |
| 14 | `deploy` | agent | Merge the chain to `main`; `npm run build`; reload the running instance (`npm run reload:local` / pm2 reload); smoke-test that callboard restarts and a Codex chat works. | `deploy_status`, `commit`, `summary` |
| 15 | `done` | notify | "Codex provider live as the third option (subscription auth). PR(s): …" | — |

Notes for the job author (when you build it later):
- Set job `defaults`: `{ folder: "/home/cybil/callboard", provider: "claude-code",
  notifyChannel: "discord" }` — **build the Codex provider *using* Claude/OR**, naturally.
- `limits`: `{ maxTotalSessions: 30, maxDurationHours: 24 }`.
- Steps 4/5/9/11 can be **collapsed or parallelized** in a v2 job (parallel groups are
  deferred in `jobs.md`); keep them sequential for v1 since 4→5→9→10 share the branch.
- Every code step references **only** the prior branch and `spike` outputs — no forward
  refs, so template validation passes at spawn time.

---

## Testing & coverage

- **Unit** (vitest): `messageAdapter` (fixtures from Step 1), `optionsAdapter`,
  `permissionAdapter`, `sessionParser`, `toolAdapter` config emission. Mirror the
  `adapters/openrouter/*.test.ts` table-driven style.
- **Integration**: inject a `MockAgentProvider` scripted with Codex-shaped events through
  `setAgentProviderForTesting` (factory already supports this) to prove port compliance
  without spawning the real CLI.
- **Live connectivity** (Step 6): a guarded test that actually spawns the MCP shim and has
  a stub Codex client connect — the one place we exercise real stdio.
- **Coverage**: callboard has **no enforced coverage gate** (no vitest thresholds) — so
  unlike the openrouter-agent-harness repo (which has a strict global gate, see
  `lesson-or-coverage-gate`), we're not fighting a number here. Still, match the adapters'
  existing density. **Caution on SDK mocks** (`lesson-sdk-callback-mocks`): don't invoke
  Codex SDK callbacks directly from a mock — drive the actual event stream the SDK would
  emit, or you'll bypass real gating.

---

## Key risks

1. **MCP-stdio tool bridge (Step 6)** — the only genuinely new mechanism (Claude/OR inject
   in-process; Codex connects out). Mitigation: dedicated step, one-tool-first, gate +
   bounded rework loop, 3 attempts.
2. **Subscription auth headless** — does `new Codex({})` pick up `$CODEX_HOME/auth.json`
   and refresh tokens when run under pm2 (non-interactive)? De-risked in Step 1; if it
   needs an interactive refresh, fall back to api-key mode and file a follow-up.
3. **No native abort (#5494)** — kill the subprocess on `close()`; revisit when the SDK
   ships `abort()`.
4. **Session-file format drift** — undocumented and version-dependent; keep `sessionParser`
   thin and version-check `sdk_version` on boot.
5. **Cost reporting** — subscription mode likely omits USD cost; UI already guards on
   `costUsd != null`, so this degrades gracefully (no cost line shown).
6. **ToS** — subscription-login Codex is personal-use only; fine on this box, do not ship
   this auth mode to shared/hosted callboard.

---

## References

- Plan it supersedes: `plans/codex-adapter.md`
- Precedent adapter: `backend/src/agents/adapters/openrouter/` (esp. `OpenRouterAdapter.ts`,
  `messageAdapter.ts`, `optionsAdapter.ts`, `OpenRouterSessionProvider.ts`)
- Ports: `backend/src/agents/ports/{AgentProvider,SessionProvider,events,tools}.ts`
- Jobs system: `plans/jobs.md`; MCP tools `create_job` / `spawn_job` / `complete_job_step`
- In-repo research: `deep-research-claude-agent-sdk-alternatives.md` (§2.1 Codex, §4.1 harness effect, §5 Callboard paths)
- `@openai/codex-sdk` — https://www.npmjs.com/package/@openai/codex-sdk · https://developers.openai.com/codex/sdk
- Codex auth (ChatGPT login) — https://developers.openai.com/codex/auth
- Abort feature request — https://github.com/openai/codex/issues/5494
</content>
</invoke>
