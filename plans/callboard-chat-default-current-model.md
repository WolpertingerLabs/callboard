# start_chat_session: default the child to the calling chat's current model

**Goal:** When an agent calls `start_chat_session` (and the sibling
`talk_to_agent` / `deploy_agent`) without a `model`, the new session should
default to the model the **calling** chat is currently running — not silently
drop to the provider's configured default. Today `provider` inherits but `model`
deliberately does not; this plan narrows that refusal to the one case it was
actually protecting against (cross-harness model ids) and inherits everywhere
else.

## Current state (as-built)

- **Shared arg plumbing:** `backend/src/services/tool-provider-args.ts` —
  `providerModelSchema` (the `provider`/`model` Zod fragment spread into
  `start_chat_session`, `talk_to_agent`, `deploy_agent`) and
  `resolveProviderModelArgs(args, current)`. Resolution today:
  - `provider` = explicit arg → calling session's engine → `"claude-code"`.
  - `model` = explicit arg only. **Never inherited**, per the long doc-comment:
    model ids are per-harness namespaces ("claude-opus-5" means nothing to Codex),
    so a carried model would either error or be silently ignored. An omitted
    model falls to the target provider's configured default.
- **Calling-session engine context:** threaded in as plain values via
  `buildCallboardToolsSpec(getChatId, getAgentAlias, { provider, acpProviderId })`
  (`callboard-tools.ts:178`) and the equivalent in `agent-tools.ts`. Plain values
  are safe there because a chat's provider is immutable by design.
- **Where "current model" already lives:** the chat record's per-chat model
  override, `metadata.model`, persisted by `claude.ts` at creation
  (`opts.model && isInternalProvider(...)` → pinned alongside provider) and
  **rewritten whenever the user switches models mid-chat**
  (`routes/stream.ts:402` — written before `sendMessage` re-reads metadata, so
  the next turn runs on it). Read back per harness in each config block
  (`claude.ts:1484/1568/1640/1690/1726`) through
  `resolveSessionModel(perChat, providerDefault, provider, settings)` — alias-aware.
- **Cross-harness aliases:** `resolveModelAlias(value, provider, settings)`
  (`agent-settings.ts:275`) — case-insensitive, one hop, alias shadows a real
  model id; **alias with no target for the provider → `undefined`** (caller
  falls back to provider default). A raw id passes through *unchanged*, so the
  current return value cannot distinguish "resolved alias" from "raw id".
- **Child side:** `sendMessage`'s `model` opt is pinned into the child chat's
  metadata (`claude.ts:1057`), then re-resolved through the same
  `resolveSessionModel` path at child startup. So whatever string we pass is
  resolved with full alias/default fallback semantics by the child itself.
- **In-flight callers:** `getChatId()` can return a temp tracking id
  (`new-<ts>`) for a still-registering caller; `chatFileService.getChat(id)`
  then misses. Parentage linking already handles this by skipping
  (`callboard-tools.ts:869`).

## Design

### New resolution semantics

`resolveProviderModelArgs` gains knowledge of the calling session's *current*
model and applies it when `args.model` is omitted:

1. **Explicit `model` always wins** — unchanged.
2. **No explicit `model`, no caller model** (caller has no per-chat override, or
   no resolvable chat record) → omit model. Unchanged behavior: the child runs
   on the provider's configured default — which is exactly what the caller
   itself runs in the no-override case, so "defaults to current model" already
   holds here. Note the deliberate asymmetry: nothing is passed, so the child
   stays *dynamic* on the provider default rather than being pinned to a
   snapshot of it.
3. **No explicit `model`, provider inherited (or explicitly the same engine as
   the caller)** → pass the caller's model string through verbatim. It is in the
   same harness's vocabulary by construction (same engine ⇒ same namespace), and
   the child's startup re-resolves it through `resolveSessionModel`, so an alias
   override with no target degrades to the provider default exactly as it would
   for the caller. ACP is covered: provider inheritance carries `acpProviderId`,
   so the vendor — and therefore the model vocabulary — is the same.
