# Callboard

A web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — chat with Claude agents through your browser instead of the terminal.

> **Alpha Software** — Expect breaking changes between updates.

Callboard gives you a full-featured chat interface on top of the Claude Code agent SDK. You get real-time streaming responses, tool permission controls, image uploads, git integration, and more — all from a browser tab you can keep open alongside your editor.

## Quick Start

### 1. Install

```bash
npm install -g @wolpertingerlabs/callboard
```

Requires **Node.js 22+** and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

### 2. Set a password

```bash
callboard set-password
```

### 3. Start the server

```bash
callboard start
```

Open **http://localhost:8000** in your browser and log in. That's it.

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
