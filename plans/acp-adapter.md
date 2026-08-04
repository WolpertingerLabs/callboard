# Plan: ACP adapter — one seam, four+ vendors

Add `acp` as a callboard `AgentProviderKind` backed by the **Agent Client Protocol**
(`@agentclientprotocol/sdk`), so that Copilot, Cursor, Kiro, Trae, Gemini CLI, and any
future ACP-speaking agent become configuration rather than code.

Status: **Proposed.** Derived from a read of getpaseo/paseo (AGPLv3) on 2026-07-26 —
architecture only, no code reuse.

---

## Why

Callboard currently pays a full adapter per vendor. `backend/src/agents/adapters/` holds
`claude-code/` (8 files), `codex/` (16 files), `openrouter/`, `mock/`. Each new harness is
a multi-week project: message adapter, tool adapter, permission adapter, options adapter,
session parser, plus tests.

Paseo solved the same problem once. Their file sizes tell the story:

| File                                   | Lines  |
| -------------------------------------- | ------ |
| `providers/acp-agent.ts` (base client) | 3486   |
| `providers/generic-acp-agent.ts`       | 237    |
| `providers/copilot-acp-agent.ts`       | 248    |
| `providers/kiro-acp-agent.ts`          | 101    |
| `providers/cursor-acp-agent.ts`        | **45** |
| `providers/trae-acp-agent.ts`          | **30** |

Cursor and Trae are 30–45 lines because everything vendor-specific collapses into
constructor options — `waitForInitialCommands`, `initialCommandsWaitTimeoutMs`,
`clientCapabilityMeta`, `configFeatureOptions`. That is the whole delta.

Better still, paseo's `docs/custom-providers.md` exposes `extends: "acp"` in config, so a
user adds an ACP agent with a JSON block and **zero** code:

```json
{ "agents": { "providers": { "my-agent": { "extends": "acp", "label": "My Agent", "command": ["my-agent-cli", "--acp"] } } } }
```

For callboard the payoff is the same shape: one substantial adapter, then vendors are
either a ~40-line subclass or a settings entry.

## Licensing — **resolved 2026-07-27**

`@agentclientprotocol/sdk` is **Apache-2.0** (`npm view` confirms; repo
`github.com/agentclientprotocol/typescript-sdk`). Compatible with callboard's MIT
distribution. **Unblocked.**

Current published version is **1.3.0**, not the ^0.17.1 paseo pins. The protocol has reached
1.x, which materially lowers the "protocol churn" risk noted below — still pin exactly, but
the expected breakage rate is that of a stable major, not a 0.x.

Paseo's own adapter code is AGPLv3 and must not be copied, referenced line-by-line, or
paraphrased closely. This plan uses only the observable architecture (one base + thin
subclasses + config-driven providers), which is not protectable.

---

## Fit with the existing seam

`backend/src/agents/ports/AgentProvider.ts` is already the right shape:

```ts
export type AgentProviderKind = "claude-code" | "openrouter" | "codex" | "mock";
export interface AgentProvider {
  readonly kind: AgentProviderKind;
  query(req: AgentQueryRequest): AgentQuery;
  buildToolServer(spec: ToolServerSpec): unknown;
}
```

`AgentEvent` in `ports/events.ts` already covers what ACP emits: `session_started`, `text`,
`thinking`, `tool_use`, `tool_result`, `slash_commands`, `result`, plus the
`adapter_specific` escape hatch. **No port changes are required for the event stream.**

Three things do need attention:

1. **`AgentProviderKind` is a closed union with an exhaustiveness check** in
   `factory.ts:constructProvider`. ACP is inherently open-ended — one kind, N vendors. So
   the kind is `"acp"` and the vendor lives in a second field (`providerId`), not in the
   union.

   > **Routability — architect ruling, 2026-07-28.** The first cut added `"acp"` to
   > `ROUTABLE_PROVIDER_KINDS`, the allowlist every _route_ narrows request bodies
   > against. That was wrong for Phase 1. Membership in that list is a promise that a
   > request can fully specify a chat on the kind, and no route surfaces `acpProviderId`
   > — so `POST /api/chats/:id/fork` accepted `{"provider":"acp"}` and would have
   > persisted a chat with a kind and no vendor: a permanently wedged chat, exactly what
   > `resolveProviderKind`'s warn-and-fallback exists to prevent.
   >
   > The split that resolves it: `ROUTABLE_PROVIDER_KINDS` is what a _request_ may name;
   > `INTERNAL_PROVIDER_KINDS` (= routable + `"acp"`) is what `sendMessage` will route and
   > persist. Phase 1 reaches ACP only through `SendMessageOptions.acpProviderId`, which
   > is internal. Phase 2 adds the picker and the `acpProviderId` plumbing, and re-adds
   > `"acp"` to the routable list alongside them — not before.

