# Callboard

A web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — chat with Claude agents through your browser instead of the terminal.

> **Alpha Software** — Expect breaking changes between updates.

Callboard gives you a full-featured chat interface on top of the Claude Code agent SDK. You get real-time streaming responses, tool permission controls, image uploads, git integration, and more — all from a browser tab you can keep open alongside your editor.

## Quick Start

### 1. Install

```bash
npm install -g @wolpertingerlabs/callboard
```

Requires **Node.js 22+**, and — for Claude Code, the default engine — either the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated, or an Anthropic API key set under Settings → API. See [Engines](#engines) for that and for the four other engines Callboard can run.

### 2. Set a password

```bash
callboard set-password
```

### 3. Start the server

```bash
callboard start
```

Open **http://localhost:8000** in your browser and log in. That's it.

## Engines

Callboard runs a chat on one of five agent **engines** — Claude Code, Codex, Cline, pi, or OpenCode. You pick one per chat, and set each one's defaults under **Settings → API**. Every engine gets a tab there whether or not it can actually run, so start here. (The OpenRouter tab alongside them is not an engine — it holds a service credential the other engines can be routed through.)

| Engine          | How it runs                                                   | Install anything?     | Authentication                                                    |
| --------------- | ------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| **Claude Code** | Bundled agent SDK, but a `claude` on your `PATH` is preferred | Optional, recommended | `claude auth login`, or a key in Settings → API                   |
| **Codex**       | Bundled — the `codex` binary ships inside Callboard           | Only to log in        | `codex login` (needs the CLI), or an OpenAI key in Settings → API |
| **Cline**       | Bundled — runs in the Callboard process, no binary            | No                    | A key for the provider you pick, in Settings → API                |
| **pi**          | Bundled — runs in the Callboard process, no binary            | No                    | A key for the provider you pick, in Settings → API                |
| **OpenCode**    | An `opencode` binary you install, spawned per turn            | **Yes** — required    | `opencode auth login`, in your own terminal                       |

**Bundled** means the engine is an ordinary npm dependency of Callboard: you got it with `npm install -g @wolpertingerlabs/callboard`, and you update it by updating Callboard. Installing a bundled engine globally does not upgrade it — Node resolves the package from Callboard's own `node_modules` first, and global installs aren't on that search path, so the two copies coexist and Callboard keeps using its own. It doesn't break anything either; it just has no effect. To move a bundled engine forward, update Callboard.

### Claude Code

No engine to install: the Claude Agent SDK ships with Callboard, and carries a native `claude` binary for your platform with it. That binary is an *optional* dependency, so it is missing if you installed with `--omit=optional` or you're on a platform Anthropic doesn't publish one for — in which case the SDK throws on startup and asks you to reinstall or point it at a `claude` yourself.

Callboard prefers a `claude` you installed anyway. For running chats it checks the **Binary path** field under Settings → API → Claude Code (`pathToClaudeCodeExecutable`), then `which claude`, then the bundled binary. A second lookup — used by the login prompt and the About page — checks the `CLAUDE_BINARY` environment variable, then `which claude`, then a handful of well-known install paths, and it ignores the Binary path field entirely. The two can therefore land on different binaries; when they do, the status card at the top of the tab names both rather than picking one. Having the CLI on your `PATH` keeps them agreeing.

Either binary field — Claude Code's or Codex's — is checked before it is used: the path must be **absolute**, exist, be a regular file, and be executable by the user running the Callboard daemon. (Absolute matters more than it looks: Callboard would resolve a relative path against the daemon's own directory while the engine spawns it from the chat's folder, so it would name a different file in every chat.) A path that fails any of those is **rejected** and resolution carries on as if the field were blank, so a typo cannot break every chat. The field says why while you are typing, and the status card says why afterwards. Editing either field takes effect on the next chat; no restart.

Both fields can only be changed from a browser on the same machine or LAN, or by editing `~/.callboard/agent-settings.json` on the host. They decide which executable the daemon spawns, so they are held to the same scope as running an install — a client reaching Callboard through Remote Access can see which binary is in effect but not change it.

Installing it is the recommended setup, and it is the only way to sign in with a Claude subscription:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

To use an API key or a gateway bearer token instead, set it under **Settings → API → Claude Code**, which also shows which token source is currently live. One caveat worth knowing before you pick that path: it authenticates your chats, but Callboard's "Claude Code Login Required" prompt runs `claude auth status` against the native CLI and doesn't consult the key, so you will keep being asked to log in each session.

### Codex

Nothing to install to *run* Codex: `@openai/codex-sdk` brings the `codex` binary for your platform with it, so the engine is always present. What varies is whether you are signed in. Two ways to do that:

- **ChatGPT subscription.** This needs the Codex CLI as a separate install — Callboard's copy of the binary sits inside its own `node_modules` and never lands on your `PATH`, so `codex login` is not a command you have otherwise.

  ```bash
  npm install -g @openai/codex
  codex login
  ```

  That writes `~/.codex/auth.json` (or wherever `CODEX_HOME` points) and Callboard reads it from there. The global CLI is only needed to log in — chats still run on Callboard's bundled copy, unless you point the **Binary path** field at it (below).

- **API key.** Switch the auth mode to API key under **Settings → API → Codex** and paste an OpenAI key. Nothing to install, no CLI involved.

#### Running your own `codex`

Set **Binary path** under Settings → API → Codex (`codexPathOverride`) and chats spawn that binary instead of the bundled one — useful if you want a newer Codex than the release Callboard pins, or a build of your own. If you installed the CLI globally to run `codex login`, `which codex` prints the path to use.

There is no `PATH` search behind that field: it is your path or the bundled copy, nothing in between. Auth and sessions do not move either — the overriding binary still reads `$CODEX_HOME/auth.json` and writes to the same rollout tree.

One thing to watch. Callboard parses Codex's session rollout files by hand, and that format is undocumented and changes between releases. Run a `codex` far enough from the version Callboard targets and the transcripts it writes **from now on** can render with turns missing rather than fail loudly — chats recorded by a matching version still read correctly. The status card shows a **Compatibility** row when the version in effect differs from the one the parser was written against.

### Cline

Nothing to install, and no binary at all — the `@cline/sdk` runtime runs inside the Callboard process.

Pick a provider (`anthropic` by default) and give it a key under **Settings → API → Cline**. Leave the key blank and the runtime falls back to the usual environment variables — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, the AWS credential chain, and so on.

### pi

Nothing to install. Like Cline, pi is an in-process library.

Pick a provider (`openrouter` by default) and give it a key under **Settings → API → pi**. Blank falls back to the environment (`OPENROUTER_API_KEY`, …); a key set here wins over the environment when both are present. Callboard never writes to pi's own auth file.

### OpenCode

**The one engine you have to install.** Callboard talks to OpenCode over the [Agent Client Protocol](https://agentclientprotocol.com) by spawning the `opencode` binary, so if it isn't on the `PATH` of the user running the Callboard daemon, the engine does not work at all.

```bash
npm install -g opencode-ai
```

Or use OpenCode's own installer — see the [OpenCode docs](https://opencode.ai/docs/).

Authentication is mostly OpenCode's own: run `opencode auth login` in a terminal. Callboard never touches OpenCode's credential file, which OpenCode shares with your own terminal sessions. The one credential Callboard does hold for it is **Give ACP agents an OpenRouter key**, under **Settings → API → OpenCode** — handed to the spawned process as `OPENROUTER_API_KEY` so OpenCode's own OpenRouter provider works.

Note that "installed" and "signed in" are separate questions here, and Callboard can only answer the first — it checks that the binary resolves on your `PATH`. ACP gives no way to ask an agent who is logged in, so an OpenCode you installed but never signed into shows as available and then fails when you send your first message, with OpenCode's own error. When that happens, `opencode auth login` is the fix.

### After installing an engine, or signing in

Callboard resolves engine binaries — and the Claude Code account — once, and caches the answers for the life of the daemon, because `PATH` doesn't change underneath a running process. So after you install a CLI or run a `login` command, the card in **Settings → API** is still reporting what it found before.

Press **Recheck** on that card. It drops every cached lookup (each engine's binary path and version, the executable handed to the Agent SDK, and the Agent SDK's account info) and probes again, so a running daemon picks up both a new binary and a fresh login without a restart. Re-probing spawns processes, so it's limited to one real check every ten seconds; press it again inside that and you'll be told you're seeing the previous result.

**Recheck cannot see everything.** Three cases need `callboard restart` instead, and Callboard states each one on the card rather than pretending it checked:

- **A vendor install script.** `https://opencode.ai/install` installs to `~/.opencode/bin` and `https://claude.ai/install.sh` lands in `~/.local/bin`; both put that directory on your `PATH` by editing your shell rc. New terminals get it — a process that's already running never does, because its `PATH` was fixed when it started. This is the common case, not an edge one: restart Callboard from a terminal where the command works.
- **A global prefix you can't write to.** A system-wide Node install fails `npm install -g` with `EACCES` until you point npm somewhere you own (`npm config set prefix ~/.npm-global`, then make sure that `bin/` is on your `PATH`).
- **nvm.** The global prefix belongs to the active Node version, so a binary installed under one version is invisible to a daemon running under another. Compare `node -v` in the terminal you installed from against the Node running Callboard.

## What You Can Do

- **Chat with Claude agents** — real-time streaming with thinking, tool calls, and permission prompts
- **Manage tool permissions** — approve, deny, or auto-allow file reads, writes, execution, and web access per session
- **Attach images** — drag and drop images for visual context
- **Browse and switch git branches** — create worktrees, view diffs, and manage branches from the UI
- **Queue messages** — save drafts to send later
- **Use slash commands** — autocomplete-enabled commands from your project's configuration
- **Load plugins** — extend Claude's capabilities with custom plugins

## Agents

Callboard isn't just a chat window — it's a platform for running autonomous Claude agents. Each agent gets its own identity, workspace, memory, and schedule.

### Creating Agents

Agents are created from the UI. Each agent has a name, personality, role, and guidelines that shape how it behaves. Behind the scenes, an agent gets:

- **A workspace** at `~/.callboard/agent-workspaces/<alias>/` with scaffold files that teach it how to maintain memory, take notes, and work proactively
- **A two-tier memory system** — daily journal files for running notes, and a curated long-term `MEMORY.md` distilled over time
- **Tool permissions** — agents default to full access (file read/write, code execution, web access) but you can restrict per session

### Triggering Agents

Agents can run in three ways:

- **Cron jobs** — scheduled tasks with cron expressions and timezone support. One-off, recurring, or indefinite. A default "heartbeat" job lets agents periodically check in and do proactive work.
- **Event triggers** — react to incoming events from external services (Discord messages, GitHub webhooks, etc.) with configurable filters and prompt templates that interpolate event data.
- **Direct invocation** — agents can spawn other agents programmatically, creating multi-agent workflows.

### Quiet Hours

Agents respect quiet hours — a configurable time window where recurring cron jobs and event triggers are suppressed. One-off scheduled jobs still fire. You can scope quiet hours to just crons, just triggers, or both.

### Agent Tools

Agents have access to specialized tools beyond the standard Claude Code toolkit:

- Start and monitor chat sessions in any directory or branch
- Manage their own cron jobs and event triggers
- Discover and orchestrate other agents on the platform
- Query their own activity logs

## Connections & Event Listening

Callboard uses [@wolpertingerlabs/drawlatch](https://www.npmjs.com/package/@wolpertingerlabs/drawlatch) to give agents authenticated access to external APIs — Discord, GitHub, Slack, Google, Trello, and [many more](https://www.npmjs.com/package/@wolpertingerlabs/drawlatch).

### How Connections Work

A connection is a pre-configured API route template. Each connection defines the allowed endpoints (URL patterns), required secrets, and auth headers. When an agent makes a request, Drawlatch matches the URL against allowed patterns, injects the right credentials, and proxies the request. Agents never see the raw API keys — they just call `secure_request` with a URL and Drawlatch handles authentication.

### Event Listening

Drawlatch supports real-time event ingestion from external services through three mechanisms:

- **WebSocket listeners** — persistent connections to services like Discord Gateway and Slack Socket Mode, with automatic reconnection and heartbeat management
- **Webhook receivers** — HTTP endpoints that receive and verify signed payloads from GitHub, Stripe, Trello, and others
- **Pollers** — interval-based HTTP polling for services like Notion, Linear, Reddit, and Telegram

Events are buffered in per-caller ring buffers. Agents retrieve them by calling `poll_events`, which returns new events since the last cursor. This is what powers event triggers — when an agent has a trigger configured for Discord messages, Drawlatch's event listener catches the message and the trigger dispatcher routes it to the right agent.

### Local vs. Remote Mode

Drawlatch runs in two modes:

**Local mode** (default with Callboard) runs Drawlatch in-process. Secrets are read from environment variables on the same machine. There's no encryption layer between Callboard and Drawlatch — they share the same process. This doesn't provide extra security isolation for secrets, but it gives you the full feature set: endpoint allowlisting, structured route resolution, event listening, and all the MCP tools. For a personal server on your own machine, this is the simplest way to get started.

**Remote mode** separates Drawlatch into two components: a local MCP proxy (which holds no secrets) and a remote secure server (which holds all the API keys). Communication between them is encrypted end-to-end with AES-256-GCM, authenticated with Ed25519 signatures, and protected against replay attacks. The local proxy never sees plaintext secrets. The remote server enforces per-caller access control — each caller only sees routes they've been explicitly granted. This is the right choice when you want secrets isolated from the machine running agents, or when multiple users share a single Drawlatch server with different credentials.

To connect to a remote Drawlatch server, use the sync wizard in **Settings → Proxy Settings**. It walks you through the key exchange — enter the codes from the remote server, confirm, and you're connected. New caller aliases for agents are also managed from this page.

## CLI Reference

```
callboard start              Start the server (background daemon)
callboard stop               Stop the server
callboard restart             Restart the server
callboard status              Show PID, port, uptime, and health
callboard logs                View and follow server logs
callboard config              Show effective configuration
callboard set-password        Set or change the login password
```

### Options

```
callboard start -f            Run in the foreground
callboard start --port 3000   Use a custom port (default: 8000)
callboard logs -n 100         Show last 100 log lines
callboard config --path       Print the config file path
```

## Configuration

Callboard stores its config at `~/.callboard/.env` (created automatically on first run).

| Variable                   | Default                         | Description                                  |
| -------------------------- | ------------------------------- | -------------------------------------------- |
| `PORT`                     | `8000`                          | Server port                                  |
| `LOG_LEVEL`                | `info`                          | Log level (`error`, `warn`, `info`, `debug`) |
| `SESSION_COOKIE_NAME`      | `callboard_session`             | Cookie name (change to avoid collisions)     |
| `CALLBOARD_WORKSPACES_DIR` | `~/.callboard/agent-workspaces` | Where agent workspaces are created           |

Passwords are stored as scrypt hashes — plaintext is never saved.

## Remote access (Cloudflare tunnel)

Callboard can expose its web UI to the public internet through a [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
tunnel, so you can reach your instance from outside your LAN. It is **off by default** —
enable it under **Settings → Remote Access**.

- **Quick tunnel** — free, no Cloudflare account; gets a random `*.trycloudflare.com`
  URL that changes on each restart.
- **Named tunnel** — paste a token from the Cloudflare Zero Trust dashboard (route the
  hostname to `http://localhost:8000`) for a stable hostname.

> ⚠️ **Security:** enabling remote access makes callboard reachable by anyone with the
> URL — your login password becomes the only barrier to your sessions, files, and
> connected services. Callboard refuses to enable the tunnel until a password is set;
> make sure it is strong and unique. The `cloudflared` binary must be installed.

## Development

If you want to contribute or run from source:

```bash
git clone https://github.com/WolpertingerLabs/callboard.git
cd callboard
npm install
cp .env.example .env       # edit .env and set AUTH_PASSWORD
npm run dev
```

This starts the frontend on `http://localhost:3000` and the backend on `http://localhost:3002`.

### Scripts

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `npm run dev`      | Start frontend + backend dev servers |
| `npm run build`    | Build for production                 |
| `npm start`        | Start production server              |
| `npm test`         | Run tests (Vitest)                   |
| `npm run lint:all` | Lint all files                       |

### Project Structure

```
callboard/
├── frontend/        React UI (Vite + TypeScript)
├── backend/         Express API server (TypeScript)
├── shared/          Shared TypeScript types
├── bin/             CLI entry point (callboard command)
└── data/            Runtime data — chats, images, sessions (gitignored)
```

### Tech Stack

React 18, Express.js, TypeScript, Vite, Claude Agent SDK, Winston logging, Vitest, ESLint + Prettier.

## License

MIT