4. **No explicit `model`, provider explicitly different from the caller's
   engine** → inherit **only** when the caller's string is a registered
   cross-harness alias with a target for the child provider; pass the *target*.
   Otherwise omit the model and say so in the result (see below). This is the
   one case the old "never inherit" rule was protecting: a raw per-harness id
   ("opus", "gpt-5.5", "opencode/nemotron-…") is meaningless — or worse, valid
   but wrong — on another engine.

### Making alias lookup distinguishable

`resolveModelAlias` can't tell "alias resolved to X" from "raw id X", and case 4
needs exactly that distinction. Extract the lookup it already does:

```ts
// agent-settings.ts
export function findModelAlias(value: string, settings?: AgentSettings): ModelAlias | undefined;
// resolveModelAlias becomes a thin wrapper over it (behavior unchanged)
```

Then case 4 is `findModelAlias(callerModel)?.targets[childProvider]`.

### Threading the caller's model: a getter, not a plain value

Unlike `provider`, a chat's model is **mutable** — the user can switch it
mid-chat, and `stream.ts` writes the new value before the next turn. Plain
values in `buildCallboardToolsSpec` opts would go stale for the rest of the
session. So:

- `CallingSessionEngine` (`tool-provider-args.ts`) gains
  `getModel?: () => string | undefined`.
- A small helper reads the live value from the chat record — the tools already
  have `getChatId` and `chatFileService`; add to `chat-file-service.ts`:

```ts
/** The chat's current per-chat model override, if any (live read). */
getModelOverride(id: string): string | undefined {
  const chat = this.getChat(id);
  if (!chat) return undefined;
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    const m = meta?.model;
    return typeof m === "string" && m.trim() ? m.trim() : undefined;
  } catch { return undefined; }
}
```

- Both tool builders wire it: `getModel: () => getChatId?.() && chatFileService.getModelOverride(getChatId())`.
  A still-registering caller (temp tracking id) simply yields `undefined` → case 2.
- **Definition & known limit:** "current model" = the chat's persisted per-chat
  override, not a live probe of the harness. When no override is set the caller
  is on the provider's configured default, and case 2 gives the child that same
  default. A model switch lands in metadata at the next message boundary, so a
  switch issued mid-turn is visible to children spawned in *later* turns. (The
  per-message `model` the session parsers extract is display metadata, not
  wired to any session-scoped registry — plumbing that is out of scope.)

### Resolver signature (sketch)

```ts
export interface CallingSessionEngine {
  provider?: UiAgentProviderKind;
  acpProviderId?: string;
  /** Live per-chat model override of the calling session, read at tool-call time. */
  getModel?: () => string | undefined;
}

export type ResolvedProviderModel =
  | { ok: true; provider: UiAgentProviderKind; acpProviderId?: string; model?: string;
      modelSource: "explicit" | "inherited" | "default";
      /** Set when inheritance was considered and skipped, for the result payload. */
      inheritanceNote?: string }
  | { ok: false; error: string };
```

Algorithm (after the existing provider/acp resolution):

```
const explicit = args.model?.trim();
if (explicit) return { ...provider, model: explicit, modelSource: "explicit" };

const callerModel = current?.getModel?.();          // trimmed or undefined
if (!callerModel) return { ...provider, modelSource: "default" };

const sameEngine = provider === current?.provider;  // acp ⇒ same vendor via acpProviderId
if (sameEngine) return { ...provider, model: callerModel, modelSource: "inherited" };

const target = findModelAlias(callerModel)?.targets[provider];
if (target) return { ...provider, model: target, modelSource: "inherited" };

return { ...provider, modelSource: "default",
         inheritanceNote: `caller model "${callerModel}" is not a cross-harness alias with a "${provider}" target; child uses ${provider}'s configured default` };
