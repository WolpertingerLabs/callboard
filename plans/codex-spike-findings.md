# Codex adapter — Step 1 spike findings

**Source of truth** for the Codex provider build (later steps read this). Produced by
`feat/codex-spike` on a personal Linux machine, 2026-06-14. Spec: `plans/codex-adapter-job.md`
(§"design crux", Step 1 `spike`). Scratch dir: `/tmp/codex-spike`.

## TL;DR / declared outputs

- **`sdk_version`**: `@openai/codex-sdk@0.139.0` (pulls native CLI `@openai/codex@0.139.0`,
  platform pkg `@openai/codex-linux-x64`, default model **gpt-5.5**).
- **`subscription_ok`**: **yes** — `new Codex({})` with **no `apiKey`** ran a full streamed
  turn (file creation), resumed a thread, and reported usage, drawing on the ChatGPT
  subscription via `~/.codex/auth.json` (`auth_mode: "chatgpt"`, `OPENAI_API_KEY: null`).
- **`abort()`**: there is **no `Thread.abort()` method**. BUT abort works: `TurnOptions.signal`
  (an `AbortSignal`) is wired straight into `child_process.spawn({ signal })`. Aborting kills
  the subprocess and the event stream throws `AbortError`. This is *better* than the plan
  assumed — callboard's existing `abortController` passes straight through as `turnOptions.signal`;
  no manual subprocess bookkeeping needed.
- **session files**: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<thread_id>.jsonl`,
  one JSONL "rollout" per thread; **resume appends to the same file**. Format below.

---

## 1. Install & binary layout

`npm i @openai/codex-sdk` in a clean dir pulled **3 packages**:
- `@openai/codex-sdk@0.139.0` — pure TS, ships only `dist/` (ESM, `"type":"module"`).
- `@openai/codex@0.139.0` — a Node launcher `bin/codex.js` (selects platform binary).
- `@openai/codex-linux-x64` (optionalDependency) — the **233 MB Rust binary** at
  `node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`, plus
  bundled `rg` and `bwrap` (bubblewrap sandbox helper).

The SDK locates the binary itself via `require.resolve('@openai/codex/package.json')` →
platform pkg `vendor/<triple>/bin/codex`. It also prepends `vendor/<triple>/codex-path`
(the bundled `rg`) to `PATH`. **No global `codex` install needed** — the SDK shells out to
the vendored binary. (A global `codex` CLI is NOT on PATH on this box; everything works
from `node_modules`.)

## 2. How the SDK actually invokes the CLI (read from `dist/index.js`)

This matters for every adapter file. The SDK is a thin wrapper over:

```
codex exec --experimental-json [--config k=v ...] [--model M] [--sandbox MODE] \
           [--cd WORKDIR] [--add-dir D ...] [--skip-git-repo-check] \
           [--output-schema FILE] [--image IMG ...] [resume <thread_id>]
