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

So: **no schema change, no wire change, no change to what a session does.** This
is a UI-shaped problem — with one backend edit that §5 explains, to a reporting
field the UI now renders and previously did not.

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

Closing gap 3 means the old *Authentication mode* toggle inside the Codex
section cannot stay live as it was. With routing off it writes exactly what the
Credentials segments write, so leaving both on screen — two accent-highlighted
rows for one decision — is the gap rather than its fix. It survives in one
state only, `openrouter`, relabelled **When you switch back**: there it sets
what leaving OpenRouter will land on, which the top control has no way to ask.
Its two segments carry the top control's names (`ChatGPT subscription` /
`OpenAI API key`) — one credential, one name, wherever it appears.

### 2. The control persists on click

Copy `persistEngineInstalls` (`RemoteAccessSettings.tsx:107`) verbatim in shape:
optimistic local update, single-field PUT, restore the previous value and show an
inline error on failure. Sending only the routing fields keeps
`binaryOverrideFieldsTouched` false and leaves every unsaved edit elsewhere on the
page alone — the page's own Save keeps working exactly as it does today.

Effect timing is worth one sentence of copy: `getApiEnvOverrides` is read when a
session starts, so the switch applies to new chats and to resumed sessions, not
to a session already running.

The parked **When you switch back** picker writes on click too, and *that* needs
its own sentence: it sits directly above a key field that still requires the
page's Save, so a control that saves itself and one that does not are a few
pixels apart. It says so.

Saving and error state are per control, not shared. The page renders three
instant-save controls — Claude Code's Credentials, Codex's Credentials, and the
parked picker — and one shared slot puts a Claude Code failure under Codex's
heading as soon as the user changes tabs. The page-wide Save is held down while
any of them is mid-write, and vice versa: both writes carry the same fields.

### 3. Gate the OpenRouter segment on there actually being a key

Both predicates return false when the flag is on but the credentials they need
are absent — the flag would be a silent no-op — so the segment is disabled in
exactly that case, with a hint naming the field that would fix it.

**The two harnesses do not factor the same way, and this is the one place in the
feature where copying one to the other is wrong:**

| | Claude Code | Codex |
| --- | --- | --- |
| Predicate | `flag && (key \|\| detectedEnv)` | `flag && (key \|\| (baseUrlOverride && detectedEnv))` |
| Segment disabled when | `!key && !detected` | `!key && !(detected && storedBaseUrl)` |

The asymmetry is deliberate and lives in `isCodexRoutedThroughOpenRouter`
(`codexAuth.ts:118`, pinned by `codexAuth.test.ts:149`). Claude Code routing is
callboard writing the whole Anthropic-compatible env itself, so a detected
`ANTHROPIC_BASE_URL` is enough on its own. Codex routing is callboard *injecting
a `[model_providers.openrouter]` block into someone else's config* — so when the
user's own `config.toml` or `$OPENAI_BASE_URL` already routes them, callboard
leaves that wiring alone unless there is a stored endpoint override that would
otherwise be inert. With no key and no override it injects nothing, and a
segment enabled on the Claude Code rule would let a Codex user pick OpenRouter,
watch the page relabel itself, and keep running every chat on their ChatGPT
login.

Compare against `settings` (the last server response), not the editable field —
a typed-but-unsaved key is not a key the daemon has.

The mirrors live in `credentialMode.ts` as
`claudeOpenRouterCredentialReady` / `codexOpenRouterCredentialReady`, each next
to a doc-comment naming the backend predicate it copies. They are also the
"is it actually routing?" half of §5.

### 4. Stop hiding the inactive setup

Render the Anthropic *API Endpoint* and *Authentication* sections and the Codex
native-credential block unconditionally. Whichever setup is not in effect keeps
a muted header badge and its fields stay editable, because configuring the setup
you are about to switch to is the whole point of keeping both.

Each badge sits on the section that is *parked*, and says what is running
instead: `Inactive — OpenRouter is handling this` on the native sections,
`Inactive — Codex is on your ChatGPT login` (or `… your OpenAI API key`, or
`… Claude Code is on your Anthropic credentials`) on the routing section. That
is the opposite assignment to the one first drafted here, and the right one: a
badge naming the credential *in* use, sitting on the one that is not, reads as
a sentence rather than a label.

Every piece of copy inside these sections is now rendered in a state it did not
use to be rendered in, so each has to be tense-correct in both. "Adds a
`[model_providers.openrouter]` block" under an `Inactive` badge contradicts the
badge three lines above it; it becomes "While this is the selected credential,
Callboard adds …".

This is the change that makes the feature legible: the answer to "are both set
up?" becomes something the page states rather than something the user has to
flip a switch to find out.

The `Route through OpenRouter` section stays where it is and keeps the key and
endpoint fields; it loses only its checkbox, which the segmented control now
owns.

### 5. Assertions follow effective routing; the selection follows what is stored

The segments show the **stored** flag. Every badge and every "is handling this"
sentence shows **effective** routing — the flag *and* the credentials from §3 —
because those assert what the daemon is doing, and the two can disagree: a flag
saved on, whose key was later cleared and saved. When they disagree the page
says so next to the control ("Selected, but not in effect — …") rather than
letting a badge claim it; a badge that follows the selection lands on the
section actually in effect and inverts.

