# pi SDK spike findings

Phase 0 of `plans/pi-adapter.md`. Read against **`@earendil-works/pi-coding-agent`
0.83.0 as installed by this branch**, and — where the types could not answer —
by running the real SDK against a real model. The plan's surface table was
verified against 0.80.2 unpacked from `~/.ori/pi-runtime/`; several things moved
between then and 0.83.0, and one thing the plan assumed was never true.

Companion to `plans/pi-adapter.md`. Everything here is a fact about the package
or an observation from a live run; the adapter design that follows lives in the
plan. Per the plan's own rule, **a contradicted assumption changes the adapter,
not the scope** — §9 is the list.

## What was run

A throwaway harness (`/tmp/pi-spike/spike.mjs`, not committed) against
`openrouter/google/gemini-3.6-flash` with the user's OpenRouter key, an isolated
`agentDir` at `/tmp/pi-spike/agent`, and a scratch git repo at
`/tmp/pi-spike/scratch` containing a project-local pi extension
(`.pi/extensions/evil.ts`) whose **module top level** writes a marker file. That
marker is the instrument for §2: it is written at *load* time, before any model
call and before any tool gate, so its presence is proof that untrusted project
code executed. Total spend was a few cents.

---

## 1. The published surface is narrower than the plan's table

`dist/index.d.ts` re-exports 34 groups. Three symbols the plan's table names are
**not among them**, and the `exports` map is closed, so there is no deep-import
escape hatch:

```
$ node -e 'import("@earendil-works/pi-coding-agent/dist/core/auth-storage.js")...'
deep import BLOCKED: ERR_PACKAGE_PATH_NOT_EXPORTED
  Package subpath './dist/core/auth-storage.js' is not defined by "exports"
```

`package.json` exposes exactly `"."` and `"./rpc-entry"`.

| Plan named | Reality in 0.83.0 |
|---|---|
| `getEnvApiKey(provider)` | Not exported. Verified at runtime: `"getEnvApiKey" in import(...)` → `false` |
| `AuthStorage` / `FileAuthStorageBackend` / `InMemoryAuthStorageBackend` | Exist in `dist/core/auth-storage.d.ts`, **not re-exported**, unreachable |
| `loadExtensionFromFactory(factory, cwd, eventBus, runtime)` | Exists in `dist/core/extensions/loader.d.ts`, **not re-exported**, unreachable |
| `ModelRegistry.create(authStorage, modelsJsonPath)` | No such static. It is `new ModelRegistry(runtime)` over a `ModelRuntime` |

None of these is fatal, because 0.83.0 ships better replacements for all four
(§3, §7). But every one of them is a line in the plan that would not have
compiled.

**`ModelRuntime` is the replacement for the whole auth story** and it *is*
exported:

```ts
static create(options?: {
  credentials?: CredentialStore; authPath?: string; modelsPath?: string | null;
  allowModelNetwork?: boolean; ...
}): Promise<ModelRuntime>;
setRuntimeApiKey(providerId: string, apiKey: string, ...): Promise<void>;
```

`authPath` + `setRuntimeApiKey` satisfies Decisions 3 and 4 without
`InMemoryAuthStorageBackend`: point `authPath` at Callboard's own dir and never
write to it, injecting the key at runtime instead.

## 2. BLOCKING — `createAgentSession()` never resolves project trust, and the default is *trusted*

This is the most important finding in the document and it invalidates the
mechanism the plan calls "the single most important line in the adapter".

The plan assumed the gate is a `project_trust` **extension handler** that the
adapter registers and that denies by default. Two things are wrong with that.

**First, `createAgentSession()` does not resolve trust at all.** `dist/core/sdk.js`:

```js
resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await resourceLoader.reload();          // <-- no resolveProjectTrust
```

Trust resolution lives in `ResourceLoaderReloadOptions.resolveProjectTrust`, and
only pi's **CLI** passes it (`dist/main.js:551`). The SDK entry point the adapter
would call skips it.

**Second, `SettingsManager.create()` defaults `projectTrusted = true`**
(`dist/core/settings-manager.js:153`: `const projectTrusted = options.projectTrusted ?? true`).

The consequence, measured — the scratch repo's trust decision was `null`
(never decided) and the extension ran anyway:

```
hasTrustRequiringProjectResources(SCRATCH) = true
ProjectTrustStore.get(SCRATCH) = null

(a) createAgentSession() default path (no explicit resourceLoader):
    project-local extension EXECUTED at load time? -> true
    loaded extensions = [ "/tmp/pi-spike/scratch/.pi/extensions/evil.ts" ]
    project_trust handler was ever consulted? -> false
```

**A Callboard chat opened on an agent-cloned repository would execute that
repository's TypeScript, in-process, before the first model call.** The plan
worried that a *denied* trust decision might not stop extensions loading. The
truth is worse and simpler: on the SDK path no decision is ever requested.

### The good news: denial genuinely works, and it is genuinely early

Passing `resolveProjectTrust` does everything the plan needs:

```
(b) explicit loader, resolveProjectTrust -> false:
    resolveProjectTrust called; pre-trust extensions = []
    marker exists AT THE MOMENT resolveProjectTrust runs? -> false     <-- fires BEFORE load
    resolveProjectTrust invocations = 1
    project-local extension EXECUTED? -> false                          <-- denial is real
    final extensions = []

(d) noExtensions:true + trust false:
    project-local extension EXECUTED? -> false
    final extensions = []
```

The control confirms the instrument is not lying. In a **fresh process** (the
in-process rerun is masked by jiti's module cache — an artifact worth knowing
about for tests):

```
FRESH PROCESS, trust=true -> extension executed? true
extensions: [ '/tmp/pi-spike/scratch/.pi/extensions/evil.ts' ]
```

`dist/core/resource-loader.js:268` shows why the ordering holds — the bootstrap
pass forces `setProjectTrusted(false)` and loads only user/global extensions, so
the callback runs with project-local code still on disk and not yet evaluated:

```js
if (options?.resolveProjectTrust) {
    preTrustExtensions = await this.loadProjectTrustExtensions();
    const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
    this.settingsManager.setProjectTrusted(projectTrusted);
}
```

### What the adapter must do instead

Not `createAgentSession()`. Use the services split, which accepts both hooks:

```ts
export interface CreateAgentSessionServicesOptions {
  cwd: string; agentDir?: string; settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
  resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;   // <-- resolveProjectTrust
}
```

`createAgentSessionServices()` then `createAgentSessionFromServices()`, with all
three of:

1. `settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false })` — do not rely on the default.
2. `resourceLoaderReloadOptions: { resolveProjectTrust: async () => false }` — until Callboard grows its own trust UI.
3. `resourceLoaderOptions: { noExtensions: true, extensionFactories: [{ name: "callboard-gate", factory }] }` — belt and braces, and the *supported* way to install an inline extension now that `loadExtensionFromFactory` is unreachable.

`extensionFactories` takes `InlineExtension = ExtensionFactory | { name, factory, hidden? }`
and survives `noExtensions: true` — measured in (d) above: the gate loads, the
project's code does not. `noExtensions` governs extensions only; `noSkills`,
`noPromptTemplates`, `noThemes` and `noContextFiles` are separate flags and
project-local skills are also trust-gated.

Also note `ProjectTrustEventResult.trusted` is `"yes" | "no" | "undecided"`, a
tri-state, not a boolean — and `resolveProjectTrusted()` maps anything that is
not `"yes"` to `false`, so fail-closed is the built-in reading.

## 3. The `tool_call` gate fires for every tool, and `{block:true}` is real

The plan's central assumption, and it holds completely. One turn, seven built-ins
plus a `customTools` entry, gate observing every one:

```
tool_call events seen for: [ "ls", "read", "grep", "find", "bash", "write", "edit", "callboard_set_chat_title" ]
custom tool actually executed? -> true
stats: { tokens: { input: 14483, output: 146, total: 14629 }, cost: 0.0228195, toolCalls: 8 }
```

`CustomToolCallEvent` arrives on the same `tool_call` handler as the built-ins —
no separate registration. The handler is genuinely **awaited**: a 300 ms `sleep`
inside it delayed execution rather than racing it.

Blocking works, and the `reason` reaches the model verbatim:

```
  [tool_call ENTRY] bash {"command":"echo pwned > PWNED.txt"}
  [tool_call ENTRY] write {"path":"PWNED.txt","content":"pwned"}

PWNED.txt created on disk? -> false

model's final text:
---
Both operations failed due to permission constraints set by the environment:
1. **Bash command (`echo pwned > PWNED.txt`)**: Failed with message: `Callboard: the
   codeExecution/fileWrite permission axis is set to deny.`
2. **Write tool (`write` to `PWNED.txt`)**: Failed with message: `Callboard: the
   codeExecution/fileWrite permission axis is set to deny.`
---
```

Two ordering facts `messageAdapter` must respect, neither of which is in the plan:

**`tool_execution_start` fires *before* `tool_call`.** Confirmed with a 300 ms
delay inside the gate, so it is not a logging artifact:

```
  [tool_execution_start] bash
  [tool_call ENTRY] bash {"command":"echo pwned > PWNED.txt"}
  [tool_execution_end] bash
```

Rendering "running bash" on `tool_execution_start` therefore shows a tool as
started *before* the permission decision — and for a denied tool, one that never
ran at all. The permission prompt has to be driven from `tool_call`, and the
`tool_use` bubble should not claim execution until `tool_execution_end`.

**A blocked tool emits no *extension* `tool_result` event, but the subscribe
stream is complete.** `messageAdapter` reads the stream, so this is fine — but a
gate that also wants to observe results must not rely on the extension event:

```
STREAM tool_execution_start {"type":"tool_execution_start","toolCallId":"beLQ6aCN","toolName":"bash","args":{"command":"echo pwned > PWNED.txt"}}
STREAM tool_execution_end   {"type":"tool_execution_end","toolCallId":"beLQ6aCN","toolName":"bash","result":{"content":[{"type":"text","text":"DENIED by Callboard axis codeExecution"}],"details":{}},"isError":true}
STREAM message_end(toolResult) {"role":"toolResult","toolCallId":"beLQ6aCN","toolName":"bash","content":[...],"isError":true,...}
```

`tool_execution_end` carries `toolCallId`, `toolName`, `result.content`,
`result.details` and `isError` — everything `AgentEvent.tool_result` needs.

**`tools` is an allowlist over custom tools too.** Passing
`tools: ["read","bash",...]` without naming a `customTools` entry silently drops
that custom tool from the model's tool list. `buildToolFilters()` must append
Callboard's own tool names, or the MCP-equivalent surface disappears whenever any
axis narrows the built-ins. This cost one wasted spike run.

**Seven built-ins, all seven gateable, no web tool.** `getAllTools()` →
`read, bash, edit, write, grep, find, ls`. The plan's note that `webAccess`
governs nothing on pi is confirmed.

## 4. Usage and cost: `message_end`, per-message; `SessionStats`, cumulative

The plan offered three possibilities. The answer is the first, and `turn_end` is
definitively out — it carries no usage at all.

```
[message_end] usage = null                     <-- the *user* message
[message_end] usage = {
  "input": 498, "output": 1, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0,
  "totalTokens": 499,
  "cost": { "input": 0.000747, "output": 0.0000075, "cacheRead": 0, "cacheWrite": 0,
            "total": 0.0007545000000000001 }
}
[turn_end]  keys = ["type","message","toolResults"]      usage = null
[agent_end] keys = ["type","messages","willRetry"]
```

Per-turn vs cumulative, measured across two turns in one session:

```
after turn 1 getSessionStats: { tokens: { total: 490 }, cost: 0.000741 }
after turn 2 getSessionStats: { tokens: { total: 989 }, cost: 0.0014955 }
CUMULATIVE? total went 490 -> 989, cost 0.000741 -> 0.0014955
```