```

- **prompt** is written to the child's **stdin** (not argv); **stdout** is JSONL events,
  one event per line, parsed with `JSON.parse` per line.
- **resume** = it appends the `resume <thread_id>` subcommand to the same `exec` invocation.
- **Option → flag mapping** (drives `optionsAdapter.ts`):
  | SDK `ThreadOptions` | CLI |
  | --- | --- |
  | `model` | `--model` |
  | `sandboxMode` | `--sandbox <read-only\|workspace-write\|danger-full-access>` |
  | `workingDirectory` | `--cd` |
  | `skipGitRepoCheck` | `--skip-git-repo-check` |
  | `approvalPolicy` | `--config approval_policy="..."` |
  | `modelReasoningEffort` | `--config model_reasoning_effort="..."` |
  | `networkAccessEnabled` | `--config sandbox_workspace_write.network_access=<bool>` |
  | `webSearchMode`/`webSearchEnabled` | `--config web_search="..."` |
  | `additionalDirectories` | `--add-dir` (repeatable) |
  | `TurnOptions.outputSchema` | writes temp JSON file → `--output-schema` |
  | `TurnOptions.signal` | `spawn({ signal })` (abort) |

### ⚠️ Plan-correcting nuances (read before scaffold/options/settings steps)

1. **`skipGitRepoCheck` is a `ThreadOption`, NOT a `CodexOption`.** The spec's literal
   `new Codex({ skipGitRepoCheck: true })` is wrong — `CodexOptions` only accepts
   `{ codexPathOverride, baseUrl, apiKey, config, env }`. Pass `skipGitRepoCheck` (and
   `model`, `sandboxMode`, `workingDirectory`, `approvalPolicy`, `modelReasoningEffort`)
   to **`startThread(...)` / `resumeThread(...)`** instead. The spike used
   `new Codex({})` + `startThread({ skipGitRepoCheck: true, workingDirectory, sandboxMode, approvalPolicy })`.
2. **`apiKey` maps to `CODEX_API_KEY`, not `OPENAI_API_KEY`.** In `exec.ts`, `args.apiKey`
   sets `env.CODEX_API_KEY`. The plan's `getApiEnvOverrides` note ("inject `OPENAI_API_KEY`")
   is imprecise for the SDK path. Cleanest in api-key mode: pass `apiKey` via the
   `CodexOptions.apiKey` field (SDK turns it into `CODEX_API_KEY`); `baseUrl` via
   `CodexOptions.baseUrl` (→ `--config openai_base_url=...`). No env injection strictly needed.
3. **`CodexOptions.env` REPLACES `process.env` entirely** (does not merge). If you pass
   `env` to construct, the child inherits *only* what you pass — you'd have to include
   `PATH`, `HOME`, `CODEX_HOME`, etc. **Recommendation:** do NOT use the `env` option; set
   `CODEX_HOME` on `process.env` (or the spawning process env) and leave `env` undefined so
   the SDK inherits the full environment. The spike did exactly this.
4. **`CODEX_HOME` is not an SDK concept** — it's an env var the Rust binary reads to locate
   `auth.json` + `sessions/`. callboard controls auth location purely by setting `CODEX_HOME`
   in the process env (per the spec's `getApiEnvOverrides` plan — inject `CODEX_HOME` always).
5. **No streaming text deltas observed.** In `--experimental-json` mode `agent_message`
   arrived as a single `item.completed` with the full `text`; there were **no `item.updated`
   events** at all in either run. So `messageAdapter` should emit `text` on
   `item.completed`/`agent_message` (whole message), not assume incremental deltas. (The
   plan's "`ItemUpdated` agentMessage delta" row did not fire — keep handling for it but it
   may never arrive in this SDK version.)

## 3. Subscription auth — confirmed end-to-end (`subscription_ok = yes`)

- `~/.codex` did **not** exist at start; no global `codex` CLI. **`codex login` is required
  once.** The default `codex login` is a **browser OAuth** flow (writes
  `INFO codex_cli::login: starting browser login flow`) — it spins a localhost callback and
  cannot complete headlessly.
- **Headless-friendly path: `codex login --device-auth`** — prints a URL
  (`https://auth.openai.com/codex/device`) + a one-time code (15-min expiry) and **polls**
  until the user approves on any device. The user completed this; the polling process wrote
  `auth.json` automatically. (`--with-api-key`/`--with-access-token` read creds from stdin
  for the non-subscription paths.) **For the ApiSettings "Subscription" UX, surface
  `codex login --device-auth` as the one-liner** rather than plain `codex login`, since the
  device flow works over SSH / on a server box; plain login needs a local browser.
- `auth.json` (redacted) after subscription login:
  ```json
  {
    "auth_mode": "chatgpt",
    "OPENAI_API_KEY": null,
    "tokens": { "id_token": "<jwt>", "access_token": "<jwt>",
                "refresh_token": "<opaque>", "account_id": "<uuid>" },
    "last_refresh": "<iso8601>"
  }
  ```
  → "configured in subscription mode" test for `codexConfigured` / system-info =
  **`auth.json` exists AND parses AND `auth_mode === "chatgpt"`** (or `OPENAI_API_KEY` set
  for api-key mode). `codex login status` prints `Logged in using ChatGPT`.
- `new Codex({})` (no `apiKey`, `OPENAI_API_KEY`/`CODEX_API_KEY` deleted from env) ran the
  full turn on the subscription — **the primary path works with zero API key**.
