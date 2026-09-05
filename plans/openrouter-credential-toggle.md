# Subscription ↔ OpenRouter: one switch per harness

Let a user keep *both* credential setups configured for Claude Code and Codex —
their subscription login and an OpenRouter key — and flip which one runs with a
single click on Settings → API, without losing the other.

## What already exists

Nearly all of it. The persisted model was built for exactly this and is already
lossless in both directions:

| Concern | Claude Code | Codex |
| --- | --- | --- |
| Routing flag | `claudeCodeUseOpenRouter` | `codexUseOpenRouter` |
| OpenRouter key | `claudeCodeOpenRouterApiKey` | `codexOpenRouterApiKey` |
| Endpoint override | `claudeCodeOpenRouterBaseUrl` | `codexOpenRouterBaseUrl` |
| Models while routed | `claudeCodeOpenRouter*Model` (5 fields) | `codexOpenRouterModel` |
| Models while native | `model`, `default*Model`, `subagentModel` | `codexModel` |
| Native credential | subscription login, or `apiKey`/`authToken` | `codexAuthMode` + `codexApiKey`/`codexBaseUrl` |

The two model sets are deliberately disjoint (`shared/types/agentSettings.ts:193`),
so flipping the flag never overwrites the other mode's values. `getApiEnvOverrides`
(`backend/src/services/agent-settings.ts:331`) branches on
`isClaudeCodeRoutedThroughOpenRouter` / `isCodexRoutedThroughOpenRouter` and, in
native mode, simply omits the OpenRouter env so the ambient subscription login
takes over again. `PUT /api/agent-settings` is already a partial merge — a body
carrying one field leaves every other field untouched
(`backend/src/routes/agent-settings.ts:117`).

So: **no schema change, no wire change, no backend behavior change.** This is a
UI-shaped problem.

## The three gaps

1. **The switch is not quick.** The `Use OpenRouter as the <harness> endpoint`
   checkbox (`ApiSettings.tsx:689`) is local form state; nothing happens until
   the page-wide Save button is pressed. Flipping back and forth to compare is a
   two-click-plus-scroll operation.

2. **The inactive setup disappears.** With routing on, the Anthropic
   *Authentication* section (`ApiSettings.tsx:1367`) and the whole Codex
   *auth-mode* block (`ApiSettings.tsx:1799`) are unmounted. The values survive
   in storage, but the page shows no evidence of that — so "both are set up" is
   a state the user can be in but cannot see, and turning routing on reads as
   destroying the subscription config rather than parking it.

3. **Codex encodes one choice in two controls.** `codexAuthMode`
   (subscription / api-key) and `codexUseOpenRouter` are independent widgets, but
   the three states they describe are mutually exclusive and the OpenRouter flag
   silently wins over the auth mode (`agent-settings.ts:412`). A user can leave
   the page showing `Authentication mode: API key` while every Codex chat runs on
   OpenRouter.

## Proposal

### 1. A `Credentials` segmented control at the top of each harness tab

Replaces the checkbox as the primary affordance, sitting directly under the
engine status card — the first thing on the tab, because it decides what
everything below it means.

- **Claude Code** — two segments: `Anthropic` | `OpenRouter`.
- **Codex** — three segments: `ChatGPT subscription` | `OpenAI API key` |
  `OpenRouter`. One control for one decision, which is gap 3.

The control is a *derived view* over the existing fields, not a new one. Put the
mapping in a pure module beside the tab, following the
`acpProviderModels.ts` / `acpProviderModels.test.ts` precedent in the same
directory:

```ts
// frontend/src/pages/settings/credentialMode.ts
type ClaudeCredentialMode = "anthropic" | "openrouter";
type CodexCredentialMode = "subscription" | "api-key" | "openrouter";

readCodexMode(s)  // s.codexUseOpenRouter ? "openrouter" : (s.codexAuthMode ?? "subscription")
writeCodexMode(m) // "openrouter" → { codexUseOpenRouter: true }
                  // else         → { codexUseOpenRouter: false, codexAuthMode: m }
```

