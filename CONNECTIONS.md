# Connections

A connection is a built-in template that gives an API's allowed URL patterns, the headers to inject, and the secrets it needs. Enable one by adding its name to a caller's `connections` list in `remote.config.json`, or from the dashboard:

```json
{ "callers": { "default": { "connections": ["github", "stripe"] } } }
```

Then set the secrets for that caller. Caller `default` reads `GITHUB_TOKEN` from `DEFAULT_GITHUB_TOKEN`. See [README → Secrets](README.md#secrets) for how secrets resolve, and [README → Custom connectors](README.md#custom-connectors) to add an API or override a template (a custom connector with the same alias wins). Templates live in `src/connections/<category>/<name>.json`. A caller's own [vault](README.md#vault) items can be used on any connection it has enabled, as `${vault:<name>}` in a `secure_request` (another caller's item shared with it by a grant as `${vault:<owner>/<name>}`; [README → Using vault items in requests](README.md#using-vault-items-in-requests)); templates don't change.

## Available connections

**Bold** secrets are needed for API calls. The others are used only by the event listener, if at all. `doctor`, `config`, and the dashboard flag missing secrets only for built-in templates, and only those used in headers, so they won't catch a missing Telegram or Trello token. (`aws` and `google` are the exceptions: their signing keys and credentials count as required, for `google` those of the auth mode the caller selects.) Set `<ALIAS>_<NAME>` even where `doctor` prints the bare name. Header secrets, listener `signatureSecret`s, and Slack's `SLACK_APP_TOKEN` are [withheld](README.md#header-only-secrets): the agent can't reference them as `${NAME}` in a request, and they're scrubbed from response bodies and listener events. That includes public values sent in headers, such as Twitch's `TWITCH_CLIENT_ID` and Reddit's `REDDIT_USER_AGENT`, which appear in responses as `${NAME}`; a custom connector can opt one out with `placeholderSecrets`. Listener types are described in [INGESTORS.md](INGESTORS.md).

| Connection | API | Secrets | Auth | Listener |
| --- | --- | --- | --- | --- |
| `agentmail` | [AgentMail](https://docs.agentmail.to/api-reference) | **`AGENTMAIL_API_KEY`** | Bearer | |
| `anthropic` | [Anthropic](https://docs.anthropic.com/en/api) | **`ANTHROPIC_API_KEY`** | `x-api-key` | |
| `aws` | [AWS](https://docs.aws.amazon.com/general/latest/gr/aws-service-information.html) | **`AWS_ACCESS_KEY_ID`**, **`AWS_SECRET_ACCESS_KEY`**, `AWS_SESSION_TOKEN` | SigV4 signature | |
| `bluesky` | [Bluesky (AT Protocol)](https://docs.bsky.app/) | **`BLUESKY_ACCESS_TOKEN`** | Bearer | poll |
| `circleci` | [CircleCI](https://circleci.com/docs/api/v2/) | **`CIRCLECI_TOKEN`** | `Circle-Token` | |
| `datadog` | [Datadog](https://docs.datadoghq.com/api/latest/) | **`DATADOG_API_KEY`**, **`DATADOG_APP_KEY`** | `DD-API-KEY`, `DD-APPLICATION-KEY` | |
| `devin` | [Devin](https://docs.devin.ai/api-reference/overview) | **`DEVIN_API_KEY`** | Bearer | |
| `digitalocean` | [DigitalOcean](https://docs.digitalocean.com/reference/api/) | **`DIGITALOCEAN_TOKEN`** | Bearer | |
| `discord-bot` | [Discord (bot)](https://discord.com/developers/docs/intro) | **`DISCORD_BOT_TOKEN`** | `Bot` token | WebSocket |
| `discord-oauth` | [Discord (OAuth2)](https://discord.com/developers/docs/topics/oauth2) | **`DISCORD_OAUTH_TOKEN`** | Bearer | |
| `exa` | [Exa](https://exa.ai/docs/reference/getting-started) | **`EXA_API_KEY`** | `x-api-key` | |
| `firecrawl` | [Firecrawl](https://docs.firecrawl.dev/api-reference/introduction) | **`FIRECRAWL_API_KEY`** | Bearer | |
| `github` | [GitHub REST](https://docs.github.com/en/rest) | **`GITHUB_TOKEN`**, `GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_URL` | Bearer | webhook |
| `google` | [Google Workspace](https://developers.google.com/workspace): Gmail, Calendar, Drive, Sheets, Docs, Slides | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`**, or **`GOOGLE_SERVICE_ACCOUNT_KEY`** | OAuth2, minted (scopes from `callers.<alias>.google`) | |
| `google-ai` | [Google AI (Gemini)](https://ai.google.dev/api) | **`GOOGLE_AI_API_KEY`** | `x-goog-api-key` | |
| `hex` | [Hex](https://learn.hex.tech/docs/api/api-overview) | **`HEX_TOKEN`** | Bearer | |
| `lichess` | [Lichess](https://lichess.org/api) | **`LICHESS_API_TOKEN`** | Bearer | |
| `linear` | [Linear (GraphQL)](https://developers.linear.app/docs/graphql/working-with-the-graphql-api) | **`LINEAR_API_KEY`** | `Authorization` (no prefix) | poll |
| `mastodon` | [Mastodon](https://docs.joinmastodon.org/api/) | **`MASTODON_ACCESS_TOKEN`** | Bearer | poll |
| `notion` | [Notion](https://developers.notion.com/reference) | **`NOTION_API_KEY`** | Bearer | poll |
| `openai` | [OpenAI](https://platform.openai.com/docs/api-reference) | **`OPENAI_API_KEY`** | Bearer | |
| `openrouter` | [OpenRouter](https://openrouter.ai/docs/api-reference) | **`OPENROUTER_API_KEY`** | Bearer | |
| `parallel` | [Parallel](https://docs.parallel.ai/api-reference/search/search) | **`PARALLEL_API_KEY`** | `x-api-key` | |
| `perplexity` | [Perplexity](https://docs.perplexity.ai/api-reference) | **`PERPLEXITY_API_KEY`** | Bearer | |
| `reddit` | [Reddit](https://www.reddit.com/dev/api/) | **`REDDIT_ACCESS_TOKEN`**, **`REDDIT_USER_AGENT`**, `REDDIT_SUBREDDIT` | Bearer + `User-Agent` | poll |
| `slack` | [Slack Web API](https://docs.slack.dev/apis/web-api) | **`SLACK_BOT_TOKEN`**, `SLACK_APP_TOKEN` | Bearer | WebSocket |
| `stripe` | [Stripe](https://docs.stripe.com/api) | **`STRIPE_SECRET_KEY`**, `STRIPE_WEBHOOK_SECRET` | Bearer | webhook |
| `telegram` | [Telegram Bot API](https://core.telegram.org/bots/api) | **`TELEGRAM_BOT_TOKEN`** | token in URL path | poll |
| `trello` | [Trello](https://developer.atlassian.com/cloud/trello/rest/) | **`TRELLO_API_KEY`**, **`TRELLO_TOKEN`**, `TRELLO_API_SECRET`, `TRELLO_CALLBACK_URL` | query parameters | webhook |
| `twitch` | [Twitch Helix](https://dev.twitch.tv/docs/api/reference/) | **`TWITCH_ACCESS_TOKEN`**, **`TWITCH_CLIENT_ID`**, `TWITCH_USER_ID` | Bearer + `Client-Id` | poll |
| `vercel` | [Vercel](https://vercel.com/docs/rest-api) | **`VERCEL_TOKEN`** | Bearer | |
| `x` | [X API v2](https://developer.x.com/en/docs/x-api) | **`X_BEARER_TOKEN`**, `X_SEARCH_QUERY` | Bearer | poll |

Every template has a built-in `test_connection` request. Three tests cost a little credit: the Anthropic test sends a 1-token message, Exa runs a one-result search, and Parallel runs a small `turbo` search.

A secret that isn't set is sent as the literal placeholder (for example, `Bearer ${LICHESS_API_TOKEN}`). The `aws` connection and the OAuth2 templates refuse to send a request without their credentials instead. Set every bold secret even for APIs with public endpoints.

## Notes by connection

**AgentMail.** Email for agents: inboxes, messages, threads, drafts. Endpoints are under `/v0` on `api.agentmail.to`. Create a key in the [AgentMail Console](https://console.agentmail.to). Inbound-email webhooks aren't wired up as a listener.

**Anthropic.** `anthropic-version` is pinned to `2023-06-01`. Override with a custom connector to use another version.

**AWS.** The daemon signs every request with [Signature Version 4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html), so the agent never handles the keys. How signing works, and which headers a request may not set, is in [README → AWS SigV4 signing](README.md#aws-sigv4-signing). Notes for using the template:

- **Region and service** come from the hostname. Call the regional endpoint for the region you want, such as `https://dynamodb.eu-west-1.amazonaws.com/` or `https://sts.ap-southeast-2.amazonaws.com/`. Global endpoints (`sts.amazonaws.com`, `iam.amazonaws.com`, `route53.amazonaws.com`) sign for `us-east-1`. The [service endpoints list](https://docs.aws.amazon.com/general/latest/gr/aws-service-information.html) has each service's hostnames. Where the endpoint prefix isn't the signing name and drawlatch doesn't know the mapping (for example, IoT data plane endpoints sign as `iotdata`), add a custom connector with an explicit `awsSigV4.service`/`region` and narrower `allowedEndpoints`.
- **Request formats.** Query-protocol APIs (STS, IAM, EC2) take `Action=…&Version=…` as a GET query or as a form-encoded POST body with `Content-Type: application/x-www-form-urlencoded; charset=utf-8`. JSON-protocol APIs (DynamoDB, CloudWatch Logs, and others) need `Content-Type: application/x-amz-json-1.0` or `1.1` and an `X-Amz-Target` header. Pass these yourself. A JSON object body otherwise gets `application/json`. Encode spaces in query strings as `%20`, not `+`.
- **S3** works for API calls and text objects, with virtual-hosted (`https://bucket.s3.us-west-2.amazonaws.com/key`) or path-style (`https://s3.us-west-2.amazonaws.com/bucket/key`) URLs. Use path-style for bucket names that contain dots, which don't match S3's TLS certificate. The payload is always hashed in full: unsigned and streaming (chunked) payloads aren't supported. Bodies travel as JSON or UTF-8 text and non-JSON responses come back as text, so binary objects can't be uploaded or downloaded intact. Presigned URLs aren't generated.
- **Not allowlisted:** China regions (`amazonaws.com.cn`), dual-stack `*.api.aws` endpoints, and `*.on.aws` (Lambda function URLs). Use a custom connector for those.
- **Customer-owned hosts.** `*.amazonaws.com` isn't only AWS's own APIs: EC2 public DNS names, load balancers, API Gateway, and S3 website endpoints are hosts anyone can stand up. Drawlatch never puts the secret key into a request, but any host the agent calls still sees the access key ID, the session token if you use one, and a signature scoped to that day, region, and service. Prefer short-lived credentials, and narrow `allowedEndpoints` (below) to AWS's service endpoints if you don't need the rest.
- **Credentials and least privilege.** Use an access key for a dedicated IAM user, or temporary credentials with `AWS_SESSION_TOKEN`, which expire and must be rotated by you. Never use root keys. The agent can call any AWS API the keys allow, in any region, so grant only the actions and resources it needs. To limit regions, add an `aws:RequestedRegion` condition. To narrow the reachable hosts as well, override the template with a custom connector `aws` whose `allowedEndpoints` lists only the endpoints you use.
- **Built-in test.** It calls STS `GetCallerIdentity`. That call needs no IAM permissions, so a pass shows the keys are valid, not that they're authorized for anything.

**Bluesky.** Get an access token by POSTing `{ "identifier": "your.handle", "password": "<app password>" }` to `https://bsky.social/xrpc/com.atproto.server.createSession`. Use an [App Password](https://bsky.app/settings/app-passwords). Tokens expire after about 2 hours; rotate them yourself with `refreshJwt`. Both `bsky.social` and `public.api.bsky.app` are allowlisted. The listener polls notifications; the firehose is not supported. Rate limit: 3,000 requests per 5 minutes.

**CircleCI.** Use a [personal API token](https://app.circleci.com/settings/user/tokens). The built-in test calls `/api/v2/me`, which identifies a user, so it won't pass with a project token. Both `circleci.com/api/v2` and the legacy `v1.1` API are allowlisted. CircleCI server (self-hosted) needs a custom connector with your host.

**Datadog.** Most management endpoints need both keys; intake endpoints need only `DD-API-KEY`. US1 (`api.datadoghq.com`) plus `us3`, `us5`, `eu`, and `ap1` are allowlisted, so use your site's base URL. The built-in test checks US1 only. For other sites, call `https://<site>/api/v1/validate`.

**Discord.** `discord-bot` sends `Authorization: Bot <token>` and has broad API access. `discord-oauth` sends a user's OAuth2 Bearer token, limited to its scopes. Both use the v10 API. For the gateway listener's privileged intents, see [INGESTORS.md](INGESTORS.md#discord).

**GitHub.** The webhook listener needs `GITHUB_WEBHOOK_SECRET`. To have drawlatch register the webhook for you, also set `GITHUB_WEBHOOK_URL` and a `repoFilter` or `orgFilter` listener param. See [INGESTORS.md](INGESTORS.md#webhooks). The REST API works without either.

Some GitHub endpoints answer with a 302 to another host: release-asset downloads with `Accept: application/octet-stream` (to a `*.githubusercontent.com` host), `tarball` and `zipball` (to `codeload.github.com`), and Actions log and artifact downloads (to a storage host). Those hosts aren't allowlisted, so drawlatch [doesn't follow](README.md#redirects) the redirect: you get the 302, and its `Location` is a short-lived, pre-signed URL you can download without credentials. Don't add those hosts to `allowedEndpoints` to make the redirect work: every request to an allowlisted URL gets the connection's `Authorization: Bearer ${GITHUB_TOKEN}` header, and those hosts would then receive the token on direct requests.

**Google / Google AI.** `google` is Gmail, Calendar, Drive, Sheets, Docs, and Slides through one credential, with the services and levels set per caller: see [Google](#google). Other Google APIs need a custom connector: see [Other Google APIs](#other-google-apis). The static-token `google` template that read `GOOGLE_API_TOKEN` and the per-scope `google-*` templates were removed; a caller that still lists one of them has that connection dropped, with a message saying what replaces it. `google-ai` is Gemini (`generativelanguage.googleapis.com`, both `v1` and `v1beta`).

**Lichess.** Allowlists `explorer.lichess.ovh` (opening explorer) and `lichess.org/api`. The token is sent on every request. Lichess rejects an invalid token even on public endpoints, so set a [personal access token](https://lichess.org/account/oauth/token).

**Linear.** GraphQL only: `POST https://api.linear.app/graphql`. The key is sent without a `Bearer` prefix, as personal API keys require. For OAuth tokens, use a custom connector with `Bearer`.

**Mastodon.** The template and its listener target `mastodon.social`. For another instance, define a custom connector with your instance's host. Get a token under Preferences → Development. Rate limit: 300 requests per 5 minutes by default.

**Notion.** `Notion-Version` is pinned to `2022-06-28`. Override with a custom connector to use a newer version.

**Reddit.** Set `REDDIT_USER_AGENT` to something like `platform:myapp:v1.0 (by /u/you)`. Register a "script" app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps), then get a token from `https://www.reddit.com/api/v1/access_token` using HTTP Basic auth and `grant_type=client_credentials` (or `password`). Tokens last 1 hour; rotate them yourself. The listener polls `/r/<subreddit>/new`. It takes the subreddit from the `subreddit` listener param or `REDDIT_SUBREDDIT`, and fails without one. Disable it with `ingestorOverrides` if you don't need it. Rate limit: 100 requests per minute.

**Slack.** `SLACK_BOT_TOKEN` (`xoxb-…`) is used for API calls. The Socket Mode listener also needs `SLACK_APP_TOKEN` (`xapp-…`, an app-level token with `connections:write`) and Socket Mode enabled in the [app settings](https://api.slack.com/apps). The app token is withheld from requests (`withheldSecrets`), since only the listener uses it.

**Stripe.** For the webhook listener, set `STRIPE_WEBHOOK_SECRET` (`whsec_…`) and point a Stripe webhook at `https://<host>/webhooks/stripe`.

**Telegram.** The token goes in the URL path: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`. The placeholder resolves server-side. Create a bot with [@BotFather](https://t.me/BotFather). The listener uses `getUpdates`, which Telegram disables while a webhook is set.

**Trello.** Auth goes in the query string: `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`. The placeholders resolve server-side. The webhook listener also needs `TRELLO_API_SECRET` (withheld from requests, since it only verifies webhook signatures), `TRELLO_CALLBACK_URL`, and a `boardId` param. See [INGESTORS.md](INGESTORS.md#webhooks).

**Twitch.** Every request carries `Authorization: Bearer` and `Client-Id`. Register an app in the [developer console](https://dev.twitch.tv/console/apps). The listener polls followed streams, which needs a *user* access token and `TWITCH_USER_ID` (from `GET /helix/users`). Rate limit: 800 requests per minute.

**Vercel.** Create a token on the [Tokens page](https://vercel.com/account/tokens), where you also pick its scope. Requests act on your personal account by default. For a team's resources, add `teamId=<team id>` (or `slug=<team slug>`) to the query string, for example `https://api.vercel.com/v9/projects?teamId=team_abc123`. The built-in test calls `/v2/user`.

**X.** Uses an app-only Bearer token from the [developer portal](https://developer.x.com/en/portal/dashboard). `api.x.com` and `api.twitter.com` are allowlisted. Use `api.x.com`: if `api.twitter.com` redirects there, it's a [cross-origin redirect](README.md#redirects), and the `Authorization` header doesn't follow it, so the request fails with 401. The listener searches recent tweets for `X_SEARCH_QUERY`, which is not URL-encoded, so encode it yourself. It fails without one. API access and limits depend on your X tier.

### Google

The `google` connection gives an agent Gmail, Calendar, Drive, Sheets, Docs, and Slides through one credential. The operator picks, per caller, how it authenticates and one level for each service it may use. Drawlatch then mints short-lived access tokens for exactly the scopes of those levels, through [OAuth2 token minting](README.md#oauth2-token-minting). The agent never sees the client secret, the refresh token, the service-account key, or the access token. It can't choose its services or ask for more scope: the selection is admin config that no tool reads or writes. Each level's allowlist covers only that service's REST paths. None allows `oauth2.googleapis.com`, `tokeninfo`, `userinfo`, or a `/batch` endpoint (a batch request carries sub-requests that path rules can't see).

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
    }
  }
}
```

`google` with no `google` block, or with an invalid one, is dropped for that caller, with the reason in the boot log, on the dashboard card, and in `drawlatch doctor` and `drawlatch config`. Its other connections keep working, event listeners included. A `google` block is kept while the connection is disabled. `oauth2Overrides` doesn't apply to `google`: an `oauth2Overrides.google` entry drops it. The levels come from a catalog that ships with drawlatch (`src/connections/google-catalog.json`).

#### Services and levels

The levels of one service are alternatives, not a ladder: `drive: "file"` and `drive: "read"` reach different things. Pick one per service, or leave the service out.

| Service | Level | Scope (`https://www.googleapis.com/auth/…`) | Reaches | `test_connection` | Service account |
| --- | --- | --- | --- | --- | --- |
| `gmail` | `metadata` | `gmail.metadata` | `users/me`: `profile`, `labels`, `messages`, `threads`, `history` | `GET users/me/profile` | no |
| `gmail` | `read` | `gmail.readonly` | The above, plus `messages/*/attachments/*` and `drafts` | `GET users/me/profile` | yes, with `subject` |
| `calendar` | `freebusy` | `calendar.freebusy` | `POST /freeBusy` only | `POST /freeBusy` for `primary` over a fixed hour | no |
| `calendar` | `read` | `calendar.readonly` | `users/me/calendarList`, `users/me/settings`, `calendars/{id}`, `calendars/{id}/events`, `events/{id}`, `events/{id}/instances`, `freeBusy`, `colors` | `GET users/me/calendarList?maxResults=1` | yes |
| `drive` | `file` | `drive.file` | `files`, `files/{id}`, `files/{id}/export`, `files/{id}/copy`, `upload/drive/v3/files`, `about` (not `permissions`) | `GET about?fields=user` | no |
| `drive` | `read` | `drive.readonly` | `files`, `files/{id}`, `files/{id}/export`, `files/{id}/revisions`, `about`, `drives`, `changes`, `changes/startPageToken` | `GET about?fields=user` | yes |
| `sheets` | `read` | `spreadsheets.readonly` | `sheets.googleapis.com/v4/spreadsheets/**` (not the bare path, so not `create`) | `GET` Google's public sample spreadsheet, `fields=spreadsheetId` | yes |
| `sheets` | `edit` | `spreadsheets` (read and edit) | On `sheets.googleapis.com/v4/spreadsheets`: create (`POST` the bare path), `{id}` and `{id}:batchUpdate` / `:getByDataFilter`, `{id}/values/{range}` (and `:append`, `:clear`), `{id}/values:batchGet` / `:batchUpdate` / `:batchClear` and their `…ByDataFilter` forms, `{id}/sheets/{sheetId}:copyTo`, `{id}/developerMetadata/{metadataId}`, `{id}/developerMetadata:search`. Nothing on Drive | Same as `sheets: read` |
| `docs` | `edit` | `documents` (read and edit) | On `docs.googleapis.com/v1/documents`: create (`POST` the bare path), `{id}` (get), `{id}:batchUpdate`. Nothing on Drive | `GET` the public sample document from Google's Docs quickstart, `fields=documentId` | yes |
| `slides` | `edit` | `presentations` (read and edit) | On `slides.googleapis.com/v1/presentations`: create (`POST` the bare path), `{id}` (get), `{id}:batchUpdate`, `{id}/pages/{pageId}`, `{id}/pages/{pageId}/thumbnail` (returns an image URL drawlatch doesn't fetch; see [Service notes](#service-notes)). Nothing on Drive | `GET` the public sample presentation from Google's Slides quickstart, `fields=presentationId` | yes |

The full `drive` scope isn't offered, at any level name: Sheets, Docs, and Slides write methods all accept it, so it would make `sheets: read` writable and reach every file. Neither are Gmail send, Calendar write, Tasks, People, or other Google APIs; see [Other Google APIs](#other-google-apis).

The composed connection's allowlist is the selected levels' allowlists side by side: no two services' patterns overlap (a test checks this), so one service's exclusions never touch another. `list_routes` shows the selection in the connection's description, and its scopes.

`test_connection` on `google` mints one token and runs each selected service's test, reporting `services: { <service>: { level, success, status, … } }`. `success` is true only when every service passes. It also returns `consentScopes`, the space-separated scopes the token must be consented for, and, when the token's scopes don't match, a `hint` that names the services and levels involved (`drive.readonly (drive: read)`) and says what to do: re-consent with exactly `consentScopes` (user OAuth), or make the domain-wide delegation include them (service account). A service whose scope the token wasn't granted is marked `notConsented`.

#### Auth modes

- **`"auth": "user"`** (user OAuth): one consent from a Google account, stored as a refresh token. Every level is available. See [User OAuth setup](#user-oauth-setup).
- **`"auth": "service-account"`**: a service-account key; drawlatch signs a JWT with the selection's scopes. Only the levels in the table's last column are offered (they're the ones that had service-account templates before). Optionally `"subject": "alice@example.com"`, a Workspace user to act as through domain-wide delegation, for every selected service. `gmail: "read"` requires a `subject`. See [Service-account setup](#service-account-setup).

A caller uses one mode for all its Google services, one subject, and one Google account. To mix them (Gmail through user OAuth next to Sheets through a service account, two subjects, two accounts), add a [custom connector](#other-google-apis) for the other one.

**What a service account reaches.** Without a `subject`, it reaches what is shared with its `client_email`, plus:

- Drive files, spreadsheets, documents, and presentations shared *anyone with the link*, given the ID (some older link-shared Drive files also need their resource key);
- calendars shared with the public, given the calendar ID (Calendar has no link sharing).

It owns nothing itself: ["Service accounts don't have storage quota and can't own files"](https://developers.google.com/workspace/drive/api/guides/about-shareddrives). So `spreadsheets.create`, `documents.create`, and `presentations.create` through a service account without a `subject` fail (reported as `403 storageQuotaExceeded`; this hasn't been run against Google for Docs or Slides). Creating a file needs user OAuth or a `subject`, who then owns it.

With a `subject` it acts as that user instead and reaches what that user can. Nothing in Gmail can be shared with a service account, so Gmail always needs delegation. For editing a few shared sheets, documents, or decks, a service account without a subject is the narrowest option: share just those files with its `client_email` as **Editor**. Beyond those, it can open only link-shared files of that kind (editing them only if the link grants edit), and it can't create one. User OAuth reaches every file of that kind the Google account can open (see [Service notes](#service-notes)).

**Secrets.** User mode reads `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN`; service-account mode reads `GOOGLE_SERVICE_ACCOUNT_KEY`. As with every secret, caller `household` reads them from `HOUSEHOLD_GOOGLE_OAUTH_REFRESH_TOKEN` and so on. Only the selected mode's secrets count as required (boot table, dashboard, `drawlatch doctor`); the other mode's are never resolved. They're signer-only: the agent can't reference them as `${NAME}`. The agent can't configure any of this: on the agent path, `set_connection_enabled` refuses to enable `google`, and `set_secrets` refuses to set or delete any of the four names, in either mode and whatever `selfManage` says. Only the dashboard, the admin API, or `remote.config.json` can. Set [`selfManage: false`](README.md#callers) on these callers too, so the agent can't enable other connections either.

#### User OAuth setup

1. **Create the client.** In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project and enable the APIs you'll use: Gmail API, Google Calendar API, Google Drive API, Google Sheets API, Google Docs API, Google Slides API.
   - Under **Google Auth Platform**, set up the consent screen. Choose **Internal** if every user is in your Workspace domain, otherwise **External**.
   - Under **Clients**, create an OAuth client of type **Desktop app** and note its client ID and secret.
2. **Publish the app.** Under **Audience**, move an External app from *Testing* to **In production**. In Testing, refresh tokens for these scopes expire after 7 days.
   - An unverified External app that requests sensitive or restricted scopes (`spreadsheets`, `spreadsheets.readonly`, `documents`, and `presentations` are sensitive; `gmail.*` and `drive.readonly` restricted) shows a "Google hasn't verified this app" warning and is limited to 100 users. That's fine for your own account: choose **Advanced → Go to … (unsafe)**.
   - An Internal app needs neither verification nor publishing.
3. **Consent for exactly the selection's scopes.** Set `SCOPES` to the caller's consent scopes: one scope per selected level (the table above lists them), and nothing else. `test_connection` on `google` returns them as `consentScopes`. The example is the `household` selection above (`sheets: edit`, `docs: edit`, `slides: edit`, `drive: read`). In a shell (bash), set the client ID, the scopes, and a [PKCE](https://www.rfc-editor.org/rfc/rfc7636) verifier and challenge. `read -rs` keeps the client secret out of your shell history:

   ```bash
   CLIENT_ID=1234-abc.apps.googleusercontent.com
   read -rs -p 'Client secret: ' CLIENT_SECRET; echo
   SCOPES="https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/spreadsheets"
   CODE_VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
   CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')
   STATE=$(openssl rand -hex 16)
   echo "https://accounts.google.com/o/oauth2/v2/auth?client_id=$CLIENT_ID&redirect_uri=http://127.0.0.1:8085&response_type=code&access_type=offline&prompt=consent&state=$STATE&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&scope=${SCOPES// /%20}"
   ```

   `drive: read` is there to let the agent find files by name: the Sheets, Docs, and Slides APIs have no list or search call, so every request needs the file's ID.

   Open the printed URL in a browser. `access_type=offline` asks for a refresh token. `prompt=consent` makes Google issue a new one even if you consented before. On the consent screen, tick every scope: Google lets users decline individual ones. Nothing listens on `127.0.0.1:8085`, so the browser then shows a connection error. Copy the whole URL from its address bar and exchange the code, with the verifier, within a few minutes. The snippet checks that `state` came back unchanged, and passes the code as it appears in the URL (already URL-encoded). The client secret goes to `curl` on stdin rather than in its arguments, where other users could see it in the process list. (Use `printf '%s'`: a `<<<` here-string adds a newline that would become part of the secret.) The response contains the refresh token, so it goes to a private file rather than the terminal:

   ```bash
   read -r -p 'Redirected URL: ' REDIRECT
   CODE=$(sed -n 's/.*[?&]code=\([^&#]*\).*/\1/p' <<<"$REDIRECT")
   [ "$(sed -n 's/.*[?&]state=\([^&#]*\).*/\1/p' <<<"$REDIRECT")" = "$STATE" ] || echo 'state mismatch: start over'
   (umask 077; printf '%s' "$CLIENT_SECRET" | curl -s https://oauth2.googleapis.com/token \
     -d client_id="$CLIENT_ID" --data-urlencode client_secret@- \
     -d code="$CODE" -d code_verifier="$CODE_VERIFIER" \
     -d grant_type=authorization_code -d redirect_uri=http://127.0.0.1:8085 \
     -o token.json)
   jq -r '.scope // .error' token.json   # the granted scopes (not secret), or the error
   ```

   The response's `refresh_token` (`1//…`) is the secret. Append the three secrets for the caller to drawlatch's `.env` (here `~/.drawlatch/.env`; use your config directory) without printing them, with a umask that keeps a newly created `.env` private. Then delete the response and restart the daemon. Or paste the secrets into the dashboard instead:

   ```bash
   (umask 077; {
     printf 'HOUSEHOLD_GOOGLE_OAUTH_CLIENT_ID=%s\n' "$CLIENT_ID"
     printf 'HOUSEHOLD_GOOGLE_OAUTH_CLIENT_SECRET=%s\n' "$CLIENT_SECRET"
     printf 'HOUSEHOLD_GOOGLE_OAUTH_REFRESH_TOKEN=%s\n' "$(jq -r .refresh_token token.json)"
   } >> ~/.drawlatch/.env)
   rm token.json; unset CLIENT_SECRET CODE CODE_VERIFIER STATE REDIRECT
   drawlatch restart
   ```

   If a refresh token did end up on screen (a `curl` without `-o`, say), clear the terminal's scrollback.

   Then run `test_connection` on `google`. Every service should pass, with `oauth2.grantedScopes` equal to `oauth2.requestedScopes`.

If the response lists scopes beyond the consented set (for example, ones carried over by `include_granted_scopes` from an earlier grant), the token is refused: drawlatch refuses any token whose reported `scope` includes something it didn't request, and any token that doesn't report a `scope`. Mint a token for this client without them.

**Ways a refresh token dies** (each then fails as `invalid_grant`; mint a new one):

- The app is External and in *Testing*: 7 days.
- Six months unused. Any token refresh counts as use.
- You change your password, if the token includes Gmail scopes.
- You revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), or a Workspace admin's policy does.
- The limit of 100 refresh tokens per Google account per OAuth client: minting a 101st silently revokes the oldest.

One token serves every selected service, so a dead token, or any other terminal error (`invalid_grant`, `invalid_scope`, a refused scope), stops all of a caller's Google services until it is fixed. A terminal error is retried after 60 s, or as soon as the caller's secret or selection changes. `test_connection` reports each service, so you can still see which one caused it.

#### Changing the selection

Every token request asks for exactly the selection's scopes, and the token is refused if Google grants anything else. So after changing a caller's `google` block:

- **Adding a service** needs a refresh token consented for the new scopes too: redo step 3 with the new `consentScopes`. Until then Google either refuses the request (`invalid_scope`, which stops every service) or grants the old scopes only, in which case `test_connection` marks the new service `notConsented` and Google answers its requests with `403`.
- **Removing a service** works with the old token only if Google narrows a token to the requested scopes on refresh, which Google doesn't document and drawlatch hasn't confirmed. If Google returns the whole grant, every request fails closed with *"the token endpoint granted scopes broader than this connection allows (…)"*, and `test_connection`'s `hint` names the levels those scopes belong to. Plan to re-consent with exactly the new `consentScopes` instead. (The live e2e suite has an informational check of this, `google-scope-probe`.)
- **Changing a level** (`sheets: "read"` to `"edit"`) is both: one scope added, one removed.

Changing the selection never reuses a token minted for the old one: the token cache is keyed by the requested scopes and the subject.

#### Service-account setup

1. **Create the service account and a key.** In the Cloud console, open **IAM & Admin → Service Accounts**, create an account, and choose **Keys → Add key → JSON**. Your organization's policy may forbid key creation (`iam.disableServiceAccountKeyCreation`). Enable the APIs you'll use in that project.
2. **Store the key as base64.** This has no quotes or newlines to break `.env`. Write it straight into drawlatch's `.env` (here `~/.drawlatch/.env`; use your config directory) rather than printing it, then delete the key file and restart the daemon:

   ```bash
   (umask 077; printf 'MAIL_AGENT_GOOGLE_SERVICE_ACCOUNT_KEY=%s\n' "$(base64 -w0 key.json)" >> ~/.drawlatch/.env)
   # macOS: "$(base64 -i key.json)" (no line wrapping by default)
   rm key.json
   drawlatch restart
   ```

   You can also paste the key file's JSON, or its base64, into the dashboard field.
3. **Without delegation**, the account reaches what is shared with its `client_email` (calendars, files, spreadsheets, documents, and presentations), plus link-shared files, spreadsheets, documents, and presentations, and public calendars, whose ID it is given (see [Auth modes](#auth-modes)). With `sheets: "edit"`, `docs: "edit"`, or `slides: "edit"` it can edit the files shared with it as **Editor** and link-shared ones whose link grants edit, but can't create one. A **Viewer** share is read-only. A **Commenter** share doesn't let it change content. But the Docs, Slides, and Sheets `batchUpdate` requests all include comment requests (see **What `batchUpdate` can change** below), so the account may still be able to comment on such a file. This hasn't been tested against Google. `test_connection` with `calendar: "read"` lists the account's own (often empty) calendar list. Gmail isn't available without delegation.
4. **With domain-wide delegation** (Workspace only), the account acts as a domain user for every selected service. In the [Admin console](https://admin.google.com/), open **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**. Enter the service account's numeric client ID (`client_id` in the key file), and under OAuth scopes enter the selection's consent scopes, comma-separated. The list must include every one of them; a longer list works too, since the account still asks only for the selection, but listing exactly these keeps the delegation least-privileged. For the example below, `https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/gmail.readonly`. Then name the user in the caller's `google` block:

   ```json
   {
     "callers": {
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

   `subject` is admin-only config, like the rest of the block: no tool writes it, and the dashboard shows it but has no control that edits it yet. `list_routes` tells the agent only that the connection is `delegated`, not who the user is, and `test_connection` never reports it. A selection with `gmail: "read"` and no subject is invalid, so `google` is dropped for that caller with a boot-log message. With a subject, `users/me` in the Gmail URLs means that user.

Errors carry service-account hints:

- `unauthorized_client`: delegation isn't set up for this client ID.
- `access_denied`: the selection's scopes aren't in the client ID's delegated scope list.
- `invalid_grant`: the key was deleted, the subject isn't a user in the domain, or the daemon's clock is off.

The 100-token limit doesn't apply to service accounts.

#### Service notes

- **Scopes bound reach, not intent.** A read-only level can still read everything in its scope, including mail an attacker sent to the account. `drive: "file"` can create, upload, overwrite, and delete the files it covers. Its allowlist leaves out the `permissions` endpoints, so the agent can't share a file (publicly or with anyone), but it can still put data into files it creates. Prefer read-only levels.
- **One token carries every selected scope.** Each request still goes only to an allowlisted URL, and the agent never sees the token, but a token leaked from the daemon carries the whole selection, and Google accepts some scopes across APIs (see [Cross-service scopes](#cross-service-scopes)).
- **`sheets: "edit"` covers every spreadsheet the account can open.** It can read every spreadsheet the Google account can see and edit every one it can edit, including ones other people shared with it, not just the household sheets you had in mind. There is no per-file Sheets scope: the only per-file Google scope is `drive.file` (the Drive API's, for files the OAuth client created or the user picked). To limit editing to chosen spreadsheets, use a service account and share only those with it. A write scope is also a way out for data: the agent can write what it has read into any spreadsheet the account can edit, such as one an attacker shared with it, and formulas it writes (`IMPORTDATA`, `IMAGE`, …) may make Google fetch URLs it picks. `batchUpdate` can delete tabs, rows, and ranges; deleting, sharing, or moving the file itself needs the Drive API, which no Sheets level reaches. A spreadsheet's version history (File → Version history) undoes edits.
- **`sheets: "read"` next to `drive: "file"` can edit some spreadsheets.** The Sheets API's write methods accept the `drive.file` scope, so with both selected the agent can edit (not create: the bare `POST …/v4/spreadsheets` isn't in the read allowlist) the spreadsheets `drive.file` covers: the ones this OAuth client created, or that the user picked with it. `drive: "file"` can already overwrite or delete those files through Drive, so the set of files the agent can change doesn't grow. The daemon notes this at boot. It can't happen with a service account (`drive: "file"` is user-only).
- **`docs: "edit"` and `slides: "edit"` cover every document and deck the account can open.** As with Sheets, they can read every Google Doc or Slides deck the account can see and edit every one it can edit, including ones other people shared with it. There is no per-file Docs or Slides scope either (only `drive.file`, as above). To limit editing to chosen files, use a service account and share only those files with it.
  - **A write scope is a way out for data.** The agent can write what it has read into any document or deck the account can edit, such as one an attacker shared with it. Some `batchUpdate` requests make Google fetch a URL the agent picks: Docs `insertInlineImage` and `replaceImage`, and Slides `createImage`, `replaceImage`, and `replaceAllShapesWithImage`. Google fetches the image once, at insertion time, from a public URL, so the URL itself, query string included, can carry data to a server the agent chooses.
  - **What `batchUpdate` can change.** It can delete text, tables, tabs, slides, and page elements, and accept or reject suggestions. It can also add comments and replies (`insertComment`, `addCommentReply`) and edit its own posts (`updateCommentPost`). `deleteComment` deletes a whole comment thread and only checks that the account wrote the thread's first post, so it also removes other people's replies to a thread the account started. `deleteCommentReply` deletes one of the account's own replies, unless the reply contains an action or an assignee. Discovery says Google refuses these requests with `400` otherwise. In Docs, `updateCommentPost` also can't edit the first post of a suggestion thread. Docs and Slides have the same five comment requests, and so does the Sheets v4 `batchUpdate` (all revision `20261118`). Deleting, sharing, moving, copying, or exporting the file itself needs the Drive API, which no Docs or Slides level reaches. Version history undoes edits.
  - **Linked Sheets charts and Drive videos use the other services' scopes.** Discovery lists `spreadsheets`, `spreadsheets.readonly`, and `drive.readonly` among the scopes Slides `batchUpdate` accepts. So with `slides: "edit"` and a Sheets level selected, `createSheetsChart` (and refreshing or replacing shapes with such a chart) can work, and with a Drive level, `createVideo` from Drive. Without them these requests get `403`. They read data the caller may already read. This hasn't been run against Google.
- **Methods aren't restricted by the allowlist.** Read-only is enforced by Google through the scope, so a `POST` to an allowlisted path that needs a broader scope gets `403`. A `403` from drawlatch carries a hint naming the token's scopes.
- **No push channels.** Read scopes would let an agent register a push channel (`events/watch`, `calendarList/watch`, `settings/watch`, `files/{id}/watch`, `changes/watch`, Gmail `watch`) that sends change notifications to a target it names. No level allows the `watch`, `stop`, or `channels/stop` endpoints. Calendar event IDs and the literal `watch` are both one path segment, so the Calendar levels refuse `watch` with [exclusion entries](README.md#custom-connectors) (`!…/events/watch`). Exclusions are also checked with unreserved percent-escapes decoded, so `w%61tch` is refused too, and a fragment is dropped before matching, so `watch#x` is too.
- **Path boundaries.** `**` appears only after `?` or `/`, so a pattern for `files` can't match `filesX`.
- **`gmail: "metadata"`:**
  - `messages.list` and `threads.list` refuse `q=` (no search).
  - `format=full` and `format=raw` are refused. Use `format=metadata` (with `metadataHeaders`) or `minimal`.
  - No attachments or drafts.
- **`drive: "file"`** sees only files this OAuth client created, or that the user opened with it through the Google Picker. With a refresh token minted as above, that means only the files the agent created. It uploads through `https://www.googleapis.com/upload/drive/v3/files`.
- **Calendar.** `calendars/*/acl` isn't allowlisted: listing ACLs needs more than `calendar.readonly`. The `freebusy` level's test queries a fixed past hour and returns busy times only.
- **Sheets** has no read call that doesn't take a spreadsheet ID. `test_connection` reads `spreadsheetId` from Google's public sample spreadsheet (`1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms`), which also catches a project where the Sheets API isn't enabled. This hasn't been run against Google yet: if the sample sheet ever disappears, the test fails with `404` while real reads still work. Read with `GET …/v4/spreadsheets/{id}` or `…/values/{range}`. Both Sheets levels use the same test.
- **Sheets method suffixes.** Google writes custom methods as a `:` suffix on a path segment (`{id}:batchUpdate`, `values/{range}:append`, `sheets/{sheetId}:copyTo`). In an allowlist pattern `*` matches anything within one segment, `:` included, so `…/spreadsheets/*` covers `{id}`, `{id}:batchUpdate`, and `{id}:getByDataFilter` alike. Ranges work as written (`Sheet1!A1:B2`, `'My Sheet'!A:A`) or percent-encoded (`Sheet1%21A1%3AB2`). A `values:…` or `developerMetadata:search` suffix must use a literal `:` when it is its own segment: `{id}/values%3AbatchUpdate` matches no pattern and is refused. A `%2F` doesn't split a segment for matching, though, so `…/spreadsheets/*` also accepts `{id}%2Fvalues%3AbatchUpdate` as one segment. Whatever Google makes of such a path, the request still goes to `sheets.googleapis.com` under `/v4/spreadsheets` with the same token and scopes, and a `.` or `..` segment in any encoding (`%2e`, or `%2f` / `%5c` / `\` as the separator) is refused before matching.
- **Docs and Slides methods.** The allowlists cover every method in the [Docs v1](https://docs.googleapis.com/$discovery/rest?version=v1) and [Slides v1](https://slides.googleapis.com/$discovery/rest?version=v1) Discovery documents (revision `20261118`): `documents.create`, `.get`, `.batchUpdate`; `presentations.create`, `.get`, `.batchUpdate`, `pages.get`, `pages.getThumbnail`. As for Sheets, `…/documents/*` and `…/presentations/*` cover `{id}` and `{id}:batchUpdate` alike, and a `%2F` or `%3A` stays inside one segment: `{id}%2Fx` matches and still goes to the same host under `/v1/documents` or `/v1/presentations`, and dot segments are refused in any encoding. Query parameters (`includeTabsContent`, `suggestionsViewMode`, `commentsViewMode`, `thumbnailProperties.*`, `fields`) don't affect matching. Without `includeTabsContent=true` (or a `fields` mask naming `tabs`), `documents.get` returns only the first tab's content. Discovery writes the `presentations.get` path as `{+presentationId}`, which may contain `/`, but the allowlist matches a one-segment ID only. Slides IDs don't contain `/`.
- **Docs and Slides tests.** `test_connection` reads `documentId` from the public sample document in Google's Docs quickstart (`195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE`), or `presentationId` from the Slides quickstart's sample presentation (`1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc`). That also catches a project where the API isn't enabled. As with Sheets, this hasn't been run against Google yet: if a sample file disappears, the test fails with `404` while real requests still work.
- **Slides thumbnails aren't fetched.** `pages.getThumbnail` returns JSON with a `contentUrl` for the image. That URL is on a Google image host, not on `slides.googleapis.com`, so no level allowlists it, and a `secure_request` to it is refused unless another of the caller's connections allows that host. The catalog doesn't add the image host, because a host like `*.googleusercontent.com` serves content for many Google products, not just Slides thumbnails. The agent still receives the URL. Google's reference says it lasts 30 minutes by default, "is tagged with the account of the requester", and "anyone with the URL effectively accesses the image as the original requester". So anyone the agent passes it to (a chat, a log, a web page) can view that slide for as long as the URL lasts, with no Google credential. Treat the URL like the slide itself. Each call counts as an expensive read in Google's quota.

#### Cross-service scopes

One token carries every selected scope, and some Google APIs accept other APIs' scopes. From the Discovery documents (fetched 2026-11-24; Sheets v4, Docs v1 and Slides v1 revision `20261118`, Drive v3 `20261117`, Calendar v3 `20261118`, Gmail v1 `20261116`), limited to the scopes the catalog offers:

| API | Read methods accept | Write methods accept |
| --- | --- | --- |
| Sheets | `spreadsheets.readonly`, `spreadsheets`, `drive.readonly`, `drive.file` | `spreadsheets`, `drive.file` |
| Docs | `documents`, `drive.readonly`, `drive.file` | `documents`, `drive.file` |
| Slides | `presentations`, `drive.readonly`, `drive.file` | `create`: `presentations`, `drive.file`. `batchUpdate`: also `drive.readonly`, `spreadsheets`, `spreadsheets.readonly` |
| Drive, Calendar, Gmail | only their own scopes | only their own scopes |

So of every selection the catalog allows, only `sheets: "read"` with `drive: "file"` makes a read-only level writable (see [Service notes](#service-notes)), and Slides `batchUpdate` can link Sheets charts and Drive videos when those services are selected. Gmail's `users.watch` and `users.stop` accept the Gmail scopes, but no level allowlists them. A test sweeps every valid selection against this table and fails if a new widening appears that isn't documented, so adding a level means redoing this audit.

#### Other Google APIs

Tasks, People, YouTube, Gmail send, Calendar write, the full `drive` scope, and the rest of Google aren't in the catalog. Use a [custom connector](README.md#custom-connectors) with its own `oauth2` block. For example, Tasks, read-only:

```json
{
  "connectors": [
    {
      "alias": "google-tasks",
      "name": "Google Tasks (read-only)",
      "secrets": {
        "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
        "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}",
        "GOOGLE_TASKS_REFRESH_TOKEN": "${GOOGLE_TASKS_REFRESH_TOKEN}"
      },
      "oauth2": {
        "tokenUrl": "https://oauth2.googleapis.com/token",
        "grant": "refresh_token",
        "clientAuth": "body",
        "secretRefs": {
          "clientId": "GOOGLE_OAUTH_CLIENT_ID",
          "clientSecret": "GOOGLE_OAUTH_CLIENT_SECRET",
          "refreshToken": "GOOGLE_TASKS_REFRESH_TOKEN"
        },
        "scopes": ["https://www.googleapis.com/auth/tasks.readonly"]
      },
      "allowedEndpoints": [
        "https://tasks.googleapis.com/tasks/v1/users/@me/lists",
        "https://tasks.googleapis.com/tasks/v1/users/@me/lists?**",
        "https://tasks.googleapis.com/tasks/v1/users/@me/lists/*",
        "https://tasks.googleapis.com/tasks/v1/lists/*/tasks",
        "https://tasks.googleapis.com/tasks/v1/lists/*/tasks?**",
        "https://tasks.googleapis.com/tasks/v1/lists/*/tasks/*"
      ],
      "testConnection": {
        "url": "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1",
        "description": "Lists one task list"
      }
    }
  ],
  "callers": {
    "household": {
      "connections": ["google", "google-tasks"],
      "selfManage": false,
      "google": { "auth": "user", "services": { "sheets": "edit" } }
    }
  }
}
```

It must use **its own refresh token** (`HOUSEHOLD_GOOGLE_TASKS_REFRESH_TOKEN`, consented for `tasks.readonly` only, with step 3 above). The `google` token is consented for exactly the selection, and adding `tasks.readonly` to that consent would make `google`'s tokens fail as broader than the connection allows. It may share the OAuth client. Keep its allowlist off the catalog's paths: a request both connections allow is refused as ambiguous, and the daemon warns about the pair at boot ([README → Overlapping connections](README.md#overlapping-connections)). On the agent path, `set_secrets` refuses a custom connector's `secretRefs` and `set_connection_enabled` refuses to enable it, as for `google`.

### Web search and fetch

`exa`, `firecrawl`, `parallel`, and `perplexity` all turn a query or URL into LLM-ready text:

| Connection | Best at |
| --- | --- |
| `exa` | Neural and keyword web search, find-similar, sourced answers |
| `firecrawl` | Scraping and crawling sites into markdown, structured extraction |
| `parallel` | Objective-driven search and async research tasks |
| `perplexity` | Cited, synthesized answers over live web results |

Deep operations on these APIs often outlast the 25 s default, so their templates raise `requestTimeoutMs`: 120 s for `exa`, `firecrawl`, and `parallel`, and 180 s for `perplexity`. That is both the default and the most a call may request with `timeoutMs`. A request past its deadline is cancelled at the socket, so it stops billing. All four ceilings exceed the MCP client's default 60 s tool timeout, so raise `MCP_TOOL_TIMEOUT` to use them fully. For long jobs, prefer each API's submit-then-poll endpoints. See [README → Request timeouts](README.md#request-timeouts).

**Exa.** Main endpoints on `https://api.exa.ai`:

- `POST /search`: its `type` sets quality, latency, and cost (`instant`, `fast`, `auto`, `deep-lite`, `deep`, `deep-reasoning`).
- `POST /contents`, `POST /findSimilar`, `POST /answer`, `POST /context`.
- OpenAI-compatible: `POST /responses` and `POST /chat/completions`.
- Agent API for long research: `POST /agent/runs`, then `GET /agent/runs/{id}`.
- `/monitors` and `/websets/v0/*`, which also use GET, PATCH, and DELETE.

`/research/v1` is retired and returns `410`. `deep-reasoning` alone takes 12–40 s. Keys: [Exa dashboard](https://dashboard.exa.ai/api-keys).

**Firecrawl.** Targets the v2 API on `https://api.firecrawl.dev`:

- One-shot: `POST /v2/scrape`, `/v2/search`, `/v2/map`.
- Async jobs: `POST /v2/crawl`, `/v2/batch/scrape`, `/v2/extract` return a job ID; poll it with the matching `GET …/{id}`.
- Also available: `/v2/agent`, `/v2/parse`, and `/v2/monitor/*`.

Keys (`fc-…`) are at [firecrawl.dev](https://www.firecrawl.dev/app/api-keys).

- **Allowlist:** `https://api.firecrawl.dev/**` allows every method and path, including team settings, job deletion, and billing reads. Narrow it with a custom connector if needed.
- **Screenshots** are returned as Supabase URLs on another host, which the allowlist blocks. Fetch them outside the proxy.
- **Timeouts:** Firecrawl allows up to 300 s per request, but drawlatch caps this connection at 120 s. Use crawl or batch jobs for longer work.
- **Self-hosted** instances need a custom connector.

**Parallel.** The main endpoints:

- `POST /v1/search` takes `search_queries` (required) and an optional `objective`. `mode` defaults to `advanced`, the slowest and most expensive (~3 s, ~$5/1k), so pass `turbo` (~250 ms, ~$1/1k) unless you need the quality.
- `POST /v1/extract` (GA, not `/v1beta`) returns content for a list of URLs.
- Task API: `POST /v1/tasks/runs` returns `202 Accepted`. Then call `GET /v1/tasks/runs/{run_id}` and `…/result`.

The optional `parallel-beta` header enables specific opt-in features and is never required. The template doesn't inject it, so pass it per request when you need it. Adding it at route level would conflict with a caller-supplied one.

**Perplexity.** One key (`pplx-…`) covers several APIs on `https://api.perplexity.ai`:

- Agent API: `POST /v1/agent` (Perplexity's recommended default).
- Raw ranked results: `POST /search`.
- Sonar chat: `POST /v1/sonar`, or `POST /chat/completions`, an OpenAI-compatible alias for the same API.
- Async research: `POST /v1/async/sonar`, then `GET /v1/async/sonar/{id}`.
- Embeddings: `POST /v1/embeddings` (the `/v1` prefix is required).

The built-in test calls `GET /v1/async/sonar`, which is free. Perplexity announced that Sonar, including `/chat/completions` and the async Sonar endpoints, is supported only until **2026-09-27**. That date has passed. If those endpoints are gone, the built-in test fails and needs to move to an Agent API endpoint.