2. **`getAgentProvider(kind)` memoizes one instance per kind.** ACP needs one instance per
   _configured provider id_, so the cache key becomes `kind + ":" + providerId`.
3. **`SessionProvider`** — ACP sessions are provider-managed. See "Session discovery" below.

---

## Design

### `backend/src/agents/adapters/acp/`

```
AcpAdapter.ts          // implements AgentProvider; kind = "acp"
AcpAgentClient.ts      // the base: process spawn, ClientSideConnection, capability
                       // negotiation, session lifecycle, cancel
messageAdapter.ts      // ACP SessionUpdate → AgentEvent
toolAdapter.ts         // ToolServerSpec → ACP McpServer registration
permissionAdapter.ts   // ACP RequestPermission → callboard canUseTool
vendors.ts             // per-vendor option presets (the 30-line files, as data)
AcpSessionProvider.ts  // discovery; see below
```

`vendors.ts` is deliberately **data, not classes**. Paseo used subclassing; a preset record
is simpler for our volume and makes the config-driven path fall out for free:

```ts
interface AcpVendorPreset {
  id: string; // "copilot" | "cursor" | ...
  label: string;
  command: [string, ...string[]];
  waitForInitialCommands?: boolean;
  initialCommandsWaitTimeoutMs?: number;
  clientCapabilityMeta?: Record<string, unknown>;
  features?: AcpFeatureOption[];
}
```

Built-in presets ship in the file; user-defined ones merge in from agent settings under
`acpProviders`. Same code path, same validation.

### Process + transport

ACP is JSON-RPC over the child process's stdio. The base client owns:

- spawn with resolved binary + env (reuse `agentEnvPolicy.ts` — do not invent a second
  env policy)
- `ClientSideConnection` from the SDK, `PROTOCOL_VERSION` handshake
- `initialize` → read `AgentCapabilities`, store them
- `session/new` or `session/load`, `session/prompt`, `session/cancel`
- teardown via tree-kill on close (`AgentQuery.close()`), so a hung CLI doesn't leak

### Capability handling

ACP's `initialize` returns agent capabilities. Store them on the query and let
`supportedModels()` / mode support / `slash_commands` derive from them rather than
hardcoding per vendor. This is the mechanism that keeps the 30-line vendor files honest:
anything discoverable at runtime must not be a preset field.

### Permissions

ACP's `session/request_permission` sends `PermissionOption[]`. Callboard's permission model
is 4-axis with `canUseTool`. The adapter maps ACP's options onto our allow/deny decision
and returns the chosen `optionId`. Mirror the existing shape in
`adapters/codex/permissionAdapter.ts` — that one already bridges a foreign permission
vocabulary and is the closest precedent.