Selecting OpenRouter deliberately does **not** touch `codexAuthMode`, so
switching back lands on the native credential the user last chose rather than
resetting to `subscription`.

### 2. The control persists on click

Copy `persistEngineInstalls` (`RemoteAccessSettings.tsx:107`) verbatim in shape:
optimistic local update, single-field PUT, restore the previous value and show an
inline error on failure. Sending only the routing fields keeps
`binaryOverrideFieldsTouched` false and leaves every unsaved edit elsewhere on the
page alone — the page's own Save keeps working exactly as it does today.

Effect timing is worth one sentence of copy: `getApiEnvOverrides` is read when a
session starts, so the switch applies to new chats and to resumed sessions, not
to a session already running.

### 3. Gate the OpenRouter segment on there actually being a key

`isClaudeCodeRoutedThroughOpenRouter` returns false when the flag is on but no
key is stored and no OpenRouter env is detected — the flag would be a silent
no-op. So disable the OpenRouter segment when
`!settings.<harness>OpenRouterApiKey?.trim() && !systemInfo.<harness>OpenRouterDetected`,
with the hint *"Add an OpenRouter key below and Save first."*

Compare against `settings` (the last server response), not the editable field —
a typed-but-unsaved key is not a key the daemon has.

### 4. Stop hiding the inactive setup

Render the Anthropic *Authentication* and Codex *auth-mode* sections
unconditionally. The non-selected one keeps a muted header badge —
`Inactive — OpenRouter is handling this` / `Inactive — Codex is on your ChatGPT
login` — and its fields stay editable, because configuring the setup you are
about to switch to is the whole point of keeping both.

This is the change that makes the feature legible: the answer to "are both set
up?" becomes something the page states rather than something the user has to
flip a switch to find out.

The `Route through OpenRouter` section stays where it is and keeps the key and
endpoint fields; it loses only its checkbox, which the segmented control now
owns.

## What is deliberately not in scope

- **A per-chat override.** The switch is account-wide, matching the fields it
  writes. A chat that wants a different credential is a much larger change (it
  would have to key the credential on the chat, and every resume of it), and
  nothing in the current model supports it.
- **A switch outside Settings → API.** New Chat and the chat header already
  reflect effective routing through `systemInfo.claudeCodeUseOpenRouter` /
  `codexUseOpenRouter` by swapping the model picker's catalog
  (`ProviderConfigPicker.tsx:206`). Adding a *writable* control there would put
  an account-wide setting behind a per-chat-looking affordance.
- **`openRouterUtilityCompletions`, ACP, Cline, pi.** Utility completions are a
  separate credential path with their own opt-in; Cline and pi treat OpenRouter
  as a provider id rather than a mode (`agentSettings.ts:494`), which is already
  the simpler design and needs no toggle.

## Files

| File | Change |
| --- | --- |
| `frontend/src/pages/settings/credentialMode.ts` | new — derived read/write mapping |
| `frontend/src/pages/settings/credentialMode.test.ts` | new — mapping + round-trip losslessness |
| `frontend/src/pages/settings/ApiSettings.tsx` | segmented control, instant-save handler, unhide the two sections, drop the checkbox from `OpenRouterRoutingSection` |

No backend, shared-types, or wire-surface changes.

## Tests

- `credentialMode.test.ts` — every mode round-trips; selecting OpenRouter and
  back preserves `codexAuthMode`; a legacy settings object with neither field set
  reads as `subscription` / `anthropic`.
- Existing coverage that must stay green:
  `backend/src/services/agent-settings.openRouterEndpoint.test.ts`,
  `backend/src/agents/adapters/codex/codexAuth.test.ts`,
  `backend/src/services/engine-status.test.ts`,
  `backend/src/routes/agent-settings.partial-update.test.ts`.
