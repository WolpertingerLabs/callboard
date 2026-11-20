# Connections

A connection is a built-in template that gives an API's allowed URL patterns, the headers to inject, and the secrets it needs. Enable one by adding its name to a caller's `connections` list in `remote.config.json`, or from the dashboard:

```json
{ "callers": { "default": { "connections": ["github", "stripe"] } } }
```

Then set the secrets for that caller. Caller `default` reads `GITHUB_TOKEN` from `DEFAULT_GITHUB_TOKEN`. See [README → Secrets](README.md#secrets) for how secrets resolve, and [README → Custom connectors](README.md#custom-connectors) to add an API or override a template (a custom connector with the same alias wins). Templates live in `src/connections/<category>/<name>.json`.

## Available connections

**Bold** secrets are needed for API calls. The others are used only by the event listener, if at all. `doctor`, `config`, and the dashboard flag missing secrets only for built-in templates, and only those used in headers, so they won't catch a missing Telegram or Trello token. (`aws` is the exception: its signing keys count as required.) Set `<ALIAS>_<NAME>` even where `doctor` prints the bare name. Header secrets, listener `signatureSecret`s, and Slack's `SLACK_APP_TOKEN` are [withheld](README.md#header-only-secrets): the agent can't reference them as `${NAME}` in a request, and they're scrubbed from response bodies and listener events. That includes public values sent in headers, such as Twitch's `TWITCH_CLIENT_ID` and Reddit's `REDDIT_USER_AGENT`, which appear in responses as `${NAME}`; a custom connector can opt one out with `placeholderSecrets`. Listener types are described in [INGESTORS.md](INGESTORS.md).

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

Every template has a built-in `test_connection` request. Three of them cost a little credit: the Anthropic test sends a 1-token message, Exa runs a one-result search, and Parallel runs a small `turbo` search.

A secret that isn't set is sent as the literal placeholder (for example, `Bearer ${LICHESS_API_TOKEN}`). The `aws` connection refuses to send a request without its keys instead. Set every bold secret even for APIs with public endpoints.

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

**Google / Google AI.** `google` covers Workspace and other Google APIs with an OAuth token. Allowlisted hosts: `www`, `sheets`, `docs`, `drive`, `calendar-json`, `gmail`, `slides`, `people`, `tasks`, `admin`, `chat`, `forms`, `youtube`, `youtubeanalytics`, and `cloudresourcemanager` `.googleapis.com`. Add others with a custom connector that uses the same secret. `google-ai` is Gemini (`generativelanguage.googleapis.com`, both `v1` and `v1beta`).

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