- **Token refresh headless (plan risk #2):** `auth.json` carries a `refresh_token` +
  `last_refresh` and the Rust CLI owns refresh. Not forced to expire during the spike, but
  the refresh material is present and the CLI refreshes autonomously, so the pm2/non-interactive
  case should work without re-login until the refresh token itself is revoked/expired.
  *Residual risk:* first run after a long idle may need a refresh round-trip; if a turn ever
  fails with an auth error under pm2, fall back to `--device-auth` re-login (or api-key mode).
- **ToS:** subscription login is personal-use only — fine on this box, do not ship this mode
  to shared/hosted callboard (matches spec risk #6).

## 4. Event stream (`event_schema`) — for `messageAdapter.ts`

Top-level events are `ThreadEvent`s (see `dist/index.d.ts`): `thread.started`,
`turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`,
`item.completed`, `error`. **Note the casing is dotted lowercase** (`thread.started`,
`item.completed`) — NOT the `ThreadStarted`/`ItemUpdated` PascalCase guessed in the plan's
mapping table. Update `messageAdapter` accordingly.

`ThreadItem` types (the `item.*` payload `.item.type`): `agent_message`, `reasoning`,
`command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`.

**Captured success stream** (subscription, `create hello.txt`, `danger-full-access`):
```jsonl
{"type":"thread.started","thread_id":"019ec7f2-cd5d-7823-b2d1-6683c42bfe32"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll create the requested file…"}}
{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-work-4w9RVb/hello.txt","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-work-4w9RVb/hello.txt","kind":"add"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Created `hello.txt` containing exactly `hi from codex`."}}
{"type":"turn.completed","usage":{"input_tokens":22311,"cached_input_tokens":19200,"output_tokens":71,"reasoning_output_tokens":0}}
```

Mapping confirmations / corrections for `messageAdapter`:
- `thread.started` → `{ type: "session_started", sessionId: thread_id }`. ✅
- `item.completed` w/ `agent_message` → `{ type: "text", content: item.text }` (whole text;
  no deltas — see §2.5). ✅ (corrected)
- `item.started/completed` w/ `file_change` → `tool_use`/`tool_result` (`toolName:"Edit"`);
  payload is `{ changes:[{path,kind:"add|update|delete"}], status:"completed|failed" }` — a
  **change list, not a unified diff**. Map `kind` → add/edit/delete; the spec's "content=diff"
  is not literal (no diff text in the SDK event; the diff lives in the session rollout's
  `custom_tool_call` if needed). ✅ (corrected)
- `item.*` w/ `command_execution` → Bash; fields `{command, aggregated_output, exit_code?,
  status}`. (Not exercised — sandbox blocked shell here, see §6, but type is in `d.ts`.)
- `item.*` w/ `mcp_tool_call` → `{server, tool, arguments, result:{content[],…}, error?}` →
  `tool_use`/`tool_result` toolName `server__tool`. (Central to Step 6 tool bridge.)
- `item.*` w/ `web_search` → `{query}`; `reasoning` → `{text}` → thinking; `todo_list` →
  `{items:[{text,completed}]}` (no AgentEvent in plan — could map to a status/plan event or ignore).
- `turn.completed` → `result success` with `usage` = `{ input_tokens, cached_input_tokens,
  output_tokens, reasoning_output_tokens }`. **No `costUsd` / dollar field** in subscription
  mode → leave `TokenUsage.costUsd` undefined (matches plan risk #5). Map
  `inputTokens=input_tokens`, `outputTokens=output_tokens`.
- `turn.failed` → `{ error:{ message } }` → result error. `error` event → fatal `{ message }`.

Full captured samples live in the scratch dir (`/tmp/codex-spike/events*.jsonl`); copy the
representative success stream above into a fixture (`adapters/codex/__fixtures__/`) for
`messageAdapter.test.ts` in Step 4. (Scratch dir is not committed; the JSONL above is the
canonical fixture seed.)

## 5. Session file format (`session_format`) — for `CodexSessionProvider` + `sessionParser`

- **Location:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-with-dashes>-<thread_id>.jsonl`
  e.g. `~/.codex/sessions/2026/06/14/rollout-2026-06-14T17-03-58-019ec7f2-cd5d-7823-b2d1-6683c42bfe32.jsonl`.
  The **`thread_id` is embedded in the filename** (last UUID) and equals the id from
  `thread.started` / used for `resumeThread`. Discovery = walk the dated dir tree and parse
  the trailing UUID (don't assume flat dir like `~/.codex/sessions/*.jsonl`).
- **Resume appends to the SAME rollout file** (verified: the original file grew to include the
  resumed turn). So one file == one thread across many turns. No fork/copy.
- **Format is a "rollout" log, distinct from the SDK event stream** (do NOT reuse
  `messageAdapter`). Line `type`s observed:
  - `session_meta` (line 1) — `payload:{ id, timestamp, cwd, originator:"codex_sdk_ts",
    cli_version:"0.139.0", source:"exec", thread_source, model_provider:"openai",
    base_instructions:{text:<system prompt>} }`. Use `payload.id` as session id,
    `payload.cwd` for the folder, `payload.timestamp` for sort.
  - `response_item` — the durable transcript. `payload.type`:
    - `"message"` with `role: "developer"|"user"|"assistant"`, `content:[{type:"input_text"|"output_text", text}]`.
      Assistant messages carry `phase:"commentary"|"final_answer"`.
      **First two messages are synthetic** and must be filtered by `sessionParser`: a
      `developer` "<permissions instructions>" message and a `user` "<environment_context>"
      message. The *real* user prompt is the next `user`/`input_text`.
    - `"custom_tool_call"` / `"custom_tool_call_output"` — tool invocations (the file patch
      tool used these; full diff/output lives here if a preview wants it).
    - `"reasoning"`, `"function_call"`/`"function_call_output"` — present in the type union.
  - `turn_context` — `payload:{ turn_id, cwd, approval_policy, sandbox_policy:{type},
    model, personality, collaboration_mode, … }` (per-turn settings snapshot).
  - `event_msg` — higher-level event echoes: `task_started`
    (`{turn_id, model_context_window, …}`), `user_message`, `agent_message`,
    `patch_apply_end`, `token_count`, `task_complete`.
- **`sessionParser` recipe:** read `session_meta` for id/cwd/title-seed; iterate
  `response_item` where `payload.type==="message"`, skip the 2 synthetic leads, map
  `role`+`output_text|input_text` → `ParsedMessage[]`. Preview = first real user message
  text. Keep it thin and version-gate on `cli_version` (plan risk #4) — format is
  undocumented and may drift.

## 6. Environment gotcha (not a blocker, but document for `wire-e2e` / deploy)

On this machine, `sandboxMode: "workspace-write"` (the default-ish safe mode) **failed every
file write and shell command** with:
```
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```
Codex's `workspace-write`/`read-only` sandboxing uses bundled **bubblewrap (`bwrap`)**, which
needs network-namespace privileges this environment denies (no `CAP_NET_ADMIN`, restricted
userns). `danger-full-access` (no bwrap) worked perfectly. Implications:
- The spike's clean run used `sandboxMode: "danger-full-access"`, `approvalPolicy: "never"`.
- For callboard on this box, sandboxed modes may be unusable under the same restrictions —
  the `permissionAdapter` table (Step 5) should be honored, but **expect that on this host
  only `danger-full-access` actually executes**; or configure `bwrap` permissions / run with
  the right namespaces. Flag this for `wire-e2e` (Step 10): test the real intended sandbox
  mode and, if `bwrap` fails, either grant userns/net caps to the callboard process or
  document `danger-full-access` as the working mode on this machine. This does NOT affect
  the auth/streaming/session conclusions above.

## 7. Carry-forward checklist for later steps

- Step 3 `scaffold`: settings = `codexAuthMode("subscription"|"api-key")`, `codexApiKey`
  (→ `CodexOptions.apiKey`), `codexBaseUrl` (→ `CodexOptions.baseUrl`), `codexModel`
  (default `gpt-5.5`), `codexHome` (→ `CODEX_HOME` env), `codexSandboxMode`. `getApiEnvOverrides`:
  always set `CODEX_HOME`; in api-key mode pass key via SDK `apiKey` not env injection.
- Step 4 `adapter-core`: events are dotted-lowercase; agent text whole at `item.completed`;
  `file_change` is a change-list not a diff; usage has no cost. Construct
  `new Codex({})` (+ `apiKey`/`baseUrl` only in api-key mode), thread opts hold
  model/sandbox/cwd/skipGitRepoCheck. `close()` = abort via the `AbortSignal` you passed to
  `runStreamed`, OR kill the subprocess (SDK exposes no handle, so prefer threading
  callboard's `abortController.signal` into `turnOptions.signal`).
- Step 9 `session-provider`: dated dir tree, UUID-in-filename, resume appends, rollout format
  with 2 synthetic lead messages to skip.
- Step 6 `tool-bridge`: `mcp_servers.<name>` via `CodexOptions.config` (the SDK flattens a
  JSON object into `--config key=value` TOML) OR via `config.toml` in `CODEX_HOME`. The
  `mcp_tool_call` item type confirms Codex emits MCP calls in the stream as expected.
</content>
</invoke>