> **The two-pass rule — architect ruling, 2026-07-28. Non-negotiable.**
> Callboard evaluates tool permission **twice**: once in the adapter's own resolve path, and
> again in `buildCanUseTool` before prompting. Review reproduced a bypass where the ACP
> adapter's two passes disagreed because they were given _different inputs_ — pass 1 had
> ACP's structured `ToolKind`, pass 2 only ever sees a name string, because the bridge is
> `canUseTool(toolName: string, …)`. Where they disagreed and the name-derived category was
> set to `allow`, the tool **executed with no prompt**. Cursor's real `search_replace` edits
> files under `fileRead: "allow"`.
>
> Three rules follow, and they apply to every future adapter, not just ACP:
>
> 1. **Both passes must run the identical function over the identical input.** If pass 2
>    cannot see a field, pass 1 must not use it to decide. Better information that only one
>    pass has is worse than no information, because it manufactures disagreement.
>
>    The user's permission settings are input too, and _identical_ covers **when** they are
>    read. `ToolPermissionPolicy` (pass 2) holds a live `getDefaultPermissions` accessor and
>    re-reads chat metadata on every call; the ACP adapter originally received a
>    `DefaultPermissions` **value** resolved once at send time. A user who tightened a policy
>    mid-turn would have pass 1 auto-allow on the stale snapshot and never escalate — and pass
>    2, the pass that reads the fresh value, is only reached when pass 1 says "ask". Adapters
>    therefore take the **getter**, never the value: `AcpRunOptions.getPermissions`,
>    `AcpPermissionContext.getPermissions`. Codex is the deliberate exception — it has no
>    per-call hook at all, so its permissions collapse onto a sandbox tier fixed at thread
>    start; with only one pass there is nothing to disagree with.
>
> 2. **Ambiguity resolves to the _most_ restrictive matching category, not the least.** The
>    original ordering checked least-privileged first on the reasoning that an ambiguous name
>    "never silently widens its own gate". That is backwards: resolving `search_and_run` to
>    `fileRead` treats a run-capable tool as read-only, which _is_ the widening. Most-
>    restrictive-wins is the only safe polarity.
> 3. **Never categorize from prose.** `name` is optional on ACP's `ToolCallUpdate`, and the
>    fallback was `title` — a human sentence. ``Run `rm -rf` to clear the search index``
>    tokenizes to `search` → `fileRead`. When no reliable tool name exists, categorize to the
>    most restrictive category; do not parse the sentence.
>
> **Amendment, 2026-08-04 — the label ladder ends at `kind`.** Rule 1 constrains the
> _input_ both passes see, not the field it was read from. So when a call carries no
> `name` and a `title` that is prose, `acpToolLabel` now names it after its ACP `kind`
> and hands _that_ to `canUseTool` — one string, one categorizer, both passes, rule 1
> intact. `categorizeAcpToolKind` remains diagnostic-only; nothing reads `kind` to
> decide.
>
> The prompt for the change was the first live vendor. OpenCode's
> `session/request_permission` carries no `name` and a `title` of the **file path**
> (`/tmp/proj/hello.txt`), so every tool it asked about — reads included — resolved to
> `unknown_tool` → `codeExecution`. That is safe-by-default and inoperative in
> practice: with one axis governing everything, `fileRead`/`fileWrite`/`webAccess` stop
> meaning anything for that vendor, and the user's natural response is to set
> `codeExecution: allow`, which is strictly worse than gating edits as `fileWrite`.
>
> Accepted residual: a vendor that lies in `kind` under-gates. It is the risk `name`
> has always carried — `name` outranks `kind` in the ladder — and the protocol has no
> answer to it either way, since an agent that wants to dodge the gate simply never
> sends `session/request_permission`. If a real vendor is found abusing `kind`, the
> escalation is a per-vendor opt-in field in `vendors.ts`, not a return to
> categorizing every tool as `codeExecution`.

> **Known limit of rule 3 — accepted, not a bug.** `isToolIdentifier` separates names from
> prose by shape, so a _one-word_ `title` ("Search", "Delete") is indistinguishable from a
> real tool name and is tokenized as one. This is not a bypass: both passes receive that same
> label from `acpToolLabel` and reach the same category, so nothing is silently auto-allowed
> that the second pass would have caught. Closing it would mean categorizing the two cases
> differently, which requires a signal only pass 1 has — rule 1 forbids exactly that — or
> changing the string `canUseTool` shows the user. The blast radius is one word of a
> human-authored title landing on its literal category rather than `codeExecution`; the cost
> of "fixing" it is reopening the defect class the whole ruling exists to close.
>
> Separately, and inherent to the protocol: **nothing on the client side compels an ACP agent
> to ask.** `session/request_permission` is sent at the agent's discretion, and there is no
> ACP equivalent of Codex's sandbox tier to fall back on. No adapter code changes this. It
> belongs in Phase 2's vendor-onboarding criteria — a vendor that does not reliably request
> permission is not one we can gate.

### Tools

ACP agents accept MCP servers via `McpServer[]` on session creation. `buildToolServer`
returns an MCP stdio/http server descriptor; the existing `mcp-server-shim.ts` pattern from
the Codex adapter is the precedent — but note the OR lesson: **audit whether ACP agents
choke on `anyOf` in tool schemas** the way OpenRouter drops server tools. Test explicitly.

### Session discovery

`SessionProvider` exists so callboard can list and re-read past sessions from disk
(`ClaudeCodeSessionProvider` reads `~/.claude/projects/…jsonl`). ACP sessions are
provider-managed — there is no standard on-disk transcript, and paseo marks them
"Provider-managed" in its own table.

Two options:

- **(A) Callboard-owned transcript.** The adapter writes its own JSONL of the normalized
  `AgentEvent` stream under `~/.callboard/acp-sessions/<providerId>/<sessionId>.jsonl`.
  `AcpSessionProvider` reads that back. Works for every vendor uniformly, costs a write
  path, and makes us the source of truth.
- **(B) `session/list` + `session/load`** where the agent advertises the capability, no
  history otherwise.

**Recommendation: A.** It is the only option that gives consistent behavior across vendors,
and it is a prerequisite for chats surviving a vendor CLI upgrade. B can layer on later as
a resume optimization.