```

### Result payload & tool descriptions

- `start_chat_session` result JSON gains `model` (what the child will run, when
  known) and `modelSource`, plus `inheritanceNote` when set — the calling agent
  can see that its "same model" expectation was NOT met and pass an explicit
  model if it cares. `talk_to_agent` / `deploy_agent` results get the same
  fields where their shapes allow.
- Rewrite the `model` description in `providerModelSchema` — it currently ends
  with "A model is never inherited from the calling session even when the
  provider is", which becomes false. New wording: omit to inherit this
  session's current model when the child runs on this session's engine; on
  another engine only a cross-harness alias (see `list_model_aliases`) is
  inherited, otherwise the provider's configured default applies. Keep the
  per-harness vocabulary warnings — they still gate *explicit* cross-engine
  `model` values, which remain pass-through-and-loud.
- Rewrite the doc-comment block in `tool-provider-args.ts` that justifies
  non-inheritance: the per-namespace hazard is real but only across engines;
  same-engine inheritance was always safe, and the child's own
  `resolveSessionModel` fallback makes alias edge cases degrade to the default
  rather than fail.

## Files

| File | Change |
| --- | --- |
| `backend/src/services/tool-provider-args.ts` | `getModel` on `CallingSessionEngine`; inheritance algorithm; `modelSource`/`inheritanceNote`; rewritten `model` description + doc-comments |
| `backend/src/services/agent-settings.ts` | Extract `findModelAlias` from `resolveModelAlias` (no behavior change) |
| `backend/src/services/chat-file-service.ts` | `getModelOverride(id)` (live metadata read) |
| `backend/src/services/callboard-tools.ts` | Wire `getModel` into both `resolveProviderModelArgs` call sites' context (only `start_chat_session` consumes the new result fields; `list_anthropic_models` etc. untouched); surface `model`/`modelSource`/`inheritanceNote` in the start result |
| `backend/src/services/agent-tools.ts` | Wire `getModel` into `talk_to_agent` / `deploy_agent` resolver calls (agent chats have records too — `executeAgent` pins their `model` into metadata the same way) |
| Tests: `tool-provider-args.test.ts`, `callboard-tools.*.test.ts` | See below |

No frontend change: the model switcher already persists `metadata.model`, and
the child's pinned model displays through the existing per-chat model UI.

## Edge cases

- **Still-registering caller** (`new-<ts>` tracking id, no chat record): getter
  returns `undefined` → child on provider default. Mirrors the existing
  parentage-link skip.
- **Caller override is an alias, same engine:** passed verbatim; child resolves
  it for the same harness. Alias with no target → `resolveSessionModel` falls
  back to the provider default (same degradation the caller would see).
- **Cross-engine, caller on a raw id:** no inheritance + `inheritanceNote`.
  Never guess a mapping.
- **Codex + OpenRouter routing:** routing mode is a global setting, so caller
  and child are in the same mode; an inherited override is an OR slug in OR
  mode both sides, and `codexModel` vs `codexOpenRouterModel` default selection
  happens inside the child's own config block — unaffected.
- **`mock` provider:** excluded from tool schemas already; no path reaches it.
- **Child pinning:** an inherited model is pinned into the child's metadata
  (`claude.ts:1057`), so it survives follow-up messages and shows in the UI —
  same as an explicit model today. Children spawned with no inheritable model
  stay dynamic on the provider default.
- **Explicit `model` + different `provider`:** unchanged pass-through-and-loud
  (the documented failure mode when the id isn't valid there).

## Tests

- `tool-provider-args.test.ts` — the heart of it:
  - explicit model wins over caller model;
  - same-engine inheritance passes caller model verbatim (incl. ACP vendor
    carried, alias strings, whitespace trim);
  - cross-engine + registered alias → alias target for the child provider;
  - cross-engine + raw id → no model + `modelSource: "default"` + note;
  - no caller model / no context / getter throws or misses → default;
  - `acp` error path unchanged.
- `agent-settings` tests: `findModelAlias` extraction is behavior-neutral
  (existing `resolveModelAlias` tests keep passing against the wrapper).
- A `callboard-tools` test in the style of `callboard-tools.card.test.ts`:
  mock `chatFileService` with a caller record carrying `metadata.model`, stub
  `sendMessage`, assert the child spawn receives `model` and the result JSON
  reports `modelSource: "inherited"`; and the negative variant (record without
  a model → no `model` passed to `sendMessage`).

## Out of scope

- `continue_chat` — takes no `model`; a continued chat keeps its own persisted
  model, which is correct.
- Job step sessions — job definitions carry their own `provider`/`model`
  defaults; changing job-runner semantics is a separate decision.
- Live model probing from transcript metadata (per-message `model` in the
  session parsers) — would need a session-scoped current-model registry; the
  metadata-override getter covers the user-visible notion of "current model".