So: **`message_end.message.usage` is per-assistant-message; `getSessionStats()`
is cumulative over the whole session** (its doc-comment says it aggregates over
all entries "including history that was compacted away"). Callboard's `TokenUsage`
is per-turn, so `messageAdapter` maps `message_end`, and `SessionStats` is the
chat-total figure for cost parity (#312) — do not add them together.

One shape correction: `usage.cost` is a **breakdown object**, not a scalar. The
plan's "`cost` → `costUsd`" needs `usage.cost.total`. `SessionStats.cost` *is* a
scalar. `usage` also carries `reasoning`, which the plan's table omits.

`getContextUsage()` → `{ tokens: 490, contextWindow: 1048576, percent: 0.0467 }`.

**Provider errors are not a separate event.** They arrive as a normal assistant
`message_end` with `stopReason: "error"` and an `errorMessage` string:

```
"stopReason":"error","errorMessage":"400: {\"message\":\"Reasoning is mandatory for this
 endpoint and cannot be disabled.\",\"code\":400,...}"
```

(That specific error is worth remembering: `thinkingLevel: "off"` against
`google/gemini-3.6-flash` is a hard 400. The `EffortLevel` → `thinkingLevel`
mapping must not emit `off` for models that mandate reasoning, or fall back on
the error.)

## 5. Hand-written version-3 session files load, resume and round-trip

Decision 1 and `seedSession` are both safe. A file written by hand — header plus
two `SessionMessageEntry` links — parsed, opened, resumed and answered from
context:

```
CURRENT_SESSION_VERSION = 3
wrote /tmp/pi-spike/sessions/spike-seeded-0001.jsonl
parseSessionEntries -> [ {type:"session",id:"spike-seeded-0001"},
                         {type:"message",id:"e1",parentId:null},
                         {type:"message",id:"e2",parentId:"e1"} ]

session.sessionId = spike-seeded-0001
sessionFile = /tmp/pi-spike/sessions/spike-seeded-0001.jsonl
messages loaded into context = 2 ["user","assistant"]
MODEL ANSWER (should be 'persimmon'): "Persimmon"
wrote back into the SAME file we hand-wrote? -> true
```

The seed shape that worked:

```jsonc
{"type":"session","version":3,"id":"spike-seeded-0001","timestamp":"...","cwd":"/tmp/pi-spike/scratch"}
{"type":"message","id":"e1","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"message","id":"e2","parentId":"e1","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
```

Notes that matter for `PiSessionProvider`:

- **The resume API is `SessionManager.open(path, sessionDir?, cwdOverride?)`**, not anything named `fromPath`/`switchTo`. `SessionManager.create()` always starts a *new* session — pointing it at a directory containing the seed silently ignored the seed. Easy and expensive mistake.
- **Callboard can own the session id and the filename.** pi kept `spike-seeded-0001` as `session.sessionId` and appended to our arbitrarily-named file rather than its own `<ISO>_<uuid>.jsonl` convention.
- `entry.id` may be any string; pi's own are 8-hex, ours were `e1`/`e2`, and the chain resolved fine.
- pi injects its own `model_change` / `thinking_level_change` entries into the chain. A parser must skip unknown entry types, not choke on them.
- **`SessionManager.list(cwd, sessionDir)` is `async`** — it returns `Promise<SessionInfo[]>`. `parseSessionEntries` and `loadEntriesFromFile` are sync. `SessionProvider`'s methods are sync, so discovery must be built on the sync pair, not on `list()`. It does populate exactly what discovery wants, including the hand-written file:

```
{ id: "spike-seeded-0001", path: "spike-seeded-0001.jsonl", cwd: "/tmp/pi-spike/scratch",
  messageCount: 2, firstMessage: "My favourite fruit is the persimmon. Remember it.",
  allMessagesText: "My favourite fruit is the persimmon. Remember it. Noted: you..." }
```

- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir)` works and records lineage: `header.parentSession = "/tmp/pi-spike/sessions/spike-seeded-0001.jsonl"` — a **path**, not an id. Callboard's lineage is by chat id, so a translation step is needed after all. All five entries carried across with their ids intact.

## 6. `abort()` ends the turn cleanly; `dispose()` emits nothing

```
*** calling abort() ***
... message_update xN, message_end, turn_end, agent_end, agent_settled
agent_end records: [ { "type": "agent_end", "willRetry": false, "messages": 2 } ]
isIdle = true  isStreaming = false  isRetrying = false

