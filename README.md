# Callboard

A browser control panel for coding agents. Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Codex, Cline, pi or OpenCode from a web UI instead of a terminal.

> **Alpha software.** Expect breaking changes between updates.

You get streaming chats with tool-permission controls, image uploads, git worktree isolation, a card board, scheduled and event-driven agents, multi-step jobs, a blob store and reusable HTML artifacts.

## Quick start

```bash
npm install -g @wolpertingerlabs/callboard
callboard set-password
callboard start
```

Then open **http://localhost:8000** and log in.

- Requires **Node.js 22.19+**.
- The password is required. Until one is set, login and every authenticated API route return 503, so the UI can't be used. The minimum length is eight characters. Callboard stores only an scrypt hash.
- To use Claude Code, the default engine, either sign in with the `claude` CLI or add an Anthropic API key under **Settings → API**. See [Engines](#engines).

## Engines

Each chat runs on one of five engines. You pick the engine per chat and set each engine's defaults on its tab under **Settings → API**. The **OpenRouter** tab there isn't an engine. It holds the account-wide OpenRouter key and base URL, which Callboard uses for model catalogs and one-shot completions (chat titles, branch names, generated themes).

| Engine          | How it runs                                                        | Must you install it? | Sign-in                                                 |
| --------------- | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------- |
| **Claude Code** | Bundled Agent SDK; prefers a `claude` binary if it finds one        | No (recommended)     | `claude auth login`, or an API key in Settings → API     |
| **Codex**       | Bundled `codex` binary                                              | Only to log in       | `codex login`, or an OpenAI key in Settings → API        |
| **Cline**       | In-process library                                                  | No                   | A provider key in Settings → API                         |
| **pi**          | In-process library                                                  | No                   | A provider key in Settings → API                         |
| **OpenCode**    | Your `opencode` binary, spawned per turn over the [Agent Client Protocol](https://agentclientprotocol.com) | **Yes** | `opencode auth login` in your own terminal |

Bundled engines are npm dependencies of Callboard, so updating Callboard updates them. A global install of the same package has no effect, because Node resolves Callboard's own copy first.

### Claude Code

Callboard uses the first `claude` it finds, checking in this order:

1. **Binary path** under Settings → API → Claude Code (`pathToClaudeCodeExecutable`)
2. the `CLAUDE_BINARY` environment variable (it must answer `--version` as Claude Code)
3. `which claude`
4. `~/.local/bin`, `~/.claude/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`

If none of these resolve, the Agent SDK's bundled binary runs. That binary is an optional dependency, so it's missing if you installed with `--omit=optional`. The engine's status card shows which path is in effect and which step found it.

Installing the CLI is the only way to use a Claude subscription:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

To use an API key or a gateway token, set it under **Settings → API → Claude Code** instead. The "Claude Code Needs Credentials" dialog appears only when Callboard finds no credential at all.

### Codex

The bundled `codex` binary is always available. What varies is the sign-in:

- **ChatGPT subscription:** install the CLI and run `npm install -g @openai/codex && codex login`. This writes `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), which Callboard reads. Chats still run on the bundled binary.
- **API key:** switch the auth mode under **Settings → API → Codex** and paste an OpenAI key.

To run a different `codex`, set **Binary path** (`codexPathOverride`). This field does no `PATH` search: chats use either the path you set or the bundled copy. Callboard parses Codex's undocumented rollout files, so a far-off version can render transcripts with missing turns. When the version in effect differs from the one the parser targets, the status card shows a **Compatibility** row.

### Cline and pi

Both run inside the Callboard process, with no binary. Pick a provider and add its key under their tabs in Settings → API. Cline defaults to `anthropic` and pi to `openrouter`.

- **Cline:** if you leave the key blank, Callboard passes no key and leaves the SDK to its own environment fallback (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and so on).
- **pi:** a key set in Settings overrides the environment. Callboard never writes pi's auth file.

### OpenCode

OpenCode is the only engine you have to install yourself, and it must be on the daemon's `PATH`:

```bash
npm install -g opencode-ai     # or OpenCode's own installer
opencode auth login
```

Callboard never touches OpenCode's credential file. Settings → API → OpenCode has two settings:

- **Give ACP agents an OpenRouter key:** when this is on, OpenCode gets the key from this tab (or the account-wide OpenRouter key if this one is blank) as `OPENROUTER_API_KEY`.
- **Default Model:** the model new OpenCode chats start on.

Callboard can check that `opencode` is installed but not whether you're signed in. If you never signed in, the first message fails with OpenCode's own error.

### Binary path fields

The Claude Code and Codex **Binary path** fields only accept a path that is absolute, exists, is a regular file, and is executable by the daemon's user. If the path fails a check, Callboard ignores it and the card explains why. Changes apply to the next chat.

Only a browser on the same machine or LAN can change these fields, because they decide what the daemon executes. A client coming through [Remote Access](#remote-access) can see them but not change them.

### After you install or sign in

Callboard caches binary lookups and Claude account info for the life of the daemon. After you install a CLI or log in, press **Recheck** on the engine's card. It re-probes at most once every 10 seconds.

Recheck can't fix a stale `PATH`. You need `callboard restart`, run from a terminal where the command works, when:

- a vendor install script (`opencode.ai/install` → `~/.opencode/bin`, `claude.ai/install.sh` → `~/.local/bin`) added its directory to `PATH` through your shell rc file
- you installed under a different nvm Node version than the one running Callboard

### The Install button

The engine cards for `claude`, Codex and `opencode` have an **Install** button. It runs `npm install -g` from a fixed list of packages, without a shell, and then re-probes. The button only appears when all of these hold:

- the browser is on the same machine or LAN
- npm's global prefix is writable
- the host isn't Windows

To turn the button off, set `allowEngineInstalls: false` in `~/.callboard/agent-settings.json`, or use the toggle on the Remote Access page. Callboard never runs `curl … | bash` installers for you.

## Features

### In a chat

- **Streaming:** text, thinking, tool calls and permission prompts, on any engine.
- **Tool permissions:** set `allow`, `ask` or `deny` per chat on five axes: file read, file write, code execution, web access, and Browser & Computer Control.
- **Images:** drag in PNG, JPEG, GIF or WebP files, up to 10 MB each.
- **Branches and worktrees:** pick a base branch, name a new branch (or generate a name from the prompt), and optionally run the chat in its own worktree.
- **Diffs:** view the chat's working-tree diff file by file.
- **Slash commands:** autocomplete covers your project's and plugins' commands. The chosen command becomes a chip in the composer.
- **`$keyword` snippets:** saved under Settings → Keywords. Callboard expands them in the browser before sending.
- **Drafts:** save a message for an existing chat, or for a folder before its chat exists.
- **Forks:** branch off an earlier message into a new chat. The fork tree is browsable.
- **Model and effort:** switch the model mid-chat, and set the reasoning effort on engines that support it.
- **Rendered output:** agents can show images, audio, video and PDFs inline, plus versioned HTML/SVG canvases that they update in place.

### Around the work

- **Cards and the board:** every top-level chat is a card, along with everything spawned from it (child chats and job runs). The board groups cards under **Needs you**, **Running** and **Idle**, with sub-headings for each card's category. Agents can read and edit the title, description, emoji, status, category and metadata of their own card.
- **Workspaces:** a workspace is a `cwd` plus its git isolation. Callboard records one when a chat starts in a worktree. Agents manage workspaces with MCP tools (`list_workspaces`, `create_workspace`, `rename_workspace`, `archive_workspace`, `list_unmanaged_worktrees`, `adopt_worktrees`). Archiving moves a clean, Callboard-owned worktree into `~/.callboard/trash` for 30 days, and each entry includes a restore recipe.
- **Jobs:** deterministic multi-step workflows. Step types are `agent`, `approval`, `poll`, `wait_event`, `gate`, `notify`, `parallel` and nested `job`. You can pause, resume and cancel a run, or retry a failed step, and runs survive a restart. Build jobs under Settings → Jobs, or import and export them as JSON.
- **Storage:** a key-based blob store, managed under Settings → Storage and with the `*_storage_*` tools.
- **Artifacts:** named, versioned HTML, SVG or markdown documents (the last 50 versions are kept). Agents save them with `save_artifact` and show them with `render_artifact`. An artifact can have read or read-write access to one storage key. Manage them under Settings → Artifacts. Each artifact also opens full-window at `/a/<id>`.
- **Custom skills:** skills you write under Settings → Skills are saved to `~/.callboard/custom-skills/skills/<name>/SKILL.md` and invoked as `callboard:<name>`.
- **Model aliases:** one name, such as `planner`, that maps to a different model per engine. Aliases work anywhere a model is set.
- **Plugins & MCP:** Callboard scans directories you register for Claude Code plugin marketplaces and picks up their commands, hooks and MCP servers. Plugins are toggled per directory.
- **Themes:** every UI colour is a CSS variable, with light and dark sets. Custom themes are files in `~/.callboard/themes/`, and an agent can generate one for you.
- **API keys:** mint `cbk_` bearer tokens under Settings → Account for scripts. These keys can't perform human-only actions such as minting more keys or controlling a computer.

### Browser & Computer Control (preview)

This lets an agent drive a managed Chromium browser, or a Linux X11 desktop, **on the machine running Callboard**. It is off unless you turn it on.

- **Permission:** Browser & Computer Control is the fifth permission axis. It defaults to **Deny**, and new child chats, job steps and agent sessions start with it denied. To use it, set it to **Ask** or **Allow** in the chat's permission dialog.
- **Enabling a target is always a human action.** The agent can call `cu_request_control` to put an **Enable browser control** or **Enable desktop control** card in the chat. You can also enable a target from the Computer view, which you open with the monitor icon (**Show computer control**) in the chat header. The agent can't grant itself access.
- **Ask vs Allow:** under **Ask**, every GUI action pauses the turn until you approve it in the chat. Only a signed-in browser can approve, not an API key. Under **Allow**, the agent acts unattended and each action is written to the server log.
- **Subagents share the grant.** Claude Code Task subagents and Codex native subagents act as the parent chat.
- **Stop computer control** in the chat header stops every session in the chat. Take over before you type or click yourself, and choose **Resume** to hand control back. Images already sent to a model can't be recalled.
- If a tab is running an older Callboard bundle, it shows **Reload this Callboard tab** instead of an approval card.

Set up the host first:

- **Browser:** Playwright installs with Callboard as an optional dependency, but no browser is downloaded. Provide Chromium and its OS libraries, and set `CALLBOARD_BROWSER_EXECUTABLE=/absolute/path/to/chrome` if Playwright won't find it. Chromium's sandbox is mandatory. On Linux, run as a non-root user with sandbox support. The chat's Web Access permission must be Allow.
- **Desktop:** only an existing Linux X11 session works. It needs `/usr/bin/xdotool`, ImageMagick's `/usr/bin/import`, and `CALLBOARD_NATIVE_DISPLAY` (or `DISPLAY`). All four other permission axes must be Allow, because desktop control can reach everything the user can. This isn't an isolation boundary. macOS, Windows and Wayland aren't supported.

Live sandboxed-browser use and native desktop workflows haven't been qualified yet. For the security model and limits, see [`packages/computer-use/README.md`](packages/computer-use/README.md).

## Agents

An agent is a named identity with its own workspace, memory, schedule and triggers, created from the **Agents** page. Its identity (name, emoji, role, personality, tone, pronouns, guidelines) and what it knows about you (name, timezone, location) are compiled into a system-prompt append. You can inspect that append section by section, with token estimates, on the agent's dashboard.

Each agent gets:

- **A workspace** at `~/.callboard/agent-workspaces/<alias>/`, seeded with `CLAUDE.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md` and `MEMORY.md`.
- **Two-tier memory:** daily journals in `memory/YYYY-MM-DD.md`, plus a curated `MEMORY.md`. Every session preloads `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, today's journal and yesterday's journal. Yesterday's journal is capped by the **journal budget** on the Memory tab, which defaults to 16k tokens. A capped journal keeps its tail and includes a note telling the agent to read the full file.
- **Permissions:** the four original axes default to allow, and Browser & Computer Control is denied.
- **A caller identity** for the connection proxy, which decides which external APIs the agent can reach.

Setting `enabled: false` turns off an agent's crons, triggers and sessions.

### Triggering agents

- **Cron jobs:** one-off, recurring or indefinite, evaluated in the agent's timezone. They can optionally skip a run while the previous one is still going. Every new agent gets two: a **Heartbeat** every 30 minutes (it reads `HEARTBEAT.md`) and a nightly **Memory Consolidation** at 03:00.
- **Event triggers:** filter incoming events by source, event type and dot-path conditions, and build a prompt from `{{event.*}}`. Triggers can debounce bursts of events.
- **Event subscriptions:** watch a connection and wake the agent when events arrive, with no filter or template.
- **Other agents:** `deploy_agent` starts a session as another agent (fire and forget). `talk_to_agent` sends a message and waits for the reply.

Each cron job and trigger sets its own engine, model and reasoning effort, and its own **quiet hours**. Recurring jobs and triggers don't fire inside their quiet hours. One-off jobs fire regardless.

### Agent tools

Beyond their engine's normal tools, agents can:

- start, monitor and continue chats, and read their messages
- run and steer jobs
- manage their own crons and triggers, and read their activity log
- find and orchestrate other agents
- edit their card, manage workspaces, custom skills, model aliases, storage and artifacts
- render media and canvases into the chat
- reach you: `summon_user` flags the chat on the dashboard, and `notify_user` returns a contact channel you've enabled (Discord, Telegram or email)
- use everything the connection proxy exposes (below)

## Connections and events

[Drawlatch](https://www.npmjs.com/package/@wolpertingerlabs/drawlatch) gives agents authenticated access to external APIs such as Discord, GitHub, Slack, Google and Trello. A connection is a route template: allowed URL patterns, required secrets and auth headers. An agent calls `secure_request` with a URL, and Drawlatch checks it against the patterns, injects credentials and proxies the call. The agent never sees the keys.

You configure connections, secrets, event listeners and the webhook tunnel in **Drawlatch's own dashboard**, which Settings → Proxy links to. Callboard stores only the wiring: the proxy mode, each agent's caller identity, and which caller regular chats use.

Drawlatch takes in events through WebSocket listeners (Discord Gateway, Slack Socket Mode), signed webhooks (GitHub, Stripe, Trello) and pollers. Callboard runs one watcher per caller. It long-polls Drawlatch's `wait_for_events`, and falls back to `ingestor_status` plus `poll_events` on older Drawlatch servers. The events it collects drive triggers and subscriptions.

### Local vs remote mode

Both modes use the same encrypted, signed protocol.

- **Local** (default): Callboard starts and supervises a Drawlatch daemon on loopback and enrols itself automatically.
- **Remote:** Callboard connects to a Drawlatch server elsewhere that holds the keys and enforces per-caller access. Use this to keep secrets off the agent machine, or to share one server between users. To set it up:
  1. Issue a caller on the Drawlatch side (its Callers page, or `drawlatch issue-caller`) to get a `.drawlatch-caller.json` bundle.
  2. In Settings → Proxy, switch to Remote and import the bundle. Confirm the pinned server key. Bundles protected by a passphrase will ask for it.
  3. Enter the **Server URL** by hand. Callboard ignores the endpoint in the bundle because tunnel URLs change.

## CLI

```
callboard                     Status if running, otherwise help
callboard start [-f] [--port N]   Start as a daemon (-f: foreground)
callboard stop
callboard restart [--port N]
callboard status              PID, port, uptime, health
callboard logs [-n N] [--no-follow]
callboard config [--path]     Effective configuration (or just the file path)
callboard set-password
callboard -v                  Version
```

Every subcommand accepts `--help`. The first run creates `~/.callboard/.env`.

## Configuration

Callboard reads `~/.callboard/.env`. If the package root also has a `.env`, its values override the first file. `callboard config` prints the merged result.

| Variable                       | Default                         | Purpose                                                         |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------- |
| `PORT`                         | `8000`                          | Server port                                                     |
| `LOG_LEVEL`                    | `info`                          | `error`, `warn`, `info`, `debug`                                |
| `SESSION_COOKIE_NAME`          | `callboard_session`             | Change to avoid cookie collisions on localhost                  |
| `AUTH_PASSWORD_HASH` / `_SALT` | —                               | Written by `callboard set-password`; don't edit by hand         |
| `INSTANCE_NAME`                | generated                       | Friendly instance name                                          |
| `CALLBOARD_DATA_DIR`           | `~/.callboard`                  | All stored data. Read from the process environment only         |
| `CALLBOARD_WORKSPACES_DIR`     | `$CALLBOARD_DATA_DIR/agent-workspaces` | Where agent workspaces live                              |
| `CALLBOARD_MAX_BACKGROUND_HOLD_MS` | `900000` (15 min)           | How long a finished turn waits on its backgrounded shell tasks   |

`CALLBOARD_DATA_DIR` decides which `.env` is read, so it can't be set inside one. That directory holds everything: chats, agents, jobs, workspaces, storage, artifacts, settings (`agent-settings.json`), API keys, themes, logs and the PID file.

## Remote access

**Settings → Remote Access** can expose the UI through a [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) tunnel. It's off by default, and you need the `cloudflared` binary installed.

- **Quick tunnel:** no Cloudflare account needed. You get a random `*.trycloudflare.com` URL that changes on every restart.
- **Named tunnel:** paste a token from Cloudflare Zero Trust and route the hostname to `http://localhost:8000` for a stable address.

> ⚠️ With the tunnel on, your password is the only thing protecting your sessions, files and connected services. Callboard won't start the tunnel until a password is set. Use a strong, unique one.

An optional **IP allowlist** (addresses or CIDR ranges) refuses all other tunnel traffic before it reaches the login page. Loopback and private-LAN addresses are always allowed. Tunnel clients can't change binary paths or use the Install button.

## Development

```bash
git clone https://github.com/WolpertingerLabs/callboard.git
cd callboard
npm install                 # also builds, via `prepare`
cp .env.example .env        # then uncomment DEV_PORT_SERVER=3002
CALLBOARD_DATA_DIR=$HOME/.callboard-dev node bin/callboard.js set-password
npm run dev
```

The frontend runs at `http://localhost:3000` and the backend at `:3002`. Watch for two things:

- **Uncomment `DEV_PORT_SERVER`.** Vite proxies `/api` to 3002, but without this variable the dev backend binds `PORT` (8000) instead.
- **Dev has its own data directory.** `npm run dev` uses `~/.callboard-dev`, so the dev password hash lives there. That's why the `set-password` line above sets the directory. There's no auth bypass in dev.

| Command                                | What it does                                                              |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `npm run dev`                          | Frontend and backend dev servers against `~/.callboard-dev`               |
| `npm run build`                        | Build shared, computer-use, backend and frontend                          |
| `npm run clean`                        | Delete build output. Run it before `build` if you removed a `dist/` by hand, because `tsc -b` won't notice |
| `npm start`                            | Run the production build from `backend/dist`                              |
| `npm test` / `test:watch` / `test:coverage` | Vitest (`npm test` also runs the computer-use package's tests)       |
| `npm run lint` / `lint:fix`            | ESLint on **staged** files only. On a clean index this lints nothing      |
| `npm run lint:all` / `lint:all:fix`    | ESLint on the whole tree                                                  |
| `npm run prettier`                     | Format changed and staged files                                           |
| `npm run swagger`                      | Regenerate `backend/swagger.json`, which is served at `GET /api/docs`     |

### Layout

```
frontend/            React UI (Vite)
backend/src/
  routes/            HTTP and SSE endpoints
  services/          Domain logic, stores, MCP tool servers
  agents/            One adapter per engine behind a common provider port
  scaffold/          Files copied into new agent workspaces
shared/              Types used by both ends
packages/computer-use/  Browser/desktop control library and MCP server
bin/                 The `callboard` CLI
scripts/             Build and release helpers
plans/               Design records
```

Contributor conventions (the wire-compatibility rules for `shared/types/stream.ts`, `cwd` vs `workspaceId` keying, theming) are in [`.claude/CLAUDE.md`](.claude/CLAUDE.md).

Stack: React 18, React Router 6, Express 4, TypeScript 5, Vite 5, Zod 4, Winston, Vitest. Engines come from `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@cline/sdk`, `@earendil-works/pi-coding-agent` and `@agentclientprotocol/sdk`. Connections come from `@wolpertingerlabs/drawlatch`.

## License

MIT