---

## Phases

**Phase 1 — vertical slice against a conformant ACP test double.**
`AcpAdapter` + base client + message/permission adapters, plus a **fake agent process that
speaks real ACP over stdio**, driven end-to-end. `AcpSessionProvider` writes and reads the
callboard-owned transcript. Chats can be started, streamed, permission-prompted, cancelled,
and resumed against the double.

> **Resolved 2026-07-27.** No ACP-speaking CLI (Gemini, Copilot, Cursor, Kiro, Trae) is
> installed or authenticated on this machine, and authentication needs credentials and
> possibly billing that only the user can supply. Rather than block, Phase 1 builds against a
> conformant test double.
>
> This is not a compromise on coverage. The risky, substantial part of this work is protocol
> handling — process lifecycle, the `initialize` handshake, capability negotiation, session
> update translation, permission mapping, cancellation, teardown. All of that is exercised by
> a double that speaks the real wire format. Paseo does the same thing (`mock-load-test-agent`,
> `acp-wrapper-smoke.test.ts`) alongside its real vendors.
>
> What a double genuinely cannot prove is that a _specific_ vendor's ACP implementation
> behaves as specified — capability lies, non-standard update shapes, auth quirks. That is
> what Phase 2's vendor presets are for, and it is a thin surface: paseo's vendor files are
> 30–45 lines. Wiring the first real vendor once one is authenticated should be a small
> follow-on, not a rebuild.

**Phase 2 — vendor presets.** `vendors.ts` with 3–4 built-ins. Provider picker in the New
Chat panel groups ACP vendors under their own labels. Availability detection (is the binary
on PATH / authenticated) mirroring `provider-availability` behavior.

**Phase 3 — user-defined ACP providers.** Settings → Providers accepts a custom entry
(id, label, command, env). Validated against the same preset schema. This is the item that
turns "we support 4 agents" into "we support any ACP agent".

**Phase 4 — parity polish.** Slash commands, modes/thinking levels, model selection where
advertised, cost/usage reporting into `TokenUsage`, model-alias integration.

---

## Non-goals

- Replacing `claude-code`, `codex`, or `openrouter` adapters. ACP is additive. Claude Code
  via the Agent SDK stays the default and the richest path.
- Implementing the _server_ side of ACP (callboard exposing itself as an ACP agent). Real
  option later; out of scope here.
- Per-vendor bespoke features that aren't runtime-discoverable. If it needs a special case
  beyond a preset field, that's a signal to reconsider, not to add a subclass.

## Risks

- **Protocol churn.** Lower than first assessed — the SDK is at 1.3.0, not 0.x. Still pin
  exactly and treat bumps as adapter PRs, same rule the OpenRouter plan already set for
  `openrouter-agent-harness`.
- **Capability lies.** Vendors advertising capabilities they implement partially. The
  `adapter_specific` escape hatch plus defensive normalization in `messageAdapter` absorbs
  this; do not let unknown updates throw.

  One limit on that escape hatch, corrected 2026-07-28: an update whose shape this SDK pin
  cannot parse never reaches the adapter at all. `ClientApp` installs a session-update
  router whose `handleMessage` runs `validate.zSessionNotification.parse(...)` **unguarded**
  before any of our handlers. It was first written up as the router _dropping_ such
  updates; it in fact **throws**, and the throw is swallowed upstream. The user-visible
  conclusion is unchanged — the router returns `Handled.no`, valid notifications keep
  arriving, and the connection survives (the e2e `malformed` scenario proves all three) —
  but a drop and a swallowed throw do not behave the same under a sustained malformed
  stream, so the distinction is worth keeping straight.

- **Coverage gate.** The global coverage thresholds bite hard on a 1–2k-line adapter.
  Budget test-writing at parity with implementation, and avoid spread-guards that inflate
  branch count.
- **Auth is not ours.** Like paseo, we do not manage vendor credentials — the CLI does.
  Availability detection must degrade to a clear "not authenticated" state, not a crash.

## Open questions

1. Which vendor for Phase 1? Depends on which we can authenticate on this machine today.
2. ~~Does the SDK license permit MIT distribution?~~ **Resolved 2026-07-27: Apache-2.0, yes.**
3. Do we expose ACP vendors as distinct entries in the model-routing/alias system, or as one
   `acp` provider with a vendor sub-selector? Leaning distinct entries; routing config
   already keys on provider strings.
4. Transcript format — reuse the OpenRouter session JSONL shape, or define a neutral one?
   Neutral is better long-term but touches `SessionProvider` consumers.
