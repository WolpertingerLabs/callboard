# Callboard

A web control panel for coding agents — run [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Codex, Cline, pi or OpenCode through your browser instead of the terminal.

> **Alpha Software** — Expect breaking changes between updates.

Callboard gives you a full-featured chat interface on top of five agent harnesses. You get real-time streaming responses, tool permission controls, image uploads, git worktree isolation, a card board, scheduled and event-driven agents, and multi-step jobs — all from a browser tab you can keep open alongside your editor.

## Quick Start

### 1. Install

```bash
npm install -g @wolpertingerlabs/callboard
```

Requires **Node.js 22.19+**, and — for Claude Code, the default engine — either the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated, or an Anthropic API key set under Settings → API. See [Engines](#engines) for that and for the four other engines Callboard can run.

### 2. Set a password

```bash
callboard set-password
```

This step is not optional. Callboard has no anonymous mode: until a password hash is stored, `/api/auth/login` returns 503 and every other API route with it, so a server started without one has a login page that cannot be used. Minimum eight characters; the password is hashed with scrypt and the plaintext is never written anywhere.

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

Callboard prefers a `claude` you installed anyway, and one lookup decides it — for chats, for the login prompt and for the About page alike. In order:

1. the **Binary path** field under Settings → API → Claude Code (`pathToClaudeCodeExecutable`)
2. the `CLAUDE_BINARY` environment variable
3. `which claude`
4. four well-known install directories — `~/.local/bin`, `~/.claude/bin`, `/usr/local/bin`, `/opt/homebrew/bin`

Nothing resolving means this machine has no native CLI, and the Agent SDK's bundled binary runs. The status card names the path in effect and which of the four found it, which is worth reading: `~/.local/bin/claude` is where Anthropic's own `install.sh` lands, and a daemon that started before that directory was on its `PATH` finds it only through step 4.

Either binary field — Claude Code's or Codex's — is checked before it is used: the path must be **absolute**, exist, be a regular file, and be executable by the user running the Callboard daemon. (Absolute matters more than it looks: Callboard would resolve a relative path against the daemon's own directory while the engine spawns it from the chat's folder, so it would name a different file in every chat.) A path that fails any of those is **rejected** and resolution carries on as if the field were blank, so a typo cannot break every chat. The field says why while you are typing, and the status card says why afterwards. Editing either field takes effect on the next chat; no restart.

Both fields can only be changed from a browser on the same machine or LAN, or by editing `~/.callboard/agent-settings.json` on the host. They decide which executable the daemon spawns, so they are held to the same scope as running an install — a client reaching Callboard through Remote Access can see which binary is in effect but not change it.

Installing it is the recommended setup, and it is the only way to sign in with a Claude subscription:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

To use an API key or a gateway bearer token instead, set it under **Settings → API → Claude Code**, which also shows which token source is currently live. Callboard's "Claude Code Login Required" prompt reads that credential before it reaches for the CLI, so an API-key install doesn't get asked to log in — the prompt appears only when no credential of any kind was found, and it says which of the two remedies applies to your machine.

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

### Installing a CLI from the card

Three of the install commands above have an **Install** button beside them, which runs the `npm install -g …` for you and streams the output into the card: the native `claude`, the Codex CLI, and `opencode`. The package comes from a closed list in the source — nothing from the request reaches a command line, and there is no shell.

The button is offered only to a browser on the same machine or LAN, never to one reaching Callboard through Remote Access, and only when npm's global prefix resolved and is writable. Turn it off entirely with `allowEngineInstalls: false` in `~/.callboard/agent-settings.json`. Whenever it is withheld, the card says why and the copy-and-paste command is still there. The vendor `curl … | bash` installers never get a button — Callboard offers that text and will not run it for you.

A zero exit from npm is not the same claim as "the engine is installed", so the card doesn't make it: after a successful install Callboard re-probes and reports what it actually found, which is how you learn that the global bin directory isn't on the daemon's `PATH`.

## What You Can Do

### In a chat

- **Watch it work** — streaming responses with thinking, tool calls, and permission prompts, on whichever engine the chat runs
- **Gate tools** — set `allow` / `ask` / `deny` per chat on four axes: file read, file write, code execution, web access
- **Attach images** — drag and drop PNG, JPEG, GIF or WebP, up to 10 MB each
- **Start on a branch** — pick a base branch, name a new one (or have one generated from your prompt), and optionally run the chat in its own git worktree
- **Read the diff** — the chat's working tree, file by file, without leaving the tab
- **Use slash commands** — autocomplete over the commands your project and enabled plugins provide. The one you pick becomes a *chip* in the composer rather than text, so the prose you type alongside it stays yours; click the chip to read the command's body
- **Expand `$keyword` snippets** — named chunks of prompt text you keep under Settings → Keywords and drop inline by typing `$name`. Purely a client-side expansion: the harness sees prose you could have typed by hand
- **Save drafts** — park a message on a chat, or on a folder before the chat exists, and send it later
- **Fork a chat** — branch off an earlier message into a new chat. Forks keep their parentage, and the resulting tree is browsable
- **Switch model mid-chat** — and pick a reasoning effort on the harnesses that have one
- **See what the agent renders** — images, audio, video and PDFs pushed into the transcript, plus versioned HTML/SVG **canvases** an agent can create and then update in place

### Around the work

- **Workspaces** — a workspace is a `cwd` plus its git isolation. Start a chat in a worktree and Callboard records one; from the workspace manager you can rename it, archive it (with the worktree removed and quarantined in a trash you can restore from), or **adopt** worktrees Callboard didn't create. Several workspaces may share one checkout — that is a supported state, not a bug
- **Cards and the board** — a card is a durable ticket that groups chats and job runs around a topic. The board files open cards under **Needs you**, **Running** and **Idle**, with a card's own category as a sub-heading inside each — the question it answers first is what is waiting on you. Agents can create cards, join them, and set a narrative status on them
- **Jobs** — deterministic multi-step workflows. A job definition is an ordered list of steps (`agent`, `approval`, `poll`, `wait_event`, `gate`, `notify`, `parallel`, and nested `job`); control flow is backend code, the work inside a step is a spawned agent session. Spawning one creates a run you can pause, resume, cancel, or retry a failed step of, and runs survive a daemon restart. Built under Settings → Jobs, and importable/exportable as JSON
- **Custom skills** — write a skill under Settings → Skills and it lands at `~/.callboard/custom-skills/skills/<name>/SKILL.md`, invoked in chat as `callboard:<name>`
- **Model aliases** — one name (`planner`, `worker`) that resolves to a different concrete model per harness, accepted anywhere a model is configured: new chats, per-chat overrides, provider defaults, cron actions, job steps
- **Plugins & MCP** — register directories to scan and Callboard discovers Claude Code plugin marketplaces under them, along with the slash commands, hooks and MCP servers each plugin carries. Toggle plugins per directory
- **Themes** — every colour in the UI is a CSS variable, in a light and a dark set. Custom themes live as files in `~/.callboard/themes/`, and an agent can generate one for you
- **API keys** — mint `cbk_` bearer tokens under Settings → Account to drive the REST API from scripts. They authenticate every route a session cookie does, except minting more keys

## Agents

Callboard isn't just a chat window — it's a platform for running autonomous agents. Each agent gets its own identity, workspace, memory, and schedule.

### Creating Agents

Agents are created from the UI. Each agent has a name, emoji, personality, role, tone, pronouns and guidelines that shape how it behaves, plus what it knows about you — your name, timezone and location. Those compile into a system-prompt append you can inspect, section by section with a token estimate, from the agent's dashboard. Behind the scenes, an agent gets:

- **A workspace** at `~/.callboard/agent-workspaces/<alias>/` with scaffold files that teach it how to maintain memory, take notes, and work proactively — `CLAUDE.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`
- **A two-tier memory system** — daily journal files at `memory/YYYY-MM-DD.md` for running notes, and a curated long-term `MEMORY.md` distilled over time
- **Tool permissions** — agents default to full access (file read/write, code execution, web access) but you can restrict per session
- **A caller identity** for the connection proxy, chosen per proxy mode, which decides which external APIs it can reach

An agent can be switched off outright (`enabled: false`), which suppresses its crons, its triggers and its sessions at once.

### Triggering Agents

Agents can run in four ways:

- **Cron jobs** — scheduled tasks with cron expressions, evaluated in the agent's configured timezone. One-off, recurring, or indefinite, and optionally skipped when the previous run is still going. Two are created for every new agent: a **Heartbeat** every 30 minutes that reads `HEARTBEAT.md` and acts on what it finds, and a nightly **Memory Consolidation** at 03:00 that distils the day's journals into `MEMORY.md`.
- **Event triggers** — react to incoming events from external services (Discord messages, GitHub webhooks, etc.) with filters on source, event type and dot-notation conditions over the payload, and prompt templates that interpolate event data via `{{event.*}}`. A trigger can debounce, so a burst of events produces one session rather than forty.
- **Event subscriptions** — the lighter option: name a connection the agent watches, and it is woken when events arrive, with no filter or prompt template to configure. The agent decides what to do.
- **Direct invocation** — agents can start sessions as other agents (`deploy_agent`, fire-and-forget) or send them a message and wait for the reply (`talk_to_agent`), creating multi-agent workflows.

Each cron job and trigger names the harness, model and reasoning effort its sessions run on, so one agent can plan on one engine and grind on another.

### Quiet Hours

Quiet hours are set **per cron job and per trigger**, not once per agent: each item carries its own window, evaluated in the agent's timezone. A recurring cron job or a trigger inside its window is suppressed. One-off cron jobs fire regardless — something you scheduled for 3am still happens at 3am.

### Agent Tools

Agents have access to specialized tools beyond the standard coding-agent toolkit:

- Start, monitor, and continue chat sessions in any directory or branch, and read back their messages
- Run jobs — spawn a run, approve a step, pause, resume, cancel, or retry a failed step
- Manage their own cron jobs and event triggers, and query their own activity log
- Discover and orchestrate other agents on the platform
- Create and update cards, set a card's status or category, and file the current chat under one
- Create and update workspaces, and adopt worktrees Callboard didn't create
- Read and write custom skills, and manage model aliases
- Render media and canvases into the chat, and reach you outside it — `summon_user` raises a flag on the chat in the dashboard, `notify_user` hands back the handle for a contact channel you've enabled (Discord, Telegram or email) so the agent can deliver a message through the proxy
- Everything the connection proxy exposes: authenticated HTTP requests, event polling, listener control

## Connections & Event Listening

Callboard uses [@wolpertingerlabs/drawlatch](https://www.npmjs.com/package/@wolpertingerlabs/drawlatch) to give agents authenticated access to external APIs — Discord, GitHub, Slack, Google, Trello, and [many more](https://www.npmjs.com/package/@wolpertingerlabs/drawlatch).

### How Connections Work

A connection is a pre-configured API route template. Each connection defines the allowed endpoints (URL patterns), required secrets, and auth headers. When an agent makes a request, Drawlatch matches the URL against allowed patterns, injects the right credentials, and proxies the request. Agents never see the raw API keys — they just call `secure_request` with a URL and Drawlatch handles authentication.

Connections, secrets, event listeners and the webhook tunnel are **configured in Drawlatch's own password-gated dashboard**, not in Callboard. Settings → Proxy links straight to it. What Callboard keeps on its side is the wiring: which mode it talks to Drawlatch in, which caller identity each agent uses, and which caller regular (non-agent) chats borrow.

### Event Listening

Drawlatch supports real-time event ingestion from external services through three mechanisms:

- **WebSocket listeners** — persistent connections to services like Discord Gateway and Slack Socket Mode, with automatic reconnection and heartbeat management
- **Webhook receivers** — HTTP endpoints that receive and verify signed payloads from GitHub, Stripe, Trello, and others
- **Pollers** — interval-based HTTP polling for services like Notion, Linear, Reddit, and Telegram

Events are buffered in per-caller ring buffers. Callboard polls `poll_events` on a loop, one watcher per caller alias, and appends what it finds to an event log. This is what powers event triggers and event subscriptions — when an agent has a trigger configured for Discord messages, Drawlatch's event listener catches the message and the trigger dispatcher routes it to the right agent.

### Local vs. Remote Mode

Drawlatch runs in two modes. Both speak the same encrypted protocol — the difference is who owns the daemon and how the caller gets enrolled, not whether the channel is protected.

**Local mode** (the default) starts and supervises a Drawlatch daemon as a child process on loopback, and talks to it over that protocol like any other. Enrolment is automatic: Callboard points the daemon at its own keys directory and the daemon writes the key files there at boot, the same-host write being the proof of trust. This is the simplest way to get started on a personal server, and it is where the dashboard link takes you.

**Remote mode** points Callboard at a Drawlatch server somewhere else, which holds all the API keys. Communication is encrypted end-to-end with AES-256-GCM, authenticated with Ed25519 signatures, and protected against replay attacks. The remote server enforces per-caller access control — each caller only sees routes it has been explicitly granted. This is the right choice when you want secrets isolated from the machine running agents, or when several users share one Drawlatch server with different credentials.

To connect to a remote server, go to **Settings → Proxy**, switch the mode to Remote, and:

1. Issue a caller on the Drawlatch side (its Callers page → Issue credentials, or `drawlatch issue-caller`). That produces a `.drawlatch-caller.json` bundle.
2. Import that file on the Proxy page. Callboard pins the server key out of the bundle and shows it to you to confirm before writing any keys. Bundles wrapped with a passphrase will ask for it.
3. Set the **Server URL** by hand. The bundle carries an endpoint, but Callboard ignores it — tunnel URLs are ephemeral.

Enrolled callers are listed on the same page with their fingerprints and the agents bound to them, and can be deleted from there.

## CLI Reference

```
callboard                    Show status if running, otherwise the help text
callboard start              Start the server (background daemon)
callboard stop               Stop the server
callboard restart            Restart the server
callboard status             Show PID, port, uptime, and health
callboard logs               View and follow server logs
callboard config             Show effective configuration
callboard set-password       Set or change the login password
callboard help               Print the help text
```

Every subcommand takes `-h` / `--help` and prints its own page.

### Options

```
callboard -v                  Print the version and exit
callboard start -f            Run in the foreground
callboard start --port 3000   Use a custom port (default: 8000)
callboard restart --port 3000 Same, when restarting
callboard logs -n 100         Show last 100 log lines
callboard logs --no-follow    Print the lines and exit (default is to follow)
callboard config --path       Print the config file path
```

`callboard` with no arguments, and `start`, `status` and `config`, all warn when no password is set. Running it for the first time scaffolds `~/.callboard/.env` and prints the three steps above.

## Configuration

Callboard reads `~/.callboard/.env` (created automatically on first run), then a `.env` in the package root if one exists, which **overrides** it. `callboard config` prints the merged result and the paths it came from.

| Variable                   | Default                         | Description                                                 |
| -------------------------- | ------------------------------- | ----------------------------------------------------------- |
| `PORT`                     | `8000`                          | Server port                                                  |
| `LOG_LEVEL`                | `info`                          | Log level (`error`, `warn`, `info`, `debug`)                 |
| `SESSION_COOKIE_NAME`      | `callboard_session`             | Cookie name (change to avoid collisions)                     |
| `AUTH_PASSWORD_HASH`       | —                               | scrypt hash of the login password. Written by `set-password` |
| `AUTH_PASSWORD_SALT`       | —                               | Salt for the above. Written by `set-password`                |
| `INSTANCE_NAME`            | generated                       | Friendly name for this instance. Generated on first run      |
| `CALLBOARD_DATA_DIR`       | `~/.callboard`                  | Everything Callboard stores — config, chats, logs, PID file  |
| `CALLBOARD_WORKSPACES_DIR` | `~/.callboard/agent-workspaces` | Where agent workspaces are created                           |

Passwords are stored as scrypt hashes — plaintext is never saved. Set them with `callboard set-password`, not by editing the file.

`CALLBOARD_DATA_DIR` is read from the process environment, not from the `.env` — it decides *which* `.env` is read, so it has to be set before Callboard starts. Everything else lives under it: `chats/`, `jobs/`, `cards/`, `workspaces/`, `canvas/`, `images/`, `themes/`, `custom-skills/`, `keywords.json`, `agent-settings.json`, `api-keys.json`, `logs/`.

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

An optional **IP allowlist** on the same page narrows that further: list the addresses or CIDR ranges allowed in through the tunnel and everything else is refused before it reaches the login page. Loopback and private-LAN ranges are always allowed and are never gated by the list, so a bad entry can't lock you out of your own machine.

A client arriving through the tunnel is treated as remote throughout, not just at the door. It cannot change either engine's binary-path field, and it is never offered the one-click engine install — both decide what the daemon executes, so they are held to the same scope as running an install by hand.

## Development

If you want to contribute or run from source:

```bash
git clone https://github.com/WolpertingerLabs/callboard.git
cd callboard
npm install                # also builds, via the `prepare` script

cp .env.example .env       # then UNCOMMENT the DEV_PORT_SERVER line
CALLBOARD_DATA_DIR=$HOME/.callboard-dev node bin/callboard.js set-password

npm run dev
```

This starts the frontend on `http://localhost:3000` and the backend on `http://localhost:3002`.

Two things about that are easy to get wrong:

- **`DEV_PORT_SERVER` is not optional.** Vite proxies `/api` to port 3002 by default, but the dev backend only binds 3002 when `DEV_PORT_SERVER` says so — otherwise it falls through to `PORT`, i.e. 8000, and the UI talks to nothing. `.env.example` ships that line commented out, so copying it is not enough; uncomment `DEV_PORT_SERVER=3002` (and `DEV_PORT_UI` if 3000 is taken).
- **Dev has its own data directory.** `npm run dev` sets `CALLBOARD_DATA_DIR=$HOME/.callboard-dev`, so dev chats, settings and — importantly — the password hash are read from there, not from `~/.callboard`. That is why the `set-password` above names the directory explicitly. There is no auth bypass in development: without a password hash in the dev config, login returns 503.

### Scripts

| Command                 | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `npm run dev`           | Start frontend + backend dev servers against `~/.callboard-dev`           |
| `npm run build`         | Build shared, backend, and frontend for production                        |
| `npm run clean`         | Delete every `dist/` and TypeScript build-info file                       |
| `npm start`             | Start the production server from `backend/dist`                           |
| `npm test`              | Run tests (Vitest, single pass)                                           |
| `npm run test:watch`    | Run tests in watch mode                                                   |
| `npm run test:coverage` | Run tests with a v8 coverage report                                       |
| `npm run lint`          | Lint **staged** files only — what the commit workflow runs                |
| `npm run lint:fix`      | The same, with `--fix`                                                    |
| `npm run lint:all`      | Lint every file in the project                                            |
| `npm run lint:all:fix`  | The same, with `--fix`                                                    |
| `npm run prettier`      | Format changed and staged files                                           |
| `npm run swagger`       | Regenerate `backend/swagger.json` (served, with auth, at `GET /api/docs`) |

Note the split: `lint` and `lint:fix` pipe `git diff --cached` into ESLint and touch nothing else, so on a clean index they lint zero files and exit 0. Use `lint:all` when you want the whole tree.

`build` is incremental. If you delete a `dist/` by hand, `tsc -b` will still believe it is up to date and skip it — run `npm run clean` first.

### Project Structure

```
callboard/
├── frontend/        React UI (Vite + TypeScript)
├── backend/         Express API server (TypeScript)
│   └── src/
│       ├── routes/     HTTP + SSE endpoints
│       ├── services/   Domain logic, stores, MCP tool servers
│       ├── agents/     Per-harness adapters behind one provider port
│       └── scaffold/   Files copied into a new agent's workspace
├── shared/          TypeScript types used by both ends
├── bin/             CLI entry point (callboard command)
├── scripts/         Build and release helpers
└── plans/           Design docs for in-flight work
```

Runtime data is not in the repo — it lives under `~/.callboard` (or `$CALLBOARD_DATA_DIR`).

Two conventions worth reading before you change anything, both documented in `.claude/CLAUDE.md`: `shared/types/stream.ts` is a **published wire interface** with its own compatibility rules and a snapshot test, and everything cached or stored keys on either `cwd` or `workspaceId` depending on whether the directory or the workspace owns it.

### Tech Stack

React 18, React Router 6, Express 4, TypeScript 5, Vite 5, Zod 4, Winston logging, Vitest, ESLint + Prettier. Agent harnesses come from `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@cline/sdk`, `@earendil-works/pi-coding-agent` and `@agentclientprotocol/sdk`; connections from `@wolpertingerlabs/drawlatch`.

## License

MIT