The control is therefore seeded from the stored flag alone. Seeding an unsaved
`true` from a detected environment — which the checkbox this replaces did —
makes the control claim a routing *callboard* is not doing, because both
predicates open with `if (!flag) return false` and an unsaved flag is
`undefined`. Settings said OpenRouter while New Chat's model picker, reading the
same effective flag, said Anthropic. Displaying the native credential when
nothing is stored is the truthful rendering; the existing "Detected OpenRouter in
your environment" banner is where that environment gets mentioned, and it invites
the click instead of faking it.

**What the native branch does not say.** It says callboard added nothing. It does
*not* say the session is on the vendor's own endpoint: `getApiEnvOverrides`'s
native branch sets `ANTHROPIC_BASE_URL` from `apiBaseUrl` and never *unsets* an
inherited one, so the BYO-gateway user whose shell exports the OpenRouter
endpoint — exactly what `detectClaudeCodeOpenRouterEnv` matches — really is
running through OpenRouter with the flag off. The seeding decision above survives
that (it is about what callboard is doing, which is the question the flag
answers); the *badges* do not. Where the env is detected and callboard is not
routing, they say only that callboard is not driving this, and the banner inside
the section says the rest. Asserting "Claude Code is on your Anthropic
credentials" there is a claim about an environment callboard only half knows.

Not read from `systemInfo.<harness>UseOpenRouter`, though the backend computes
exactly this there: that payload is a page-load-old answer, and the badges have
to move with the click that changes them.

The click does refetch system-info afterwards, though — not for the badges, which
already read the local flag, but for the rows that only the daemon can answer.
`codexConfigured` is *forced* true while Codex is routed (`system-info.ts`), so a
click that turns routing off leaves the Codex tab reporting a credential the flag
behind it no longer implies. Refetching is safe in a way that adopting the
settings PUT response is not: no effect derives editable state from `systemInfo`,
whereas the ACP tab's Default Model re-seeds from `settings`.

That same forced flag is why the Codex auth-status row reads `codexAuthSource`
and never `codexConfigured`. The two answer different questions — "can Codex run
a chat" against "is there a native login to switch back to" — and the routing
override only has business with the first. It no longer forces the second;
`codexAuthNote` carries the qualification, the way `engine-status.ts` already
did.

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
| `frontend/src/pages/settings/credentialMode.ts` | new — derived read/write mapping, plus the two readiness mirrors from §3 |
| `frontend/src/pages/settings/credentialMode.test.ts` | new — mapping + round-trip losslessness + readiness, case for case against the backend predicates |
| `frontend/src/pages/settings/ApiSettings.tsx` | segmented control, instant-save handlers, unhide the parked sections, drop the checkbox from `OpenRouterRoutingSection`, demote the Codex auth-mode toggle to the parked picker |
| `frontend/src/pages/settings/ApiSettings.credentials.test.tsx` | new — the wiring the mapping test cannot reach |
| `backend/src/services/system-info.ts` | stop forcing `codexAuthSource` when routing forces `codexConfigured`; add `codexAuthNote` |
| `frontend/src/api.ts` | `SystemInfo.codexAuthNote`, and the narrowed contract on `codexAuthSource` — the interface half of the change above |
| `backend/src/services/engine-status.ts` | the routed-credentials note both engine rows print, widened to the env-supplied credential and hoisted to `OPENROUTER_ROUTED_NOTE` so system-info's copy has one source to match |
| `backend/src/services/agent-settings.ts` | doc-comment only — what the native branch does and does not undo, which §5 relies on |
| `backend/src/agents/adapters/codex/codexAuth.ts` | doc-comment only — why the Codex env half is narrower, which §3's table copies |

One backend change, and it is §4's doing: unhiding the native Codex section put a
value on screen that had only ever been consumed by a provider gate. No
wire-surface (`shared/types/stream.ts`) change, and the system-info addition is
an optional field, so older bundles ignore it.

The `codexAuthSource` **narrowing** is the half that needs an argument rather
than a shrug, since it changes what an existing field says rather than adding
one. It is safe because `null` was already in the field's declared union: no old
client is handed a value it cannot represent, only one it always had to handle.
And the sole consumer already had a `null` branch — the *Codex auth status* row
in `ApiSettings.tsx`, which stops printing "Configured via config.toml" at a user
who has no `config.toml`, and prints "Not configured" beside `codexAuthNote` and
the `codex login` instruction the forced value used to suppress. The field's
other three values are untouched, so nothing an older bundle could already
render has been dropped — the one state that changes is the one that was wrong.

## Tests

- `credentialMode.test.ts` — every mode round-trips; selecting OpenRouter and
  back preserves `codexAuthMode`; a legacy settings object with neither field set
  reads as `subscription` / `anthropic`; and the Codex readiness mirror is *not*
  ready on a detected env alone where the Claude Code one is.
- `ApiSettings.credentials.test.tsx` — a click writes only its routing fields;
  the gate ignores a typed-but-unsaved key; the parked setup stays mounted and
  editable; a failed write puts the control back and leaves its error on its own
  heading; and a round trip through OpenRouter and back preserves unsaved edits
  on two tabs, which is what pins the decision not to adopt the PUT response
  into `settings`.
- Existing coverage that must stay green:
  `backend/src/services/agent-settings.openRouterEndpoint.test.ts`,
  `backend/src/agents/adapters/codex/codexAuth.test.ts`,
  `backend/src/services/engine-status.test.ts`,
  `backend/src/routes/agent-settings.partial-update.test.ts`.