*** calling dispose() ***
events emitted by dispose(): 0 []
```

`dispose()` "removes all listeners and disconnects" before doing anything else,
so by construction it cannot emit to its own subscribers. It does **not** abort —
`close()` must `await session.abort()` *then* `dispose()`, in that order. The
plan has this right; the only correction is that `abort()` returns a `Promise`
and must be awaited, and that `agent_settled` — not `agent_end` — is the true
end-of-activity marker.

The cancel/retry discriminator the plan asks about:

```
message_end stopReason = "aborted"  errorMessage = "Request was aborted"
retry settings: {"enabled":true,"maxRetries":3,"baseDelayMs":2000}
```

`willRetry` is computed by `_willRetryAfterAgentEnd()` from the last assistant
message via `isRetryableAssistantError()`, which is a **regex over the error
text** (`overloaded`, `rate.?limit`, `429`, `50[0-4]`, `fetch failed`,
`socket hang up`, `timeout`, `provider.?returned.?error`, …) minus a
non-retryable list (`insufficient_quota`, `quota exceeded`, `billing`, …).
`"Request was aborted"` matches nothing retryable, so a cancel is always
`willRetry: false`.

**So `willRetry` alone does not distinguish a cancel from a completion** — both
are `false`. The discriminator is `stopReason === "aborted"` on the final
assistant message. `willRetry: true` means only "a retry is coming, this
`agent_end` is not terminal", which is exactly what #317/#318 need it for.
Auto-retry is **on by default** (`maxRetries: 3`), so the `auto_retry_*` →
`adapter_specific` mapping is not optional.

## 7. Auth precedence: the explicit key wins over the environment

```
(a) no key at all      -> getProviderAuthStatus('openrouter') = { "configured": false }
(b) env var only       -> { "configured": true, "source": "environment", "label": "OPENROUTER_API_KEY" }
(c) env(bogus) + setRuntimeApiKey(real):
    find('openrouter','google/gemini-3.6-flash') = openrouter/google/gemini-3.6-flash
    getApiKeyAndHeaders -> { ok: true, apiKeyIsRealKey: true, apiKeyIsEnvBogus: false, headers: [] }
```

With a deliberately bogus `OPENROUTER_API_KEY` in the environment and the real
key injected via `setRuntimeApiKey`, **the injected key is what the request
uses.** Callboard does not need to scrub the environment, and does not need
`registerProvider()` at all for OpenRouter — that API is for adding providers
pi does not know, and `getRegisteredProviderIds()` was `[]` throughout.

`getProviderAuthStatus()` returning `{ configured, source, label }` is directly
usable in the Settings page to show *where* a key came from.

The catalog is genuinely offline-queryable — with `allowModelNetwork: false`:

```
catalog: getAll()=1157 models, getAvailable()=307
openrouter models in catalog = 307  e.g. [ 'ai21/jamba-large-1.7', 'aion-labs/aion-2.0', ... ]
```

`getAvailable()` returned exactly the 307 OpenRouter models — availability is
filtered by which providers have configured auth, which is the right behaviour
for the model picker.

## 8. Weight: the plan's 13.1 MB is the package; the install is 110 MiB

Measured on this branch, same tree, before and after `npm install`.

| | Before | After | Delta |
|---|---|---|---|
| `node_modules` apparent size | 1,260,126,243 B | 1,375,457,694 B | **+115,331,451 B (+110.0 MiB)** |
| `node_modules` file count | 50,933 | 69,623 | **+18,690** |
| `npm publish --dry-run` package size | 4.9 MB | 4.9 MB | **0** |
| `npm publish --dry-run` unpacked size | 22.2 MB | 22.2 MB | **0** |
| `npm publish --dry-run` total files | 4,302 | 4,302 | **0** |

`npm run deps:check` passes unchanged ("20 runtime imports, all declared").

**The published tarball does not move at all**, because `files` ships only
`backend/dist` / `frontend/dist` / `shared/dist` / `bin` and the sole
`bundleDependencies` entry is `@wolpertingerlabs/drawlatch`. The plan's phrasing
— "that tail is landing in a server bundle" — is not what happens. The cost is
paid entirely at **consumer install time**, once, by `npm i -g callboard`.

The 13.1 MB figure is pi's own tarball (`dist.unpackedSize = 13,104,822`,
`dist.fileCount = 884`). The installed tree is 8.8× that, because pi does not
hoist: 110 MiB apparent / 168 MB on disk / 18,690 files. Where it goes:

```
    13.7 MB  @google              12.5 MB  @opentelemetry        9.2 MB  @mistralai
     8.6 MB  web-streams-polyfill  7.2 MB  openai                6.6 MB  @earendil-works
     3.9 MB  @anthropic-ai         3.4 MB  zod                   2.9 MB  protobufjs
     2.7 MB  @aws-sdk              2.2 MB  @silvia-odwyer(photon/wasm)
     1.7 MB  jiti                  1.6 MB  highlight.js          1.4 MB  typebox
