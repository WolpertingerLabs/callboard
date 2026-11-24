# Plan: one `google` connection, with services and levels chosen per caller

Status: proposed. Base: `main` at 1054456 (after PR #65, Docs/Slides templates).
Owner: drawlatch. Scope: the Google connection templates, the config that selects them, `test_connection`, the admin API, the dashboard, and docs.

## Problem

The dashboard shows 18 Google cards: one per service × access level × auth flavour (`google-gmail-metadata`, `google-gmail-readonly`, `google-gmail-readonly-sa`, … `google-slides-sa`), plus the static-token `google`. The user-OAuth ones all read one `GOOGLE_OAUTH_REFRESH_TOKEN`, but each asks the token endpoint for its own scope only, and the token manager refuses any token whose granted scopes go beyond what it asked for (`src/remote/oauth/token-manager.ts:776-789`, compared as exact strings). Nobody has checked whether Google narrows a token on refresh. If it doesn't, one refresh token consented for several scopes serves none of the templates, and the documented fallback is one refresh token per scope set, through custom connectors that override template aliases (CONNECTIONS.md lines 215-274). Two templates for the same service also trigger the overlap refusal.

## Goals

1. One built-in `google` connection with one credential per caller: either user OAuth (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`) or a service account (`GOOGLE_SERVICE_ACCOUNT_KEY`, with an optional `subject`).
2. Admin-only config per caller that picks the auth mode and one level for each service.
3. A built-in catalog that maps each service and level to its scopes, allowlist and test. It is moved verbatim from today's reviewed templates.
4. When routes are resolved, the selection becomes one ordinary OAuth2 route. Its scopes are the union of the chosen levels' scopes, and its allowlist is the union of their allowlists. The token manager, the request path, and the exact-scope refusal stay as they are.
5. If the refresh token is consented for exactly the union, the token endpoint grants exactly what is requested, so the narrowing question doesn't arise. The plan says what happens when the selection doesn't match the consent.
6. `test_connection` on `google` runs each selected service's test and reports per service.
7. Remove the scoped templates, their `-sa` twins, the static-token `google`, and everything that only exists to serve them. An old template ID left in `remote.config.json` fails with a message that says what replaces it.

## Non-goals

- Changing the OAuth2 engine (token manager, `jwt_bearer` signer, scope verification, rotation, backoff). The only engine change is one additive field on `OAuth2ScopeError` (see "test_connection").
- New Google services or levels (Tasks, People, Gmail send, Calendar write, full `drive`, …). Uncatalogued APIs go through a custom connector (see "Other Google APIs").
- A generic per-connection options mechanism (see "Config key: why `google` and not a generic options bag").
- A Google event listener. INGESTORS.md is unaffected.
- Checking against Google whether it narrows on refresh. It becomes an edge case (see "Selection vs consent"), and the existing optional e2e probe can still answer it.

## Hard invariants (hold in every PR)

1. **No agent path writes the selection.** No `toolHandlers` entry, from either origin, may create, change or delete `callers.<alias>.google`. Only `remote.config.json` and the dedicated admin routes in PR 2 can, and PR 2 does not go through `dispatchTool`. This is enforced by a canary sweep that extends `src/remote/oauth2-overrides-immutable.test.ts`.
2. **Agents still can't enable or credential `google`.** On the agent path, `set_connection_enabled` refuses to enable `google`, and `set_secrets` refuses all four `GOOGLE_*` credential names in both auth modes, whatever mode the caller is in and whatever `selfManage` says. This is the main regression risk. The new base template has no `oauth2` block, so the existing gates (`oauth2Connection()` and `signingCredentialNames()` in `tool-dispatch.ts:928-968`), which look at `loadConnection(alias).oauth2`, would silently stop protecting it. See "Admin/agent boundary".
3. **The catalog never offers the `drive` scope**, or any scope outside the ten that are listed today. A test pins the exact scope set.
4. **Composing is a disjoint sum.** Across services, no two catalog allowlist patterns overlap (`allowlistPatternsOverlap`). That makes the union allowlist equal to the per-service allowlists taken side by side, and keeps one service's `!` exclusions from affecting another. Tested.
5. **The base template matches nothing.** `allowedEndpoints: []`, and it has no credentials in headers. Code that skips composition by mistake fails closed.

## Config schema

### Shape

A new optional caller key, `google`:

```json
{
  "callers": {
    "household": {
      "connections": ["google"],
      "selfManage": false,
      "google": {
        "auth": "user",
        "services": { "sheets": "edit", "docs": "edit", "slides": "edit", "drive": "read" }
      }
    },
    "mail-agent": {
      "connections": ["google"],
      "selfManage": false,
      "google": {
        "auth": "service-account",
        "subject": "alice@example.com",
        "services": { "gmail": "read", "calendar": "read" }
      }
    }
  }
}
```

```ts
// src/shared/config.ts
export type GoogleAuthMode = 'user' | 'service-account';
export interface GoogleCallerConfig {
  auth: GoogleAuthMode;
  /** service id → level id, both from the catalog. Non-empty. */
  services: Partial<Record<GoogleServiceId, string>>;
  /** service-account only: the Workspace user to act as (JWT `sub`). */
  subject?: string;
}
// CallerConfig gains:
  /** Admin config only: which Google services and levels the `google`
   *  connection gives this caller. No tool reads or writes it. */
  google?: GoogleCallerConfig;
```

Services and levels (levels for one service are alternatives, not a ladder: `drive: file` and `drive: read` grant different things):

| Service | Level | Scope (`https://www.googleapis.com/auth/…`) | Today's template | `auth: service-account`? |
|---|---|---|---|---|
| `gmail` | `metadata` | `gmail.metadata` | `google-gmail-metadata` | no (no `-sa` twin today) |
| `gmail` | `read` | `gmail.readonly` | `google-gmail-readonly` / `-sa` | yes, needs `subject` |
| `calendar` | `freebusy` | `calendar.freebusy` | `google-calendar-freebusy` | no |
| `calendar` | `read` | `calendar.readonly` | `google-calendar-readonly` / `-sa` | yes |
| `drive` | `file` | `drive.file` | `google-drive-file` | no |
| `drive` | `read` | `drive.readonly` | `google-drive-readonly` / `-sa` | yes |
| `sheets` | `read` | `spreadsheets.readonly` | `google-sheets-readonly` / `-sa` | yes |
| `sheets` | `edit` | `spreadsheets` | `google-sheets` / `-sa` | yes |
| `docs` | `edit` | `documents` | `google-docs` / `-sa` | yes |
| `slides` | `edit` | `presentations` | `google-slides` / `-sa` | yes |

The service-account column keeps exactly today's set of twins (open question Q3).

### Validation rules and messages

`validateGoogleSelection(raw: unknown): GoogleCallerConfig` lives in `src/shared/google.ts`. It throws `Error` with these exact messages. `<alias>` is the caller alias, and the list of known services comes from the catalog.

| Rule | Message |
|---|---|
| not a plain object | `google must be an object: { "auth": "user" \| "service-account", "services": { … } }` |
| unknown key | `google has unknown field "<key>" (allowed: auth, services, subject)` |
| `auth` missing or other | `google.auth must be "user" or "service-account"` |
| `services` missing, not an object, or empty | `google.services must name at least one service (gmail, calendar, drive, sheets, docs, slides)` |
| unknown service | `google.services: unknown service "<id>" (known: gmail, calendar, drive, sheets, docs, slides). For other Google APIs, define a custom connector: CONNECTIONS.md → Other Google APIs` |
| `drive: "full"` (or `"edit"`, `"write"`) | `google.services.drive: "<level>" is not offered: the drive scope would also make the Sheets read level writable and reach every file. Use "read" or "file", or a custom connector` |
| unknown level | `google.services.<id>: unknown level "<level>" (levels: <a>, <b>)` |
| level not offered in this mode | `google.services.<id>: level "<level>" is not available with auth "service-account" (available: <list or "none">)` |
| `subject` with `auth: "user"` | `google.subject is only used with auth "service-account"` |
| `subject` not an email (`isValidOAuth2Subject`) | `google.subject must be an email address` |
| SA mode, `gmail` chosen, no `subject` | `google.services.gmail needs google.subject with auth "service-account": a service account has no mailbox, so it must act as a Workspace user (domain-wide delegation)` |

Prototype-safe: read fields with `Object.hasOwn`, and reject `__proto__`/`constructor` as service ids (they fall under "unknown service").

Rules in `resolveCallerRoutesChecked` (`src/shared/config.ts:983`). Each of these drops the `google` connection for that caller, like an invalid `oauth2Overrides` entry does today: it is logged once and shown as `problem` on the dashboard.

| Situation | Outcome / message |
|---|---|
| `"google"` in `connections`, no `google` block | dropped: `connection "google" needs callers.<alias>.google = { "auth": "user" \| "service-account", "services": { … } } (CONNECTIONS.md → Google)`. If the caller has `GOOGLE_API_TOKEN` set (`isSecretSetForCaller`), the message adds: ` The static-token "google" template that read GOOGLE_API_TOKEN was removed.` |
| block invalid | dropped with the validator's message |
| `google` block present, `"google"` not in `connections` | kept, ignored, logged: `Caller "<alias>": google selection is set but the "google" connection is not enabled; ignored.` (So disabling the card keeps the selection, as the dashboard toggle needs.) |
| `oauth2Overrides["google"]` present | dropped: `oauth2Overrides["google"] is not used: choose services in callers.<alias>.google, and set the service-account user in google.subject` |
| a custom connector with alias `google` | the custom connector wins, as today. A `google` block is then ignored and logged: `Caller "<alias>": a custom connector named "google" replaces the built-in one; callers.<alias>.google is ignored.` |

### Config key: why `google` and not a generic options bag

A generic `connectionOptions: { "<alias>": {...} }` would need a per-connection schema registry, validation dispatch, a dashboard renderer driven by that schema, and its own immutability canary, all for one consumer. The caller key is the smallest clean option. It is typed and validated in one module, guarded by the same canary pattern as `oauth2Overrides`, and readable in `remote.config.json`. If a second composed connection turns up, generalise then: `google` maps onto `connectionOptions.google` mechanically. Putting the selection inside `oauth2Overrides.google` was rejected: `oauth2Overrides` only narrows, and a selection widens. Mixing the two would blur the rule "overrides can't widen" that README and the tests state.

## Catalog: format and location

**Data:** `src/connections/google-catalog.json`. It sits at the top level of `src/connections/`, not in a category subdirectory. `getConnectionIndex()` (`src/shared/connections.ts:86`) only indexes `<category>/*.json`, so the file is never a template. `npm run build` already copies `src/connections` to `dist`. Keeping it as JSON makes the move from the templates reviewable with `git diff --color-moved`, which a TS module wouldn't allow: Prettier would rewrite the quotes. A test pins that the index ignores top-level files.

```jsonc
{
  "tokenUrl": "https://oauth2.googleapis.com/token",
  "auth": {
    "user": {
      "grant": "refresh_token",
      "clientAuth": "body",
      "secretRefs": {
        "clientId": "GOOGLE_OAUTH_CLIENT_ID",
        "clientSecret": "GOOGLE_OAUTH_CLIENT_SECRET",
        "refreshToken": "GOOGLE_OAUTH_REFRESH_TOKEN"
      }
    },
    "service-account": {
      "grant": "jwt_bearer",
      "secretRefs": { "serviceAccountKey": "GOOGLE_SERVICE_ACCOUNT_KEY" }
    }
  },
  "services": {
    "gmail": {
      "name": "Gmail",
      "docsUrl": "https://developers.google.com/workspace/gmail/api/reference/rest",
      "enableApi": "Gmail API",
      "levels": {
        "metadata": {
          "summary": "labels, message/thread IDs, headers, history; no bodies, attachments, or search",
          "scopes": ["https://www.googleapis.com/auth/gmail.metadata"],
          "auth": ["user"],
          "allowedEndpoints": ["…verbatim from google-gmail-metadata.json…"],
          "testConnection": { "…verbatim…": "" }
        },
        "read": {
          "summary": "…",
          "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
          "auth": ["user", "service-account"],
          "subjectRequired": true,
          "allowedEndpoints": ["…verbatim from google-gmail-readonly.json…"],
          "testConnection": { "…": "" }
        }
      }
    }
    // calendar, drive, sheets, docs, slides: same shape
  },
  "apiAccepts": { "…": "see Cross-service scope audit" },
  "crossScopeNotes": [
    {
      "when": { "sheets": "read", "drive": "file" },
      "text": "The Sheets API accepts drive.file for writes, so sheets=read can edit (not create) spreadsheets that drive.file covers: the ones this OAuth client created or the user picked. drive=file can already overwrite or delete those files through Drive."
    }
  ]
}
```

`subjectRequired` applies only in service-account mode. `summary` feeds the composed route's description, the dashboard matrix, and the docs table.

**Loader and composer:** `src/shared/google.ts`. It exports:

- `loadGoogleCatalog()`: read once, validate the shape (every level has scopes, an allowlist and a test, `auth` ⊆ the two modes, and so on), and cache. An invalid catalog throws. That's shipped code, and tests cover it.
- `validateGoogleSelection(raw)`: see above.
- `composeGoogleRoute(base: Route, sel: GoogleCallerConfig): Route`: see the next section.
- `googleConsentScopes(sel): string[]`: the sorted union. Used by the dashboard, `test_connection`, and the migration message.
- `googleCredentialRoutes(): Route[]`: one composed route per auth mode, for policy gates (invariant 2).
- `googleMigration(caller): string | undefined`: the removed-ID message (see "Migration").

**The base template:** `src/connections/productivity/google.json` is rewritten. It keeps the alias `google` and becomes the one dashboard card:

```json
{
  "name": "Google",
  "stability": "beta",
  "category": "productivity",
  "description": "Gmail, Calendar, Drive, Sheets, Docs and Slides through one credential. Each caller's services and levels are set by the operator (callers.<alias>.google); drawlatch mints tokens for exactly those scopes. See CONNECTIONS.md \"Google\".",
  "docsUrl": "https://developers.google.com/workspace",
  "secrets": {
    "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
    "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}",
    "GOOGLE_OAUTH_REFRESH_TOKEN": "${GOOGLE_OAUTH_REFRESH_TOKEN}",
    "GOOGLE_SERVICE_ACCOUNT_KEY": "${GOOGLE_SERVICE_ACCOUNT_KEY}"
  },
  "composed": "google",
  "allowedEndpoints": []
}
```

`Route` gains `composed?: 'google'`. It is valid only on a built-in template. `validateOAuth2Route`'s connector path, or a new check in `resolveCallerRoutesChecked`, rejects it on a custom connector with `composed is only allowed on built-in templates`.

## Composition algorithm

Where: `resolveCallerRoutesChecked`, right after `let route = custom ?? loadConnection(name)`, and inside the existing `try`, so a failure drops only `google` for this caller.

```
if (!custom && route.composed === 'google'):
  if ownEntry(overrides, 'google') !== undefined → throw (message above)
  if !Object.hasOwn(caller, 'google') → throw "needs callers.<alias>.google …"
  sel = validateGoogleSelection(caller.google)
  route = composeGoogleRoute(route, sel)
  validateOAuth2Route(route, 'connector')   // defence in depth: subject is allowed here
```

`composeGoogleRoute(base, sel)`:

1. `cat = loadGoogleCatalog()`, `mode = cat.auth[sel.auth]`.
2. `picked` = for each service in catalog order (gmail, calendar, drive, sheets, docs, slides), if `sel.services[svc]` is set: `{ svc, levelId, level: cat.services[svc].levels[levelId] }`. The fixed order makes the output deterministic whatever the key order in the JSON.
3. `scopes` = the de-duplicated concatenation of `level.scopes`. The token manager sorts and normalises it anyway.
4. `allowedEndpoints` = the de-duplicated concatenation of `level.allowedEndpoints`, in catalog order, with exclusions (`!…`) kept in place. Invariant 4 makes the order irrelevant to matching.
5. `secrets` = only the mode's `secretRefs` names, taken from `base.secrets`. A user-mode route never even resolves `GOOGLE_SERVICE_ACCOUNT_KEY`, and the other way round.
6. `oauth2`:
   - user: `{ tokenUrl, grant: 'refresh_token', clientAuth: 'body', secretRefs, scopes }`
   - SA: `{ tokenUrl, grant: 'jwt_bearer', secretRefs, scopes, ...(sel.subject && { subject: sel.subject }) }`

   `subjectRequired` is checked by the validator, not carried. `verifyGrantedScopes` keeps today's defaults: on for `refresh_token`, off for `jwt_bearer`, and reported scopes are still checked.
7. `testConnections` = `picked.map(p => ({ name: p.svc, level: p.levelId, ...p.level.testConnection }))`. There is no single `testConnection`.
8. `name: 'Google'`. `description` = `Google (<user OAuth | service account[, delegated]>): sheets edit, docs edit, slides edit, drive read.` followed by each picked level's `summary`. The subject is never put in the description; `list_routes` already reports `delegated: true` only.
9. `alias: 'google'`, and `category`/`stability`/`docsUrl` from the base. No `composed` on the output.

`Route`/`ResolvedRoute` gain one generic optional field, `testConnections?: Array<TestConnectionConfig & { name: string; level?: string }>`. It is generic so that `test_connection` doesn't special-case Google, and a custom connector may use it too. `hasTestConnection` is true when `testConnection` or `testConnections` is set. `resolveRoutes` carries it through.

Token cache: the cache key already includes the requested scopes and the subject (`token-manager.ts:470-478`). Changing the selection never serves an old token, and it clears the 60 s terminal backoff for the old key.

### Places that read a template without resolving it

Each of these is audited, and changed where needed, in PR 1:

| Call site | Today | Change |
|---|---|---|
| `tool-dispatch.ts` `oauth2Connection()` | `loadConnection(alias).oauth2` | `route.composed` counts as OAuth2 (returns a composed credential route) |
| `tool-dispatch.ts` `signingCredentialNames()` | templates with `oauth2`/`awsSigV4` | adds `googleCredentialRoutes()` (both modes) |
| `server.ts:468-494` boot secret table | `tpl.requiredSecrets` | `callerRequiredSecrets(tpl, caller)`: for `google`, the selected mode's `secretRefs` (user mode when there's no block) |
| `admin.ts` `connection-status`, `callers/:alias/connections` | `t.requiredSecrets` | same helper. `callerAuth` and `problem` already come from `resolveCallerRoutesChecked` and work as they are |
| `admin.ts` `connectionScopes()` (the "narrowed" flag) | template `oauth2.scopes` | `google` returns the composed scopes, so `narrowed` is false |
| `bin/drawlatch.js:706-730, 853-865` (`config`, `doctor`) | `tpl.requiredSecrets` | same helper. `doctor` also prints `googleMigration()` for callers that list removed IDs |
| `list_connection_templates` tool | template info | `google` reports both modes' secrets: required = user trio, optional = `GOOGLE_SERVICE_ACCOUNT_KEY`. `selfManageable` is unchanged |
| `describeConnectionTemplate` | — | `auth` omitted for `google` (no fixed scopes); new `composed: 'google'` flag so UIs can tell |

`callerRequiredSecrets` lives in `src/shared/connections.ts`, next to `describeConnectionTemplate`.

## Auth modes

- **`user`:** one refresh token per caller (`<ALIAS>_GOOGLE_OAUTH_REFRESH_TOKEN`), consented with exactly `googleConsentScopes(sel)`. Client ID and secret as today. Every level is available.
- **`service-account`:** `<ALIAS>_GOOGLE_SERVICE_ACCOUNT_KEY`, scopes as the JWT `scope` claim. With no `subject`, the account reaches what is shared with its `client_email`. With a `subject`, it acts as that user for every selected service. That replaces every `-sa` template and the per-template `oauth2Overrides[...].subject`. `subjectRequired` survives as `levels.read.subjectRequired` on Gmail. The validator enforces it with the message above, so a missing subject fails at boot and in the dashboard instead of on the first request.
- A caller can't mix modes. That case uses a custom connector for the other mode (see "What's lost").

## Selection vs consent

| Case | What Google does | What drawlatch does | How it's surfaced |
|---|---|---|---|
| selection = consent | grants exactly the union | works | — |
| selection ⊂ consent (a service was removed, or a token was reused) | either narrows (unverified) or returns the full grant | narrowed: works. Full grant: refused (`granted scopes broader … (<extra>)`), unchanged | `test_connection` adds `hint` that maps each extra scope back to its service and level (`drive.readonly = drive: read`), and `consentScopes`: "add those services, or re-consent with exactly SCOPES". The dashboard shows the same, and also a standing note in the editor whenever you remove a service: "removing a service usually needs a new refresh token" |
| selection ⊃ consent (a service was added) | `invalid_scope`, or a grant without the new scope | `invalid_scope`: terminal error for every service (60 s backoff). Subset: token minted, `missingScopes` set, and Google returns `403` for the new service | `test_connection` marks the affected services `notConsented: true`, with `hint` and `consentScopes`. The dashboard warns before saving a widening: "the refresh token must be re-consented for: …" |
| user unticked a scope on the consent screen | grants a subset | `missingScopes` | same as the row above |

Service-account mode has no consent step for shared files. With domain-wide delegation, the admin console's scope list must contain the union. An `access_denied` hint already covers that, and the dashboard prints the comma-separated form for the admin console.

## test_connection behaviour

`test_connection` (`tool-dispatch.ts:1171`) gains one branch. It is generic: it applies to any route with `testConnections`.

1. Mint once, as today. On failure, return `success: false` and `oauth2: { tokenMinted: false, requestedScopes }`, plus `services: { <svc>: { level, success: false, skipped: 'no token' } }`, the error, and (for Google) `consentScopes` and `hint`.
   - On `OAuth2ScopeError` with extra scopes, `hint` names the services and levels for them.
   - To do that, `OAuth2ScopeError` gains an additive `extraScopes?: string[]`, set where it is thrown (`token-manager.ts:782`). The message and the behaviour don't change.
2. Run every entry in `testConnections` with `executeProxyRequest(..., [route], remainingBudget(), { templateAuthored: true, caller })`, in parallel, sharing the remaining budget.
3. Result:

```json
{
  "success": false,
  "connection": "google",
  "oauth2": {
    "tokenMinted": true,
    "requestedScopes": ["…/drive.readonly", "…/spreadsheets"],
    "grantedScopes": ["…/spreadsheets"],
    "missingScopes": ["…/drive.readonly"]
  },
  "services": {
    "drive": {
      "level": "read",
      "success": false,
      "status": 403,
      "notConsented": true,
      "error": "Unexpected status 403 (expected 200)",
      "description": "Fetches the Drive user (about.get)"
    },
    "sheets": {
      "level": "edit",
      "success": true,
      "status": 200,
      "description": "Reads the ID of Google's public sample spreadsheet …"
    }
  },
  "consentScopes": "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets",
  "hint": "The token was not granted drive.readonly (drive: read). Re-consent the refresh token with exactly the scopes in consentScopes."
}
```

`success` is true only when every service passes. `consentScopes` and `hint` are scope names only. Neither the result nor the hint ever contains `subject`. That matters because the agent can call `test_connection` too, and a test asserts it.

Each entry calls the same URL its old template did, so `drive: file` and `drive: read` keep sharing `about?fields=user`.

## Admin/agent boundary

- **Writing the selection:** only through `remote.config.json`, or the admin router routes in PR 2 (`PUT`/`DELETE /api/admin/callers/:alias/google`). Like `PUT /callers/:alias/self-manage` (`admin-mutations.ts:243`), those routes write config directly, behind `requireAuth`, and never go through `dispatchTool`. That matters because any authenticated caller can call any `toolHandlers` entry by name.
- **Enabling `google`:** the admin path goes through the existing `POST /callers/:alias/connections/google` → `set_connection_enabled` with `origin: 'admin'`. The agent path is refused because `oauth2Connection()` treats `composed` as OAuth2. Disabling stays allowed.
- **Secrets:** `set_secrets` on the agent path refuses `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` and `GOOGLE_SERVICE_ACCOUNT_KEY`, in both modes and for every caller. The admin path is allowed.
- **Reading:** `list_routes` shows the composed description (services, levels, scopes) and `delegated: true`, never the subject. Admin GETs may show the subject, as the dashboard already does for `oauth2Overrides`.
- **Canaries:**
  - `oauth2-overrides-immutable.test.ts` grows a second fixture: a `google` block with a subject. Every tool is called from both origins with hostile input (`{ google: … }`, `connection: 'google'`, params named `services`/`auth`/`subject`), and the block must be byte-identical afterwards.
  - The vault canary (`vault.server.test.ts`, every admin `GET`) and the audit canary (`audit-log.server.test.ts`, every tool) pick up the new routes and tools automatically. Confirm they still pass.
- **Audit:** PR 2's `PUT`/`DELETE` call `deps.audit('google_selection', { caller, before: { auth, services, subjectSet }, after: {...} })`. They don't log the subject value; it's admin data, but the audit line doesn't need it.

## Overlap

With one Google route per caller, overlap between Google templates goes away. `connectionOverlapWarnings` and the OAuth2 ambiguity refusal in `executeProxyRequest` stay generic and unchanged. They still catch a custom connector that overlaps the composed allowlist: for example, a connector on `https://www.googleapis.com/drive/v3/**` next to `google` with `drive: read` gets a warning at boot and has its requests refused. Comments that cite Google pairs as the example (`config.ts:1104-1112`) are rewritten to use `discord-bot`/`discord-oauth`.

## Cross-service scope audit

Source: the Discovery documents, fetched on 2026-11-24. Revisions: Sheets v4 `20261118`, Docs v1 `20261118`, Slides v1 `20261118`, Drive v3 `20261117`, Calendar v3 `20261118`, Gmail v1 `20261116`. Below is what each API's methods accept, limited to the scopes the catalog offers.

| API | Read methods accept | Write methods accept |
|---|---|---|
| Sheets | `spreadsheets.readonly`, `spreadsheets`, `drive.readonly`, `drive.file`, `drive` | `spreadsheets`, `drive.file`, `drive` (14 methods incl. `create`, `batchUpdate`, `values.update/append/clear`, the `…ByDataFilter` forms) |
| Docs | `documents.readonly`, `documents`, `drive.readonly`, `drive.file`, `drive` | `documents`, `drive.file`, `drive` |
| Slides | `presentations.readonly`, `presentations`, `drive.readonly`, `drive.file`, `drive` | `batchUpdate`: `presentations`, `drive.file`, `drive`, **and** `drive.readonly`, `spreadsheets`, `spreadsheets.readonly` (for linked charts). `create`: `presentations`, `drive.file`, `drive` |
| Drive | only `drive.*` scopes | only `drive.*` scopes |
| Calendar | only `calendar.*` scopes | only `calendar.*` scopes |
| Gmail | only `gmail.*` scopes (and `mail.google.com`) | same |

Findings for selections the catalog allows:

1. **`drive` (full) would widen Sheets, Docs and Slides.** It is accepted by every write method of those three, so it would make `sheets: read` writable and reach every file. It is not offered (invariant 3).
2. **`sheets: read` + `drive: file` is the only widening combination.** The Sheets write methods accept `drive.file`, so the agent can edit spreadsheets that `drive.file` covers: files this OAuth client created, or that the user opened with it through the Picker. `spreadsheets.create` is still unreachable, because the bare `POST …/v4/spreadsheets` isn't in the read allowlist (`spreadsheets/**`). The set of files it can change doesn't grow: `drive: file` can already overwrite or delete those files through `upload/drive/v3/files/*`. **Recommendation: allow it, document it, and show `crossScopeNotes` in the dashboard editor and once at boot as info** (Q4). This combination can't arise in service-account mode, because `drive: file` is user-only.
3. **`docs: edit` and `slides: edit` with any Drive or Sheets level:** no widening. `documents` and `presentations` already allow full read and edit, and the drive scopes add no file Docs or Slides can't already reach under their own scope.
4. **Slides `batchUpdate` now works with Sheets and Drive scopes.** `createSheetsChart` (with `sheets` selected) and `createVideo` from Drive (with `drive` selected) succeed where they returned `403` under separate tokens. They read data the caller is already allowed to read. This changes the CONNECTIONS.md note "Linked Sheets charts and Drive videos need more scope".
5. **Drive, Calendar and Gmail accept no other service's scopes.** Adding Sheets, Docs or Slides never widens them. `gmail.users.watch`/`stop` accept `gmail.metadata`/`readonly`, but they stay unreachable because the allowlist excludes them (tested).
6. **Rule for future additions.** Adding any `*.readonly` level for Docs or Slides would need this audit again: their read-only level would become writable next to `drive.file`, and Slides would become writable next to `drive.readonly` and `spreadsheets*`.

This is mechanised in the catalog. `apiAccepts` records the table above per service (`read`, `write`), with the Discovery revision. `google-catalog.test.ts` takes every valid selection (all combinations, about 3·3·3·3·2·2 = 324 per mode), flags every read-only level whose service's `write` set intersects the selection's scopes, and asserts that the flagged set equals `crossScopeNotes` exactly. Adding a level or a scope then fails the test until someone redoes the audit and documents the result.

## Security analysis: what changes compared with per-template tokens

1. **One access token carries the union.** Each request still goes only to an allowlisted URL, and the agent never sees the token. What the union adds at Google's end is exactly the audit above: one documented widening, plus the Slides linking. A token leaked from daemon memory now carries every selected scope instead of one. The refresh token was already consented for the union in the "master token" setup the docs recommended trying. Only the per-scope fallback had narrower refresh tokens, and that fallback is removed.
2. **One credential per caller.** Isolation between callers is unchanged (`<ALIAS>_` prefixes). Within a caller, revoking it or hitting a terminal error (`invalid_grant`, `invalid_scope`, a refused scope) takes out every Google service for 60 s instead of one. `test_connection` reports per service, so you can still see which one caused it.
3. **Exact-scope refusal** still holds, against the union. A token with anything beyond the selection is refused.
4. **Lost capabilities.** Each has a workaround through a custom connector with its own `oauth2` block and differently named secrets:
   - mixing user OAuth and a service account on one caller (say Gmail through user OAuth and Sheets through an SA limited to shared files);
   - different subjects per service (`gmail-readonly-sa` as alice next to `sheets-sa` with no subject, today via two `oauth2Overrides` entries);
   - different Google accounts or refresh tokens per service;
   - per-service connection names in the audit log (the URL in each audit line still shows the service).
5. **The admin surface grows.** The dashboard can now widen a caller's Google access, which no dashboard control could do before. That's acceptable, because the dashboard can already enable any connection and set its secrets. It is mitigated by an explicit confirm-on-widen, an audit line, and the canary.
6. **Fail closed by construction.** The base template has no credentials in headers and an empty allowlist. The policy gates get their own tests for the `composed` case (invariant 2).

## Removals (exhaustive)

**Templates** in `src/connections/productivity/`, 17 files deleted:
`google-calendar-freebusy.json`, `google-calendar-readonly.json`, `google-calendar-readonly-sa.json`, `google-docs.json`, `google-docs-sa.json`, `google-drive-file.json`, `google-drive-readonly.json`, `google-drive-readonly-sa.json`, `google-gmail-metadata.json`, `google-gmail-readonly.json`, `google-gmail-readonly-sa.json`, `google-sheets.json`, `google-sheets-sa.json`, `google-sheets-readonly.json`, `google-sheets-readonly-sa.json`, `google-slides.json`, `google-slides-sa.json`.
`google.json` is rewritten as the base template, and the static-token template is removed. Recommendation and reasoning:

- **Remove the static-token `google` (recommended).** The new connection needs the alias. The static template is `dev` stability. It holds a raw OAuth access token, which expires within an hour unless the user refreshes it by hand. It grants every scope that token has and bypasses scope checking. Its `www.googleapis.com/**` allowlist would overlap the composed route on every catalog host, so a caller with both would have its Google requests refused as ambiguous. The hosts only it reaches (YouTube, People, Tasks, Admin, Chat, Forms, Cloud Resource Manager, …) are better served by a custom connector with an `oauth2` block and its own refresh token. CONNECTIONS.md gets a worked example (see "Other Google APIs").

**SA_TWINS machinery:** it exists only in `src/remote/google-templates.test.ts` (`SA_TWINS`, the "no drift" test, and "only the Gmail service-account template requires a subject"). It's removed with that file. The twins are now one catalog entry with `auth: [...]`, so they can't drift.

**Tests:**

- `src/remote/google-templates.test.ts`: deleted. Its allow/deny cases, `FORBIDDEN`, `WATCH_AND_CHANNELS`, the `**`-boundary check, the "test inside its own allowlist" check, the Sheets/Docs/Slides encoding and dot-segment cases, and the one-segment `presentations.get` case move to `src/shared/google-catalog.test.ts`, keyed by service and level. Dropped: "google.json is unchanged apart from…" (line 726), "one refresh token per scope set (documented fallback)" (742), "one refresh token granted several Sheets/Drive scopes" (833), and "one master refresh token for Docs, Slides and Sheets" (880). The last two are replaced by union tests in `google-compose.test.ts`: granted equals requested and succeeds; a strict-subset selection with a full grant is refused with the hint.
- `src/remote/route-overlap.test.ts` (69 `google-*` refs): drop the Google-pair cases, keep the generic ones, and add "`google` + a custom connector on a Drive path → warning + refusal" and "`google` alone → no warning".
- `src/shared/oauth2-config.test.ts:430-455`: the list of overlapping built-ins loses the Google entries.
- `src/remote/self-manage.test.ts` (35 refs): retarget to `google`, covering both modes' secrets and a caller in each mode.
- `src/remote/admin.test.ts:255-295`: retarget the auth view to a `google` caller in SA mode with a subject.
- `src/remote/allowlist-exclusions.test.ts:98`: take the Calendar allowlist from `loadGoogleCatalog()`.
- `src/remote/withheld-secrets.test.ts:350`: the header-only `GOOGLE_API_TOKEN` case moves to another header-auth template (e.g. `github`/`GITHUB_TOKEN`).
- `src/shared/connections.test.ts:275-281` (static google secrets), `:495`, `:1373` (`google` in the `dev` aliases list; it's now `beta`), `:1469`.
- `src/shared/connection-docs.test.ts:18`: the test name "-sa twins included" changes. The count assertion stays and is driven by the README number.
- `src/remote/server.e2e.test.ts:3185-~3300` ("Scoped Google templates (live)"): rewritten. See the test plan.

**Code comments:** `src/remote/tool-dispatch.ts:904`, `:921-926`; `src/shared/config.ts:120` (the `GOOGLE_API_TOKEN` echo example, which becomes `GITHUB_TOKEN`) and `:1104-1112`; `src/shared/config.ts` `OAuth2Config.subjectRequired` doc (the example becomes "e.g. Gmail through a service account").

**Docs:** see "Docs changes".

**Frontend:** `frontend/src/components/AuthSummary.tsx:8-9` (header comment), `:84-93` ("needs a subject: set oauth2Overrides…": for `google`, point to the Google editor), `:105-114` (`SECRET_HINTS`, which cite "Google (scoped)" and "this connection's scopes"). Nothing else in `frontend/src` names a Google template.

**Env examples:** `.env.e2e.example:36-57`, rewritten. `.env.example` has only Gemini and is unchanged.

**Kept:** `google-ai` (Gemini); `src/remote/oauth/google-jwt.ts` and its test (the SA signer); `oauth2Overrides` (still used by custom connectors); `subjectRequired` on `OAuth2Config` (still valid for custom connectors); the `plans/` files.

## Migration and boot errors

**Today**, measured on 1054456 with a probe test: a caller listing an unknown ID such as `google-sheetz` gets one boot line, `[remote] Caller "a": Unknown connection "google-sheetz". Available connections: <all 49>`, from `validateRemoteConfig`. The daemon keeps running. Every `resolveCallerRoutes` for that caller then throws, because `loadConnection` sits outside the per-connection `try` (`config.ts:1012`). The caller's handshakes fail with `403 { error: "Unknown connection …" }`, so all of its connections stop working, not just that one. The dashboard's `callerAuthView` swallows the error (`admin.ts:161-165`).

**New:**

1. `src/shared/connections.ts` gets `REMOVED_CONNECTIONS: Record<string, { service, level, auth }>` for the 17 IDs. `loadConnection(name)` checks it before the "Unknown connection" error and throws:
   `Connection "google-sheets" was removed: use "google" with callers.<alias>.google = { "auth": "user", "services": { "sheets": "edit" } }. See CONNECTIONS.md → Google.`
   That's the message the caller's agent gets in the handshake `403`.
2. `validateRemoteConfig` adds one consolidated `googleMigration(caller)` problem per caller, built from all of its removed IDs plus any `oauth2Overrides[<id>].subject`:
   ```
   Caller "household": "google-sheets", "google-drive-readonly" were replaced by the single "google" connection. In remote.config.json, replace them with:
     "connections": [ …, "google" ],
     "google": { "auth": "user", "services": { "drive": "read", "sheets": "edit" } }
   and consent the caller's GOOGLE_OAUTH_REFRESH_TOKEN for exactly: https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets
   Until then this caller cannot connect (CONNECTIONS.md → Google).
   ```
   - All IDs ending in `-sa` give `"auth": "service-account"`, plus `"subject"` if every override agrees.
   - A mix of user and `-sa` IDs: `…mixes user-OAuth and service-account templates; one "google" connection uses one auth mode. Pick one, and use a custom connector for the other (CONNECTIONS.md → Other Google APIs).`
   - Two levels of one service (`google-sheets` and `google-sheets-readonly`): `…lists two levels for sheets (edit, read); pick one.` The suggestion uses the first one listed.
3. `server.ts` prints those problems with an `ERROR` prefix and a blank line around each, so the multi-line JSON stays readable.
4. `bin/drawlatch.js doctor` prints the same text.
5. `GET /api/admin/callers` gains `configProblem?: string` for callers that can't be resolved, so the dashboard shows a red banner instead of silently empty auth. That's a small generic fix for any unknown ID, in PR 1, so the dashboard isn't misleading between the PRs.

The daemon does not exit. One stale caller shouldn't take down the others, and this matches how unknown IDs behave today (Q5). `REMOVED_CONNECTIONS` stays until a later cleanup. It is 17 lines and costs nothing.

## Other Google APIs (replaces the static template)

CONNECTIONS.md gets a section with a complete custom connector, Tasks read-only:

- alias `google-tasks`;
- secrets `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and a separately named `GOOGLE_TASKS_REFRESH_TOKEN`;
- an `oauth2` block with scope `tasks.readonly`;
- an allowlist on `tasks.googleapis.com/tasks/v1/…`;
- a test.

It must use **its own refresh token**. The `google` token is consented for exactly the selection, so adding a scope to that consent makes the `google` connection's tokens fail with "broader than this connection allows". It must also stay off the catalog's paths, or the overlap refusal will catch it. Agent-path `set_secrets` already refuses custom connectors' `secretRefs`.

## Docs changes (one home per topic, same PR as the code)

**CONNECTIONS.md** (PR 1):

- "Available connections": the 17 rows go. The `google` row becomes: `| \`google\` | [Google Workspace](…): Gmail, Calendar, Drive, Sheets, Docs, Slides | **\`GOOGLE_OAUTH_CLIENT_ID\`**, **\`GOOGLE_OAUTH_CLIENT_SECRET\`**, **\`GOOGLE_OAUTH_REFRESH_TOKEN\`**, or **\`GOOGLE_SERVICE_ACCOUNT_KEY\`** | OAuth2, minted (scopes from \`callers.<alias>.google\`) | |`.
- Line 99, "Google / Google AI": rewritten. The static template is gone, and the note points to "Google" and "Other Google APIs".
- "### Google (scoped)" (lines 125-336) becomes "### Google":
  - intro and config example;
  - **Services and levels**: the existing table re-keyed by service and level, plus an auth-mode column;
  - **Auth modes**: replaces "Which flavour";
  - **Secrets**: simplified; the agent can't set them, and `selfManage: false` is still advised;
  - **User OAuth setup**: step 3 says set `SCOPES` to the selection's consent scopes (from the dashboard or `test_connection`'s `consentScopes`), and the example becomes the `household` selection;
  - **Changing the selection**: replaces "Narrowing on refresh is not verified", "one refresh token per scope set", and "One master token". Widening needs a new consent. Narrowing works only if Google narrows on refresh, so re-consent instead;
  - **Service-account setup**: step 4's JSON becomes the `google` block with `subject`; "`subject` is admin-only config…" is updated (the dashboard can now edit it, from PR 2);
  - **Service notes**: what was "Template notes", with names updated, the "Linked Sheets charts…" bullet rewritten (audit finding 4), and a new bullet for `sheets: read` + `drive: file` (finding 2);
  - **Cross-service scopes**: a short version of the audit table and its findings, with the Discovery revisions;
  - **Other Google APIs**: replaces "The rest of Google…".
- Removed outright: "Mixing with `google`", the per-scope-set custom-connector recipe, "One master token for several templates", and the 100-token note's "if you mint one per scope set".

**README.md** (PR 1):

- `**49 pre-built connections**` becomes `**32 pre-built connections**` (`connection-docs.test.ts` enforces it).
- Line 110: the `selfManage` text uses `google-*`/`GOOGLE_API_TOKEN` as examples. It changes to "every caller's `google` connection reads `GOOGLE_OAUTH_REFRESH_TOKEN`".
- Line 174: next to the `oauth2Overrides` row, add a `google` row to the caller keys table: shape, admin-only, "an invalid block drops the connection and is logged", a link to CONNECTIONS.md. The `oauth2Overrides` row says it doesn't apply to `google`.
- Line 195: the header-only example moves off `GOOGLE_API_TOKEN`.
- Line 269: "The `google` connection is built on this".
- Line 307: the `subject` row says "per caller, `oauth2Overrides`, or `google.subject` for the Google connection".
- Line 308: the `subjectRequired` example is rewritten.
- Line 347: the overlap list loses the Google pairs.
- MCP tools table, `test_connection`: "for a connection with several tests (`google`), runs each and reports `services`".
- Custom connectors table: `testConnections`.
- PR 2: the Dashboard section describes the Google editor.

**INGESTORS.md:** no change; Google has no listener. Say so in the PR description.

**CLAUDE.md** "Where things live": one bullet, **Google:** catalog `src/connections/google-catalog.json`, loader/composer `src/shared/google.ts`, selection in `callers.<alias>.google` (admin-only; the canary is in `oauth2-overrides-immutable.test.ts`). CLAUDE.md is contributor notes, not a design record, so updating it is in scope.

**`.env.e2e.example`:** one refresh token consented for `GOOGLE_E2E_SELECTION` (JSON, default `{"gmail":"read","calendar":"read","drive":"read","sheets":"edit","docs":"edit","slides":"edit"}`). The e2e prints the consent scopes when it skips.

## Test plan (TDD order)

PR 1, each step red first:

1. **Catalog parity** (`google-catalog.test.ts`, temporary block): for each of the 17 templates, the catalog level's `scopes`, `allowedEndpoints` and `testConnection` `toEqual` the JSON file's. Write the test, then the catalog. This block is deleted in the commit that deletes the templates, and its green run in the previous commit is the proof the content moved unchanged.
2. **Catalog invariants:** the moved allow/deny cases per level; `FORBIDDEN` and `WATCH_AND_CHANNELS` for every level; `**` only after a boundary; every test URL inside its level's allowlist and read-only (POST only for `calendar: freebusy`); the exact set of ten scopes, with `drive`, `drive.metadata*`, `mail.google.com` and `cloud-platform` absent; service-account availability matching the table; `subjectRequired` only on `gmail.read`; cross-service patterns pairwise non-overlapping (invariant 4); the top-level `google-catalog.json` is not in `listAvailableConnections()`.
3. **Cross-scope audit:** the 324×2 selection sweep against `apiAccepts`, matching `crossScopeNotes` exactly.
4. **`validateGoogleSelection`:** table-driven, one case per message above, plus prototype keys and non-string levels.
5. **`composeGoogleRoute`:** user and SA shapes; order and de-duplication whatever the key order; secrets limited to the mode; subject carried, `subjectRequired` absent; `validateOAuth2Route(…, 'connector')` passes; the description has no subject; the result has `testConnections` but no `testConnection`.
6. **`resolveCallerRoutesChecked`:** each row of the resolution table; the `GOOGLE_API_TOKEN` hint; a custom connector named `google` wins; `composed` on a custom connector is rejected.
7. **Removed IDs:** the `loadConnection` message for all 17; `googleMigration` for single, multiple, all-`-sa` with subject, mixed, and same-service-twice; handshake `403` carries the message (`server.test.ts`); `configProblem` in `GET /admin/callers`.
8. **Policy gates** (`self-manage.test.ts`): agent `set_connection_enabled('google', true)` refused, `false` allowed; agent `set_secrets` refuses all four names for a user-mode caller, an SA caller, and a caller without `google`; admin origin allowed. The canary grows the `google` block fixture.
9. **`test_connection`** (`google-compose.test.ts`, mock token endpoint and upstream through the existing test fetch hooks): all pass; one service `403` with `missingScopes` gives `notConsented` and a `hint`; `OAuth2ScopeError.extraScopes` gives a level-mapped `hint`; mint failure gives `skipped`; output never contains the subject; a generic `testConnections` on a custom connector works.
10. **Token manager:** `OAuth2ScopeError.extraScopes` is set, and the message is unchanged (`token-manager.test.ts`).
11. **Overlap:** the new `route-overlap.test.ts` cases.
12. **Required secrets per mode:** boot table, `connection-status`, `callers/:alias/connections`, `drawlatch doctor` (spawned CLI against a temp `MCP_CONFIG_DIR`).
13. **Docs tests:** README count; CONNECTIONS.md rows.
14. **Delete** the 17 templates, `google-templates.test.ts`, and the parity block. Rewrite the retargeted tests listed under "Removals".
15. **e2e** (`server.e2e.test.ts`): a `google` caller with `GOOGLE_E2E_SELECTION` runs `test_connection` and expects every service to pass with `grantedScopes == requestedScopes`. An SA caller does the same without `gmail` (and with `gmail` when `GOOGLE_E2E_SUBJECT` is set). The `google-scope-probe` custom connector stays as an informational check of whether Google narrows: it asks for one scope of the union.

PR 2:

16. **Admin API** (`admin-google.test.ts`):
    - `GET /api/admin/google/catalog`: names, levels, scopes, summaries, modes, `crossScopeNotes`, with no allowlists beyond what `/admin/connections` already shows;
    - `GET /api/admin/callers/:alias/google`;
    - `PUT` with each validation `400` (same messages), `404` for an unknown caller, `__proto__` and `constructor` aliases refused, only `callers.<alias>.google` changed (byte-compare the rest of the file), `refreshCaller` and `audit` called, the response's `consentScopes`;
    - `DELETE`.
17. **Canaries:** confirm the vault and audit sweeps still pass with the new routes.
18. **Dashboard:** no frontend test harness exists. Verify manually with the `run` skill against a temp `MCP_CONFIG_DIR`, with screenshots in the PR: the editor in both modes, the widening confirm, the per-service test results, and the migration banner.

## Dashboard (PR 2)

**Admin API** (`src/remote/admin-google.ts`, mounted like `admin-vault.ts`, behind `requireAuth`, not through `dispatchTool`):

| Route | Body / result |
|---|---|
| `GET /api/admin/google/catalog` | `{ services: [{ id, name, docsUrl, enableApi, levels: [{ id, summary, scopes, auth, subjectRequired? }] }], crossScopeNotes }` |
| `GET /api/admin/callers/:alias/google` | `{ enabled, selection: GoogleCallerConfig \| null, consentScopes, problem?, notes: string[] }` |
| `PUT /api/admin/callers/:alias/google` | body: a `GoogleCallerConfig`. Validates with `validateGoogleSelection`, saves, `refreshCaller`, audits, and returns the same as `GET` |
| `DELETE /api/admin/callers/:alias/google` | removes the block. If `google` is still enabled, it is then dropped and gets a `problem` |

**UI:**

- **Connections page:** one Google card. It shows an auth-mode badge ("User OAuth" or "Service account · delegated") and chips per service (`sheets · edit`, …). Secret status comes from the selected mode's secrets, through the per-mode `requiredSecrets` from PR 1. The card also carries `problem` and a **Test** button. Test results render per service as a list (✓/✗ with status, `notConsented`, `hint`) instead of today's single line. Fix the existing card's habit of labelling `success: false` as "Test passed" when the HTTP call succeeds (`ConnectionsPage.tsx:562-566`) for every card: read `data.success`.
- **Configure modal** (`ConfigureConnectionModal.tsx`): a new `GoogleSelectionEditor` component.
  - **Auth mode:** radios "User OAuth" and "Service account". Switching modes switches the secrets section below to that mode's secrets, which still go through `set_secrets` with `origin: 'admin'`.
  - **Matrix:** one row per service, with radio columns `Off` plus that service's levels, rendered from the catalog payload with no hardcoded levels. A level unavailable in the current mode is disabled, with the tooltip "not available with a service account". Each level shows its `summary`.
  - **Subject:** a field shown in service-account mode. It is required, with an inline error, when Gmail is selected.
  - **Consent scopes:** a box that updates as you click. User mode shows the space-separated `SCOPES="…"` line, ready for the CONNECTIONS.md recipe. Service-account mode shows the comma-separated list for the Admin console's domain-wide delegation. Both have copy buttons. Under it: "Consent the refresh token for exactly these scopes. Adding or removing a service usually needs a new refresh token (CONNECTIONS.md → Google › Changing the selection)."
  - **Notes:** each `crossScopeNotes` entry whose `when` matches the selection, shown as an inline warning.
  - **Save:** if the new selection adds scopes, `ConfirmDialog` lists each added level's summary ("drive · read: read every Drive file the account can open"). Then `PUT`, then an offer to run the test.
- **Caller detail:** the Google row's `AuthSummary` shows mode, chips, and "acts as `<subject>`". The "needs a subject" text points to the editor instead of `oauth2Overrides`. A caller-level `configProblem` banner covers stale IDs.

## PR split

Two stacked PRs, as expected, with PR 1 reviewed commit by commit.

**PR 1: `feat(google): one google connection, services chosen per caller`.** Engine, catalog, config, `test_connection`, policy gates, migration errors, the read-only admin fields (`requiredSecrets` per mode, `configProblem`), removals, and docs. Commit order:

1. catalog and parity test;
2. validator and composer, with their tests;
3. resolution wiring and policy gates, with the canary;
4. `test_connection` with `testConnections` and `extraScopes`;
5. migration errors, CLI and boot;
6. delete the templates and the old tests, retarget the rest;
7. docs.

It is safe on its own: the existing dashboard toggles `google`, shows its scopes through `callerAuth`, and shows problems. Only the selection editor is missing, and `remote.config.json` covers that meanwhile.

**PR 2: `feat(dashboard): Google services editor`.** The admin write API and the UI.

Why not three PRs (additive engine, then removals, then dashboard)? The new connection needs the `google` alias, so the static template has to go in the same PR, and a period with both the scoped templates and the composed connection would only bring back the overlap and docs confusion. Why the admin write API sits in PR 2 rather than PR 1: it exists only for the editor, and its tests read best next to it. PR 1 has no reachable code path that writes the selection.

## Conflicts with open PRs

- **#26, `feat/oauth2-template-block` (Spotify + generic OAuth2 refresh), last updated 2026-06-22:** this PR is older than the OAuth2 engine on `main` and adds its own token refresh in `token-manager.ts`, `config.ts`, `connections.ts` and `tool-dispatch.ts`, so it already has to be rewritten onto `main`'s `oauth2` block. This plan conflicts textually in `config.ts` (`resolveCallerRoutesChecked`, `Route`), `connections.ts` (`loadConnection`, `describeConnectionTemplate`), `tool-dispatch.ts` (`test_connection`, policy gates) and CONNECTIONS.md (the table). There is no semantic conflict. Spotify templates would be plain `oauth2` templates on the unchanged engine. Its `spotify-catalog` is a template name, not a catalog mechanism. Recommendation: land this first, then rebuild #26's templates on `main`'s engine, or close it.
- **#47, `docs/review-x-api-pay-per-use-billing`, last updated 2026-10-14:** it touches only `src/connections/social-media/x.json` and CONNECTIONS.md (the X note and maybe its table row). If both land, expect a trivial conflict near the table, where this plan removes 17 nearby rows. It doesn't matter which lands first. Merging #47 first keeps this rebase simpler.

## Open questions for the owner (each has a default, so work isn't blocked)

- **Q1. Remove the static-token `google` template?** Default: **yes.** It's replaced by the new `google`, with the "Other Google APIs" custom-connector recipe for uncatalogued APIs.
- **Q2. A dedicated caller key `google` instead of a generic per-connection options bag?** Default: **`google`**. Generalise when a second composed connection exists.
- **Q3. Service-account levels.** Offer only the levels that had `-sa` twins: not `gmail: metadata`, `calendar: freebusy` or `drive: file`. Default: **yes, only those.** `gmail: metadata` and `calendar: freebusy` through domain-wide delegation would probably work, but have never been tried, and `drive.file` means little for an account that owns no files. Adding them later is one catalog change plus the audit test.
- **Q4. `sheets: read` + `drive: file`.** Default: **allow it, with a documented note** shown in the dashboard and as info at boot, since it doesn't grow the set of files the agent can change. The alternative is to refuse the combination in the validator.
- **Q5. Should a removed template ID stop the daemon from starting?** Default: **no.** That caller fails, with a multi-line boot error, the handshake `403` message, and a dashboard banner. The other callers keep working, which matches how unknown IDs behave today.
- **Q6. Can the dashboard edit `subject`?** It's admin config that no dashboard control writes today. Default: **yes**, through the PR 2 `PUT`, audited as `subjectSet` only. `list_routes` keeps hiding it from agents.
- **Q7. Keep the `google-scope-probe` narrowing e2e?** Default: **keep it** as an informational, skippable check. If it ever shows that Google narrows, CONNECTIONS.md "Changing the selection" can say so and drop the advice to re-consent when removing a service.
