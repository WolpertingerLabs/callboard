# Connections

A connection is a built-in template that gives an API's allowed URL patterns, the headers to inject, and the secrets it needs. Enable one by adding its name to a caller's `connections` list in `remote.config.json`, or from the dashboard:

```json
{ "callers": { "default": { "connections": ["github", "stripe"] } } }
```

Then set the secrets for that caller. Caller `default` reads `GITHUB_TOKEN` from `DEFAULT_GITHUB_TOKEN`. See [README → Secrets](README.md#secrets) for how secrets resolve, and [README → Custom connectors](README.md#custom-connectors) to add an API or override a template (a custom connector with the same alias wins). Templates live in `src/connections/<category>/<name>.json`. A caller's own [vault](README.md#vault) items can be used on any connection it has enabled, as `${vault:<name>}` in a `secure_request` (another caller's item shared with it by a grant as `${vault:<owner>/<name>}`; [README → Using vault items in requests](README.md#using-vault-items-in-requests)); templates don't change.

## Available connections

**Bold** secrets are needed for API calls. The others are used only by the event listener, if at all. `doctor`, `config`, and the dashboard flag missing secrets only for built-in templates, and only those used in headers, so they won't catch a missing Telegram or Trello token. (`aws` and the OAuth2 templates are the exceptions: their signing keys and `secretRefs` count as required.) Set `<ALIAS>_<NAME>` even where `doctor` prints the bare name. Header secrets, listener `signatureSecret`s, and Slack's `SLACK_APP_TOKEN` are [withheld](README.md#header-only-secrets): the agent can't reference them as `${NAME}` in a request, and they're scrubbed from response bodies and listener events. That includes public values sent in headers, such as Twitch's `TWITCH_CLIENT_ID` and Reddit's `REDDIT_USER_AGENT`, which appear in responses as `${NAME}`; a custom connector can opt one out with `placeholderSecrets`. Listener types are described in [INGESTORS.md](INGESTORS.md).

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
| `google` | [Google Workspace APIs](https://developers.google.com/apis-explorer) | **`GOOGLE_API_TOKEN`** | Bearer | |
| `google-ai` | [Google AI (Gemini)](https://ai.google.dev/api) | **`GOOGLE_AI_API_KEY`** | `x-goog-api-key` | |
| `google-calendar-freebusy` | [Google Calendar, free/busy](https://developers.google.com/workspace/calendar/api/v3/reference) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`calendar.freebusy`) | |
| `google-calendar-readonly` | [Google Calendar, read-only](https://developers.google.com/workspace/calendar/api/v3/reference) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`calendar.readonly`) | |
| `google-calendar-readonly-sa` | [Google Calendar, read-only](https://developers.google.com/workspace/calendar/api/v3/reference) | **`GOOGLE_SERVICE_ACCOUNT_KEY`** | service account (`calendar.readonly`) | |
| `google-drive-file` | [Google Drive, app-created files](https://developers.google.com/workspace/drive/api/reference/rest/v3) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`drive.file`) | |
| `google-drive-readonly` | [Google Drive, read-only](https://developers.google.com/workspace/drive/api/reference/rest/v3) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`drive.readonly`) | |
| `google-drive-readonly-sa` | [Google Drive, read-only](https://developers.google.com/workspace/drive/api/reference/rest/v3) | **`GOOGLE_SERVICE_ACCOUNT_KEY`** | service account (`drive.readonly`) | |
| `google-gmail-metadata` | [Gmail, metadata only](https://developers.google.com/workspace/gmail/api/reference/rest) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`gmail.metadata`) | |
| `google-gmail-readonly` | [Gmail, read-only](https://developers.google.com/workspace/gmail/api/reference/rest) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`gmail.readonly`) | |
| `google-gmail-readonly-sa` | [Gmail, read-only](https://developers.google.com/workspace/gmail/api/reference/rest) | **`GOOGLE_SERVICE_ACCOUNT_KEY`** | service account (`gmail.readonly`), needs `subject` | |
| `google-sheets` | [Google Sheets, read-write](https://developers.google.com/workspace/sheets/api/reference/rest) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`spreadsheets`) | |
| `google-sheets-readonly` | [Google Sheets, read-only](https://developers.google.com/workspace/sheets/api/reference/rest) | **`GOOGLE_OAUTH_CLIENT_ID`**, **`GOOGLE_OAUTH_CLIENT_SECRET`**, **`GOOGLE_OAUTH_REFRESH_TOKEN`** | OAuth2, minted (`spreadsheets.readonly`) | |
| `google-sheets-readonly-sa` | [Google Sheets, read-only](https://developers.google.com/workspace/sheets/api/reference/rest) | **`GOOGLE_SERVICE_ACCOUNT_KEY`** | service account (`spreadsheets.readonly`) | |
| `google-sheets-sa` | [Google Sheets, read-write](https://developers.google.com/workspace/sheets/api/reference/rest) | **`GOOGLE_SERVICE_ACCOUNT_KEY`** | service account (`spreadsheets`) | |
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

**Google / Google AI.** `google` covers Workspace and other Google APIs with a static OAuth token you supply and refresh yourself, with whatever scopes it has. Prefer the [scoped Google templates](#google-scoped), whose tokens drawlatch mints for one scope and one service. Allowlisted hosts: `www`, `sheets`, `docs`, `drive`, `calendar-json`, `gmail`, `slides`, `people`, `tasks`, `admin`, `chat`, `forms`, `youtube`, `youtubeanalytics`, and `cloudresourcemanager` `.googleapis.com`. Add others with a custom connector that uses the same secret. `google-ai` is Gemini (`generativelanguage.googleapis.com`, both `v1` and `v1beta`).

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

### Google (scoped)

The `google-*` templates give an agent one Google API at one scope. Drawlatch mints short-lived access tokens itself through [OAuth2 token minting](README.md#oauth2-token-minting). The agent never sees the client secret, the refresh token, the service-account key, or the access token, and can't ask for more scope than the template's. Each allowlist covers only that service's REST paths. None allows `oauth2.googleapis.com`, `tokeninfo`, `userinfo`, or a `/batch` endpoint (a batch request carries sub-requests that path rules can't see).

| Template | Scope (`https://www.googleapis.com/auth/…`) | Reaches | `test_connection` |
| --- | --- | --- | --- |
| `google-gmail-metadata` | `gmail.metadata` | `users/me`: `profile`, `labels`, `messages`, `threads`, `history` | `GET users/me/profile` |
| `google-gmail-readonly`, `-sa` | `gmail.readonly` | The above, plus `messages/*/attachments/*` and `drafts` | `GET users/me/profile` |
| `google-calendar-freebusy` | `calendar.freebusy` | `POST /freeBusy` only | `POST /freeBusy` for `primary` over a fixed hour |
| `google-calendar-readonly`, `-sa` | `calendar.readonly` | `users/me/calendarList`, `users/me/settings`, `calendars/{id}`, `calendars/{id}/events`, `events/{id}`, `events/{id}/instances`, `freeBusy`, `colors` | `GET users/me/calendarList?maxResults=1` |
| `google-drive-readonly`, `-sa` | `drive.readonly` | `files`, `files/{id}`, `files/{id}/export`, `files/{id}/revisions`, `about`, `drives`, `changes`, `changes/startPageToken` | `GET about?fields=user` |
| `google-drive-file` | `drive.file` | `files`, `files/{id}`, `files/{id}/export`, `files/{id}/copy`, `upload/drive/v3/files`, `about` (not `permissions`) | `GET about?fields=user` |
| `google-sheets-readonly`, `-sa` | `spreadsheets.readonly` | `sheets.googleapis.com/v4/spreadsheets/**` | `GET` Google's public sample spreadsheet, `fields=spreadsheetId` |
| `google-sheets`, `-sa` | `spreadsheets` (read and edit) | On `sheets.googleapis.com/v4/spreadsheets`: create (`POST` the bare path), `{id}` and `{id}:batchUpdate` / `:getByDataFilter`, `{id}/values/{range}` (and `:append`, `:clear`), `{id}/values:batchGet` / `:batchUpdate` / `:batchClear` and their `…ByDataFilter` forms, `{id}/sheets/{sheetId}:copyTo`, `{id}/developerMetadata/{metadataId}`, `{id}/developerMetadata:search`. Nothing on Drive | Same as `google-sheets-readonly` |

**Which flavour.** The plain templates use **user OAuth**: one consent from a Google account, stored as a refresh token. The `-sa` twins use a **service account** and have the same scope, allowlist, and test as their twin (a test checks they don't drift). Without a `subject`, a service account reaches what is shared with its `client_email`, plus:

- Drive files and spreadsheets shared *anyone with the link*, given the ID (some older link-shared Drive files also need their resource key);
- calendars shared with the public, given the calendar ID (Calendar has no link sharing);
- its own files and spreadsheets (of these templates, only `google-sheets-sa` can create one).

With [domain-wide delegation](#service-account-setup) in a Workspace domain, it acts as the `subject` user instead and reaches what that user can. Nothing in Gmail can be shared with a service account, so Gmail always needs delegation, and `google-gmail-readonly-sa` is unusable without a `subject`. For editing a few shared sheets, `google-sheets-sa` without a subject is the narrowest option: share just those spreadsheets with the service account's `client_email` as **Editor**. Beyond those, it can open only link-shared spreadsheets (editing them only if the link grants edit) and ones it creates. `google-sheets` (user OAuth) reaches every spreadsheet the Google account can open (see [Template notes](#template-notes)).

**Secrets.** All user-OAuth templates share `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN`, and all `-sa` templates share `GOOGLE_SERVICE_ACCOUNT_KEY`. As with every secret, caller `mail-agent` reads them from `MAIL_AGENT_GOOGLE_OAUTH_REFRESH_TOKEN` and so on. They're signer-only: the agent can't reference them as `${NAME}`. Because one refresh token can serve several templates, the agent may not configure any of this itself: on the agent path, `set_connection_enabled` refuses to enable an OAuth2 connection (say `google-drive-file` next to `google-gmail-readonly`, which would inherit the same refresh token) and `set_secrets` refuses to set or delete these secrets, whatever `selfManage` says. Only the dashboard, the admin API, or `remote.config.json` can. Set [`selfManage: false`](README.md#callers) on these callers too, so the agent can't enable other connections either.

**Mixing with `google`.** A caller with both the static `google` template and a scoped one, or two scoped ones for one service (`google-gmail-metadata` and `google-gmail-readonly`, `google-sheets` and `google-sheets-readonly`, or a template and its `-sa` twin), has two connections that match the same URLs. Because the scoped ones use OAuth2, a request matching both is refused with an error naming them, and the daemon logs a warning naming the pair at boot ([README → Overlapping connections](README.md#overlapping-connections)). Use one connection per Google service.

#### User OAuth setup

1. **Create the client.** In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project and enable the APIs you'll use: Gmail API, Google Calendar API, Google Drive API, Google Sheets API.
   - Under **Google Auth Platform**, set up the consent screen. Choose **Internal** if every user is in your Workspace domain, otherwise **External**.
   - Under **Clients**, create an OAuth client of type **Desktop app** and note its client ID and secret.
2. **Publish the app.** Under **Audience**, move an External app from *Testing* to **In production**. In Testing, refresh tokens for these scopes expire after 7 days.
   - An unverified External app that requests sensitive or restricted scopes (`spreadsheets` and `spreadsheets.readonly` are sensitive; `gmail.*` and `drive.readonly` restricted) shows a "Google hasn't verified this app" warning and is limited to 100 users. That's fine for your own account: choose **Advanced → Go to … (unsafe)**.
   - An Internal app needs neither verification nor publishing.
3. **Consent for the scopes you'll use.** Set `SCOPES` to the scopes of exactly the templates you'll enable (the table above lists them). The example is for `google-sheets` alone. A token granted several scopes serves several templates only if Google narrows it on refresh, which isn't verified; if Google doesn't, every template on it refuses it (see **Narrowing on refresh is not verified** below). In a shell (bash), set the client ID, the scopes, and a [PKCE](https://www.rfc-editor.org/rfc/rfc7636) verifier and challenge. `read -rs` keeps the client secret out of your shell history:

   ```bash
   CLIENT_ID=1234-abc.apps.googleusercontent.com
   read -rs -p 'Client secret: ' CLIENT_SECRET; echo
   SCOPES="https://www.googleapis.com/auth/spreadsheets"   # google-sheets; space-separate more
   CODE_VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
   CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')
   STATE=$(openssl rand -hex 16)
   echo "https://accounts.google.com/o/oauth2/v2/auth?client_id=$CLIENT_ID&redirect_uri=http://127.0.0.1:8085&response_type=code&access_type=offline&prompt=consent&state=$STATE&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&scope=${SCOPES// /%20}"
   ```

   For an agent that edits sheets, `https://www.googleapis.com/auth/spreadsheets` is enough. To let it find spreadsheets by name, also give it `google-drive-readonly` (`https://www.googleapis.com/auth/drive.readonly`): the Sheets API has no list or search call, so every request needs the spreadsheet ID. That is two templates, so either rely on narrowing or mint a second token (below). Never put `spreadsheets.readonly` next to `spreadsheets` for one caller: `google-sheets` and `google-sheets-readonly` overlap (see **Mixing with `google`** above), so a caller has only one of them.

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
     printf 'MAIL_AGENT_GOOGLE_OAUTH_CLIENT_ID=%s\n' "$CLIENT_ID"
     printf 'MAIL_AGENT_GOOGLE_OAUTH_CLIENT_SECRET=%s\n' "$CLIENT_SECRET"
     printf 'MAIL_AGENT_GOOGLE_OAUTH_REFRESH_TOKEN=%s\n' "$(jq -r .refresh_token token.json)"
   } >> ~/.drawlatch/.env)
   rm token.json; unset CLIENT_SECRET CODE CODE_VERIFIER STATE REDIRECT
   drawlatch restart
   ```

   If a refresh token did end up on screen (a `curl` without `-o`, say), clear the terminal's scrollback.

   Then run `test_connection` on each template. It reports the scopes Google granted.

**Ways a refresh token dies** (each then fails as `invalid_grant`; mint a new one):

- The app is External and in *Testing*: 7 days.
- Six months unused. Any template's token refresh counts as use.
- You change your password, if the token includes Gmail scopes.
- You revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), or a Workspace admin's policy does.
- The limit of 100 refresh tokens per Google account per OAuth client: minting a 101st silently revokes the oldest. Keep that in mind if you mint one per scope set (below).

**Narrowing on refresh is not verified.** Google doesn't document whether a refresh request's `scope` parameter narrows the access token to a subset of the grant. Drawlatch handles either outcome safely:

- On every refresh, the engine requests exactly the template's scopes (after the caller's `oauth2Overrides`).
- It refuses any token whose reported `scope` includes something else, and any token that doesn't report a `scope`.

If Google narrows, one master refresh token serves every template. If it doesn't, every request fails closed with *"the token endpoint granted scopes broader than this connection allows (…)"*, and nothing leaks. Scopes are compared as exact strings, with no notion that one covers another, so this holds even when the extra scope is narrower: an un-narrowed token granted `spreadsheets` and `drive.readonly` is refused by `google-sheets` (naming `drive.readonly`) and by `google-drive-readonly` (naming `spreadsheets`), and one granted `spreadsheets` and `spreadsheets.readonly` is refused by both Sheets templates. The fix is then **one refresh token per scope set**, each consented (step 3) with only that template's scopes:

- **One scope set per caller:** nothing to configure. Each caller already has its own `<ALIAS>_GOOGLE_OAUTH_REFRESH_TOKEN`, so give each caller a token minted for its template.
- **Several Google templates on one caller** (say `google-sheets` with `google-drive-readonly` to find sheets by name): override all but one of them with a [custom connector](README.md#custom-connectors) under the same alias that reads a differently named refresh token. Copy the template from `src/connections/productivity/`, add `alias`, and rename the refresh-token secret:

  ```json
  {
    "connectors": [
      {
        "alias": "google-gmail-readonly",
        "secrets": {
          "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
          "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}",
          "GMAIL_RO_REFRESH_TOKEN": "${GMAIL_RO_REFRESH_TOKEN}"
        },
        "oauth2": {
          "tokenUrl": "https://oauth2.googleapis.com/token",
          "grant": "refresh_token",
          "clientAuth": "body",
          "secretRefs": {
            "clientId": "GOOGLE_OAUTH_CLIENT_ID",
            "clientSecret": "GOOGLE_OAUTH_CLIENT_SECRET",
            "refreshToken": "GMAIL_RO_REFRESH_TOKEN"
          },
          "scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
        },
        "allowedEndpoints": ["…copied from google-gmail-readonly.json…"],
        "testConnection": { "url": "https://gmail.googleapis.com/gmail/v1/users/me/profile" }
      }
    ],
    "callers": {
      "mail-agent": {
        "connections": ["google-gmail-readonly", "google-drive-readonly"],
        "selfManage": false
      }
    }
  }
  ```

  `mail-agent` then reads the Gmail token from `MAIL_AGENT_GMAIL_RO_REFRESH_TOKEN` and the Drive token from `MAIL_AGENT_GOOGLE_OAUTH_REFRESH_TOKEN`. (Redirecting a secret through the caller's `env`, as in `"GOOGLE_OAUTH_REFRESH_TOKEN": "${GMAIL_RO_REFRESH_TOKEN}"`, doesn't work today; see [README → Secrets](README.md#secrets). Nor does [`oauth2Overrides`](README.md#callers): it can narrow a connection's requested scopes or set a `subject`, but not pick a different refresh token.)

If the response lists scopes beyond the consented set (for example, ones carried over by `include_granted_scopes` from an earlier grant), the token is refused the same way. Mint a token for this client without them.

#### Service-account setup

1. **Create the service account and a key.** In the Cloud console, open **IAM & Admin → Service Accounts**, create an account, and choose **Keys → Add key → JSON**. Your organization's policy may forbid key creation (`iam.disableServiceAccountKeyCreation`). Enable the APIs the templates use in that project.
2. **Store the key as base64.** This has no quotes or newlines to break `.env`. Write it straight into drawlatch's `.env` (here `~/.drawlatch/.env`; use your config directory) rather than printing it, then delete the key file and restart the daemon:

   ```bash
   (umask 077; printf 'MAIL_AGENT_GOOGLE_SERVICE_ACCOUNT_KEY=%s\n' "$(base64 -w0 key.json)" >> ~/.drawlatch/.env)
   # macOS: "$(base64 -i key.json)" (no line wrapping by default)
   rm key.json
   drawlatch restart
   ```

   You can also paste the key file's JSON, or its base64, into the dashboard field.
3. **Without delegation**, the account reaches what is shared with its `client_email` (calendars, files, and spreadsheets), link-shared files and spreadsheets and public calendars whose ID it is given, and its own files (see **Which flavour** above). `google-sheets-sa` can edit the spreadsheets shared with it as **Editor** (Viewer shares stay read-only), link-shared ones whose link grants edit, and ones it creates. `test_connection` on `google-calendar-readonly-sa` lists the account's own (often empty) calendar list.
4. **With domain-wide delegation** (Workspace only), the account can act as a domain user. In the [Admin console](https://admin.google.com/), open **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**. Enter the service account's numeric client ID (`client_id` in the key file), and under OAuth scopes enter exactly the scopes of the templates you'll use, comma-separated. For example, `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/calendar.readonly`. Then name the user per caller:

   ```json
   {
     "callers": {
       "mail-agent": {
         "connections": ["google-gmail-readonly-sa"],
         "selfManage": false,
         "oauth2Overrides": { "google-gmail-readonly-sa": { "subject": "alice@example.com" } }
       }
     }
   }
   ```

   `subject` is admin-only config: templates can't set it, and no tool or dashboard control writes it. `list_routes` tells the agent only that the connection is `delegated`, not who the user is. `google-gmail-readonly-sa` without a subject is dropped for that caller with a boot-log message. With a subject, `users/me` in the Gmail URLs means that user.

Errors carry service-account hints:

- `unauthorized_client`: delegation isn't set up for this client ID.
- `access_denied`: the template's scopes aren't in the client ID's delegated scope list.
- `invalid_grant`: the key was deleted, the subject isn't a user in the domain, or the daemon's clock is off.

The 100-token limit doesn't apply to service accounts.

#### Template notes

- **Scopes bound reach, not intent.** A read-only template can still read everything in that scope, including mail an attacker sent to the account. `drive.file` can create, upload, overwrite, and delete the files it covers. The template leaves out the `permissions` endpoints, so the agent can't share a file (publicly or with anyone), but it can still put data into files it creates. Prefer the read-only templates.
- **`spreadsheets` covers every spreadsheet the account can open.** `google-sheets` can read every spreadsheet the Google account can see and edit every one it can edit, including ones other people shared with it, not just the household sheets you had in mind. There is no per-file Sheets scope: the only per-file Google scope is `drive.file` (the Drive API's, for files the OAuth client created or the user picked; see `google-drive-file`). To limit editing to chosen spreadsheets, use `google-sheets-sa` and share only those with the service account. A write scope is also a way out for data: the agent can write what it has read into any spreadsheet the account can edit, such as one an attacker shared with it, and formulas it writes (`IMPORTDATA`, `IMAGE`, …) may make Google fetch URLs it picks. `batchUpdate` can delete tabs, rows, and ranges; deleting, sharing, or moving the file itself needs the Drive API, which neither Sheets template reaches. A spreadsheet's version history (File → Version history) undoes edits.
- **Methods aren't restricted by the allowlist.** Read-only is enforced by Google through the scope, so a `POST` to an allowlisted path that needs a broader scope gets `403`. A `403` from drawlatch carries a hint naming the token's scopes.
- **No push channels.** Read scopes would let an agent register a push channel (`events/watch`, `calendarList/watch`, `settings/watch`, `files/{id}/watch`, `changes/watch`) that sends change notifications to any `https` URL it names. No template allows the `watch` or `channels/stop` endpoints. Calendar event IDs and the literal `watch` are both one path segment, so the Calendar templates refuse `watch` with [exclusion entries](README.md#custom-connectors) (`!…/events/watch`). Exclusions are also checked with unreserved percent-escapes decoded, so `w%61tch` is refused too, and a fragment is dropped before matching, so `watch#x` is too.
- **Path boundaries.** `**` appears only after `?` or `/`, so a pattern for `files` can't match `filesX`.
- **`gmail.metadata`:**
  - `messages.list` and `threads.list` refuse `q=` (no search).
  - `format=full` and `format=raw` are refused. Use `format=metadata` (with `metadataHeaders`) or `minimal`.
  - No attachments or drafts.
- **`drive.file`** sees only files this OAuth client created, or that the user opened with it through the Google Picker. With a refresh token minted as above, that means only the files the agent created. It uploads through `https://www.googleapis.com/upload/drive/v3/files`.
- **Calendar.** `calendars/*/acl` isn't allowlisted: listing ACLs needs more than `calendar.readonly`. `google-calendar-freebusy`'s test queries a fixed past hour and returns busy times only.
- **Sheets** has no read call that doesn't take a spreadsheet ID. `test_connection` reads `spreadsheetId` from Google's public sample spreadsheet (`1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms`), which also catches a project where the Sheets API isn't enabled. This hasn't been run against Google yet: if the sample sheet ever disappears, the test fails with `404` while real reads still work. Read with `GET …/v4/spreadsheets/{id}` or `…/values/{range}`. `google-sheets` uses the same test.
- **Sheets method suffixes.** Google writes custom methods as a `:` suffix on a path segment (`{id}:batchUpdate`, `values/{range}:append`, `sheets/{sheetId}:copyTo`). In an allowlist pattern `*` matches anything within one segment, `:` included, so `…/spreadsheets/*` covers `{id}`, `{id}:batchUpdate`, and `{id}:getByDataFilter` alike. Ranges work as written (`Sheet1!A1:B2`, `'My Sheet'!A:A`) or percent-encoded (`Sheet1%21A1%3AB2`). A `values:…` or `developerMetadata:search` suffix must use a literal `:` when it is its own segment: `{id}/values%3AbatchUpdate` matches no pattern and is refused. A `%2F` doesn't split a segment for matching, though, so `…/spreadsheets/*` also accepts `{id}%2Fvalues%3AbatchUpdate` as one segment. Whatever Google makes of such a path, the request still goes to `sheets.googleapis.com` under `/v4/spreadsheets` with the same token and scope, and a `.` or `..` segment in any encoding (`%2e`, or `%2f` / `%5c` / `\` as the separator) is refused before matching.
- **The rest of Google** (Docs, Tasks, People, a Gmail listener) isn't templated yet. Use a [custom connector](README.md#oauth2-token-minting) with the same secrets and an `oauth2` block for one scope.

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