```

**Is this alarming? Moderately, and it is not the TUI.** The plan flagged
`pi-tui` / `photon-node` / `highlight.js` / `jiti`; those total under 6 MB. The
actual bulk is `@earendil-works/pi-ai` dragging in the **full vendor SDK
constellation** — Google, Mistral, OpenAI, Anthropic, AWS Bedrock — plus
OpenTelemetry and protobufjs, so that pi can talk to 1,157 models. Callboard
already ships `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` and
`@cline/sdk`; this is a fourth copy of much of that surface, duplicated rather
than shared because pi pins its own nested versions.

It roughly doubles a Callboard install's file count. That is a real cost to state
in the release notes, and a reason to keep the pi import lazy so a user who never
opens a pi chat does not pay the module-load time. It is not a reason to stop.

`npm audit` also newly reports a `undici` advisory reachable only through pi's
nested tree (`node_modules/@earendil-works/pi-coding-agent/node_modules/undici`),
whose only offered remedy is a downgrade to 0.75.3 — i.e. not actionable at the
pin. Worth watching on the next bump.

## 9. Corrections this makes to `plans/pi-adapter.md`

| Plan said | Reality |
|---|---|
| Gate installed via `loadExtensionFromFactory(...)` | Not exported, and deep imports are blocked. Use `resourceLoaderOptions.extensionFactories: [{name, factory}]` |
| Register a `project_trust` handler that denies by default | **`createAgentSession()` never resolves trust and defaults to trusted.** Use `createAgentSessionServices` + `resourceLoaderReloadOptions.resolveProjectTrust`, `SettingsManager.create(..., {projectTrusted:false})`, and `noExtensions:true`. §2 |
| `AuthStorage` over `InMemoryAuthStorageBackend` (Decision 3) | Not exported. Use `ModelRuntime.create({authPath})` + `setRuntimeApiKey()`; same guarantee, different API |
| `ModelRegistry.create(authStorage, modelsJsonPath)` | `new ModelRegistry(modelRuntime)` |
| `getEnvApiKey(provider)` reads `OPENROUTER_API_KEY` | Not exported. Precedence is settled anyway: an explicit `setRuntimeApiKey` beats the env var. §7 |
| Entry is `createAgentSession(opts)` | Use the services split — it is the only entry that accepts the trust hook |
| `session.abort()` then `session.dispose()` | Correct, but `abort()` is `async` and must be awaited; `dispose()` emits nothing and does not abort |
| `agent_end.willRetry` distinguishes cancel from retry | It does not — a cancel and a clean finish are both `false`. Cancel is `stopReason === "aborted"`. §6 |
| usage `cost` → `costUsd` | `usage.cost` is a breakdown object; use `usage.cost.total`. `SessionStats.cost` is the scalar |
| Usage lands on `message_end`/`turn_end`/`SessionStats` (open question) | `message_end` per-message; `SessionStats` cumulative; **`turn_end` has no usage at all**. §4 |
| `tool_execution_start/update/end` → `tool_use`/`tool_result` | Sound, but `tool_execution_start` fires **before** the `tool_call` gate, so it must not render as "executing". §3 |
| `tools`/`excludeTools` from the permission axes | Also filters `customTools` — Callboard's own tool names must be appended to any allowlist or they vanish. §3 |
| `SessionInfo` powers discovery | Yes, but `SessionManager.list()` is **async**; `SessionProvider` is sync, so build on `loadEntriesFromFile`/`parseSessionEntries` |
| `forkFrom` gives lineage agreement | `header.parentSession` is a **file path**, not a session id — a translation step Callboard still owns |
| pi is 13.1 MB with 18 dependencies | 13.1 MB is the tarball. Installed: **110 MiB, 18,690 files**; published tarball unchanged. §8 |
| Resume/seed via a hand-written v3 file | **Confirmed working**, via `SessionManager.open()`. Decision 1 and `seedSession` are safe. §5 |
| `tool_call` fires for every tool; `{block:true}` prevents execution | **Confirmed for all seven built-ins and `customTools`**, handler awaited, reason reaches the model. §3 |

Nothing here changes the plan's **scope or phasing**. Phase 1 remains safe to
start, provided §2 is treated as a Phase 1 acceptance criterion rather than a
detail: the adapter must never call bare `createAgentSession()`.

## 10. Still unverified

Not answerable cheaply, and left for `PiAdapter.live.test.ts` and Phase 1
verification:

1. **`willRetry: true` in the wild.** Forcing a genuine 429/5xx from OpenRouter was not worth the spend. The code path is read (§6) but never observed. The `auto_retry_start` / `auto_retry_end` payloads are typed but unseen.
2. **`streamingBehavior: "steer"` mid-turn.** `queue_update` and the steer/followUp queues are typed; no live interrupt was run.
3. **Compaction.** `compaction_start`/`compaction_end` and the `overflow` reason need a context-window-filling run.
4. **Images.** `PromptOptions.images` takes pi-ai `ImageContent`; the conversion from Callboard's attachment shape is unexercised.
5. **Zod → typebox for `customTools`.** The spike passed a hand-written JSON-Schema-shaped object straight to `defineTool()` and pi accepted it. Whether that holds for Callboard's full Zod tool surface — unions, refinements, optionals — is `toolAdapter.ts`'s real risk and is untested.
6. **Concurrency.** Every run was a single session in a fresh process. Two pi chats sharing one `ModelRuntime`, and the process-wide jiti extension cache (§2, which masked a reload in-process), both need a look before Phase 1 memoizes anything.

## 11. Skills — measured later, wiring callboard's custom skills into pi

Added after Phase 5, when `noSkills: true` turned out to be leaving a shipped pi
capability unused. Nothing here contradicts §2; it refines it in three places
the spike had no reason to look at.

**`additionalSkillPaths` is the skills analogue of `extensionFactories`, and it
survives the blanket disable.** `dist/core/resource-loader.js` keeps the caller's
explicit paths on *both* sides of the flag, and drops only discovery:

```js
const skillPaths = this.noSkills
    ? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
    : this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);
```

`loadSkills` is then called with `includeDefaults: false`, so nothing is scanned
that the caller did not name. Measured: with `noSkills: true` and callboard's
directory passed, the session listed callboard's skill and not the scratch repo's.

**Either trust or `noSkills` alone keeps a repo's skills out.** The spike said
project-local skills "are also trust-gated", which is true and slightly
undersells it — the four cells were never run. They are:

| `projectTrusted` | `noSkills` | repo's `.pi/skills` |
|---|---|---|
| true | false | **loaded** — the only exposed cell |
| true | true | not loaded |
| false | false | not loaded |
| false | true | not loaded — what the adapter ships |

So `noSkills` is defence in depth beside `resolveProjectTrust`, exactly as
`noExtensions` is, rather than the single lock. A first draft of the test asserted
"dropping `noSkills` re-admits the repo's skill" and **failed**, which is how the
matrix got run at all.

**Not loaded is not the same as unreachable, and only the first is a trust
boundary.** A live control with callboard's skill absent confirmed the model
never produces the callboard word — but it *did* produce the project one, by
running `ls`/`find` and reading `.pi/skills/…/SKILL.md` itself. That is ordinary
file reading inside the opened workspace, gated by the `fileRead`/`codeExecution`
axes like any read of `NOTES.md`, and unlike an extension nothing executes. The
property the adapter enforces is that repository skills never enter the system
prompt unasked; it is not, and cannot be, that markdown in the workspace is
invisible.

**Two smaller shape facts.** pi reads the frontmatter `name` verbatim and has no
namespacing — its validator rejects `:` outright (`^[a-z0-9-]+$`) — so callboard
skills surface as `<name>` on pi where Claude and OpenRouter show
`callboard:<name>`. And `loadSkillsFromDir` treats direct `.md` children of a
scanned root as skill candidates, so pointing pi at the Claude *plugin* root
would pull `README.md` into discovery (observed: scanned, and saved only by
having no frontmatter description). The adapter passes the `skills/` directory
itself for that reason.
