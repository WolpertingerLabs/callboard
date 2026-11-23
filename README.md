# Callboard

A browser control panel for coding agents. Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Codex or pi from a web UI instead of a terminal.

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

Each chat runs on one of three engines. You pick the engine per chat and set each engine's defaults on its tab under **Settings → API**. The **OpenRouter** tab there isn't an engine. It holds the account-wide OpenRouter key and base URL, used for the OpenRouter model catalog and, when **Use OpenRouter for chat titles, branch names and themes** is ticked, for those one-shot completions. Otherwise they run on Claude Code. The same key powers composer voice input and message read-aloud: its **Voice input** section picks the transcription model (default `openai/whisper-large-v3-turbo`), and its **Read aloud** section picks the speech model and voice (default `hexgrad/kokoro-82m`, voice `af_heart`).

| Engine          | How it runs                                                                                                | Must you install it? | Sign-in                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------- |
| **Claude Code** | Bundled Agent SDK; prefers a `claude` binary if it finds one                                               | No (recommended)     | `claude auth login`, or an API key in Settings → API |
| **Codex**       | Bundled `codex` binary                                                                                     | Only to log in       | `codex login`, or an OpenAI key in Settings → API    |
| **pi**          | In-process library                                                                                         | No                   | A provider key in Settings → API                     |

Bundled engines are npm dependencies of Callboard, so updating Callboard updates them. A global install of the same package has no effect, because Node resolves Callboard's own copy first.

### Claude Code

Callboard uses the first `claude` it finds, checking in this order:

1. **Binary path** under Settings → API → Claude (`pathToClaudeCodeExecutable`)
2. the `CLAUDE_BINARY` environment variable (it must answer `--version` as Claude Code)
3. `which claude`
4. `~/.local/bin`, `~/.claude/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`

If none of these resolve, the Agent SDK's bundled binary runs. That binary is an optional dependency, so it's missing if you installed with `--omit=optional`. The engine's status card shows which path is in effect and which step found it.

Installing the CLI is the only way to use a Claude subscription:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

To use an API key or a gateway token, set it under **Settings → API → Claude** instead. The "Claude Code Needs Credentials" dialog appears only when Callboard finds no credential at all.

### Codex

The bundled `codex` binary is always available. What varies is the sign-in:

- **ChatGPT subscription:** install the CLI and run `npm install -g @openai/codex && codex login`. This writes `auth.json` under your `$CODEX_HOME` (default `~/.codex`). Callboard reads it from the **Codex Home** setting under Settings → API → Codex, which defaults to `~/.codex` and is passed to every Codex run as `CODEX_HOME`, so set it if your CLI uses a different directory. Chats still run on the bundled binary.
- **API key:** switch the auth mode under **Settings → API → Codex** and paste an OpenAI key.

To run a different `codex`, set **Binary path** (`codexPathOverride`); if you installed the CLI globally, `which codex` prints the path. This field does no `PATH` search: chats use either the path you set or the bundled copy. Callboard parses Codex's undocumented rollout files, so a far-off version can render transcripts with missing turns. When the version in effect differs from the one the parser targets, the status card shows a **Compatibility** row.

### pi

pi runs inside the Callboard process, with no binary. Pick a provider and add its key under its tab in Settings → API; the provider defaults to `openrouter`. A key set in Settings overrides the environment. Callboard never writes pi's auth file.

- pi's prompt-cache warming is always off in Callboard, whatever pi's own settings say. Warm-up requests are billed, and Callboard would not count them in a chat's cost.
- On OpenRouter, a chat's cost is the amount OpenRouter reports it billed. Other providers show pi's estimate from its model catalog.
- pi 1.5 no longer lets reasoning be turned off for `openai/o3`. A pi o3 chat saved with effort "none" is refused until you pick another effort or clear it.
- pi 1.5 renamed its Azure OpenAI provider from `azure-openai-responses` to `azure`. If your pi provider is set to the old id, change it under Settings → API → pi.

The Cline engine has been removed. Chats that ran on it still appear (with a **CL** badge) when opened by link, but can't be continued or forked. Their transcripts are left untouched under `cline-sessions/` in the data directory.

The OpenCode engine (Callboard's Agent Client Protocol harness) has been removed too. Chats that ran on OpenCode show a removed **OC** badge and open read-only; `acp-sessions/` in the data directory is left on disk, and OpenCode's own data is never touched.

### Binary path fields

The Claude Code and Codex **Binary path** fields only accept a path that is absolute, exists, is a regular file, and is executable by the daemon's user. If the path fails a check, Callboard ignores it and the card explains why. Changes apply to the next chat.

Only a browser on the same machine or LAN can change these fields, because they decide what the daemon executes. A client on [remote access](#remote-access) (Tailscale, a VPN or a reverse proxy) can see them but not change them.

### After you install or sign in

Callboard caches binary lookups and Claude account info for the life of the daemon. After you install a CLI or log in, press **Recheck** on the engine's card. It re-probes at most once every 10 seconds.

Recheck can't fix a stale `PATH`. You need `callboard restart`, run from a terminal where the command works, when:

- a vendor install script (`claude.ai/install.sh` → `~/.local/bin`) added its directory to `PATH` through your shell rc file
- you installed under a different nvm Node version than the one running Callboard

If `npm install -g` fails with `EACCES`, npm's global prefix isn't writable. Point it somewhere you own (`npm config set prefix ~/.npm-global`) and put that `bin/` on your `PATH`.

### The Install button

The engine cards for `claude` and Codex have an **Install** button. It runs `npm install -g` from a fixed list of packages, without a shell, and then re-probes. The button only appears when all of these hold:

- the browser is on the same machine or LAN
- npm's global prefix is writable
- the host isn't Windows

To turn the button off, set `allowEngineInstalls: false` in `~/.callboard/agent-settings.json`, or use the toggle on the Remote Access page. Callboard never runs `curl … | bash` installers for you.

## Features

### In a chat

- **Streaming:** text, thinking, tool calls and permission prompts, on any engine.
- **Tool permissions:** set `allow`, `ask` or `deny` per chat on six axes: file read, file write, code execution, web access, Browser Use and Computer Use.
- **Images:** drag in PNG, JPEG, GIF or WebP files, up to 10 MB each.
- **Branches and worktrees:** pick a base branch, name a new branch (or generate a name from the prompt), and optionally run the chat in its own worktree.
- **Diffs:** view the chat's working-tree diff file by file.
- **Slash commands:** autocomplete covers your project's and plugins' commands. The chosen command becomes a chip in the composer.
- **`$keyword` snippets:** saved under Settings → Keywords. Callboard expands them in the browser before sending.
- **Drafts:** save a message for an existing chat, or for a folder before its chat exists.
- **Held messages (API):** while a chat is running, `POST /api/chats/:id/held` holds a message until the current turn ends; the daemon then sends it as a normal message, with its attachments, even if no browser tab is open. Several held messages go out in order, one turn each. Stopping the run or restarting the daemon pauses them (`POST /api/chats/:id/held/resume` re-queues). On an idle chat the request is refused with `409 not_running`, so send normally. The held list is returned as `heldMessages` by `GET /api/chats/:id/activity`; the full routes are in `GET /api/docs`.
- **Forks:** branch off an earlier message into a new chat. The fork tree is browsable.
- **Read aloud:** the speaker in a message's hover row reads that one message aloud (code blocks are skipped). The player under it has play/pause, ±10 s, seeking and a 0.75–2× speed, which is remembered. It needs the OpenRouter key (see Engines above).
- **Model and effort:** switch the model mid-chat, and set the reasoning effort on engines that support it.
- **Rendered output:** agents can show images, audio, video and PDFs inline, plus versioned HTML/SVG canvases that they update in place.

### Around the work

- **Cards and the board:** every top-level chat is a card, along with everything spawned from it (child chats and job runs). The board groups cards under **Needs you**, **Running** and **Idle**, with sub-headings for each card's category. Agents can read and edit the title, description, emoji, status, category and metadata of their own card.
- **Spaces:** separate areas of work, such as _Work_, _Personal_ or _Research_. Every chat belongs to one space, together with everything spawned from it. The sidebar, the board, search and the agents' chat tools (`search_chats`, `list_cards`, `get_chat_tree`) show only the active space, unless an agent passes `space: "all"`. Switch spaces at the top of the sidebar, or choose **All spaces** to see every chat with a space chip. A chat that needs you stays visible from any space: the board's **Needs you** column includes it, and the switcher shows a count for each space. Each space can have folder rules (`~/work/**`) that place new and discovered chats, its own new-chat defaults, instructions added to its chats' system prompt, and a limited set of plugins and custom skills. Manage spaces under Settings → Spaces. The active space is in the URL as `?space=<id>|all`, and spaces are stored in `~/.callboard/spaces/`.
- **Workspaces:** a workspace is a `cwd` plus its git isolation. Callboard records one when a chat starts in a worktree. Agents manage workspaces with MCP tools (`list_workspaces`, `create_workspace`, `rename_workspace`, `archive_workspace`, `list_unmanaged_worktrees`, `adopt_worktrees`). Archiving moves a clean, Callboard-owned worktree into `~/.callboard/trash` for 30 days, and each entry includes a restore recipe.
- **Jobs:** deterministic multi-step workflows. Step types are `agent`, `approval`, `poll`, `wait_event`, `gate`, `notify`, `parallel` and nested `job`. You can pause, resume and cancel a run, or retry a failed step, and runs survive a restart. Build jobs under Settings → Jobs, or import and export them as JSON.
- **Storage:** a key-based blob store, managed under Settings → Storage and with the `*_storage_*` tools.
- **Artifacts:** named, versioned HTML, SVG or markdown documents (the last 50 versions are kept). Agents save them with `save_artifact` and show them with `render_artifact`. Each artifact declares the most storage access it may have (`none`, `read` or `readwrite`); the storage key itself is chosen when it's rendered. Manage them under Settings → Artifacts. Each artifact also opens full-window at `/a/<id>?key=<storage-key>`.
- **Custom skills:** skills you write under Settings → Skills are saved to `~/.callboard/custom-skills/skills/<name>/SKILL.md` and invoked as `callboard:<name>`.
- **Model aliases:** one name, such as `planner`, that maps to a different model per engine. Aliases work anywhere a model is set.
- **Plugins & MCP:** Callboard scans directories you register for Claude Code plugin marketplaces and picks up their commands, hooks and MCP servers. Plugins are toggled per directory.
- **Themes:** every UI colour is a CSS variable, with light and dark sets. Custom themes are files in `~/.callboard/themes/`, and an agent can generate one for you.
- **API keys:** mint `cbk_` bearer tokens under Settings → Account for scripts. These keys can't perform human-only actions: minting more keys, changing a chat's Browser Use or Computer Use setting or answering its prompts, changing settings (they can read them, with credentials masked), restarting the server or changing the password.

### Browser & Computer Use (preview)

This lets an agent drive a managed Chromium browser, or a Linux X11 desktop, **on the machine running Callboard**. It is off unless you turn it on. Agents with unrestricted code execution may still run their own automation.

- **Permissions:** two axes, one per target. Both default to **Deny**, and new child chats, job steps, agent sessions and Read only asides start with both denied. Set them in the chat's permission dialog.
  - **Browser Use** governs the managed browser. It needs no other axis: Web Access doesn't have to be Allow. The browser's network access is unrestricted, and Callboard treats Browser Use as the explicit opt-in to that, independent of Web Access (which governs only the agent's own web tools). If Web Access restrictions must also cover the browser, confine it on the host or leave Browser Use denied.
  - **Computer Use** governs the desktop. It also needs every other axis on **Allow**, including Browser Use, because a desktop session can open any app, a browser among them, and can't honour a narrower restriction.
- **Existing chats:** chats created before Browser Use existed read it as **Deny**. A chat that had Browser & Computer Control on Ask or Allow keeps that level as Computer Use, but loses the browser until you set Browser Use, and loses the desktop until Browser Use is Allow. A chat with Web Access on Deny or Ask can now browse if Browser Use is on. Saved defaults (new-chat defaults in the browser and space defaults) migrate the same way: a saved Browser & Computer Control on Ask or Allow now means Computer Use on and Browser Use off. A tab still running an older bundle can turn its old row off (that also denies Browser Use) but can't turn it on; it's asked to reload.
- **Enabling a target is always a human action.** The agent can call `cu_request_control` to put an **Enable browser control** or **Enable desktop control** card in the chat. You can also enable a target from the Computer view, which you open with the monitor icon (**Show computer control**) in the chat header. The agent can't grant itself access.
- **Ask vs Allow** (per target, from its own axis): under **Ask**, every GUI action needs your approval in the chat first. Under **Allow**, the agent acts unattended and each action is written to the server log.
- **Requests wait for you, without holding the agent.** An enable card stays open until you answer it. An action card stays open until you answer it or its session ends; sessions last up to 15 minutes. The agent's tool call returns straight away, and your answer is sent to the chat as a message. That message starts a new turn if the chat is idle, or waits for the current turn to finish. While a card is open you can keep typing, and the agent can still ask you other questions. Sending a message doesn't withdraw a card.
- **The agent can't change a card you're looking at.** While an action waits for your approval, the agent can't capture a new screenshot or request another action. Before an approved action runs, Callboard checks that the screenshot it was aimed at is still the current one. That screenshot can be minutes old, so check the live Computer view before you confirm. If you've taken over in the meantime, or the page changed, the action is skipped and the agent is told to look again.
- **Who can answer, and what withdraws a card:** only a signed-in browser can answer these cards. API keys and parent chats can't. **Deny** is an answer, not a withdrawal: the agent is told straight away, in a new turn if the chat is idle. These withdraw an open card: the chat's **Stop** button (while a run is going), **Stop computer control**, Stop or Revoke in the Computer view, taking over the session, a change to the chat's permissions, the session ending, archiving or deleting the chat, and rewinding, forking or compressing it. A withdrawal doesn't start a turn. The agent is told about it at the start of its next turn, in a marked notice at the top of that turn's message. If you answer a card that was already withdrawn, the chat tells you why.
- **Subagents share the grant.** Claude Code Task subagents and Codex native subagents act as the parent chat.
- **Stop computer control** in the chat header stops every session in the chat. Take over before you type or click yourself, and choose **Resume agent** to hand control back. Images already sent to a model can't be recalled.
- If a tab is running an older Callboard bundle, it shows **Reload this Callboard tab** instead of an approval card.

Set up the host first:

- **Browser:** Playwright installs with Callboard as an optional dependency, but no browser is downloaded. Provide Chromium and its OS libraries, and set `CALLBOARD_BROWSER_EXECUTABLE=/absolute/path/to/chrome` if Playwright won't find it. Chromium's sandbox is mandatory. On Linux, run as a non-root user with sandbox support. The chat's Browser Use permission must be Ask or Allow.
- **Desktop:** only an existing Linux X11 session works. It needs `/usr/bin/xdotool`, ImageMagick's `/usr/bin/import`, and `CALLBOARD_NATIVE_DISPLAY` (or `DISPLAY`). Computer Use must be Ask or Allow and all five other permission axes (Browser Use included) must be Allow, because desktop control can reach everything the user can. This isn't an isolation boundary. macOS, Windows and Wayland aren't supported.
- **Desktop in a container (preview):** instead of this machine's display, the desktop target can be a hardened Linux desktop running in Docker. From a source checkout (the image builds from the repository, and `docker/` isn't in the published package), build and start it, then point Callboard at it:

  ```sh
  docker build -t callboard/computer-use-desktop:local -f packages/computer-use/docker/Dockerfile packages/computer-use
  packages/computer-use/docker/run.sh 7801   # prints the two variables below
  export CALLBOARD_REMOTE_DESKTOP_URL=http://127.0.0.1:7801
  export CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE=/tmp/callboard-desktop-XXXXXX/token   # the path run.sh printed
  ```

  `run.sh` builds the image only if it's missing. Set `COMPUTER_USE_DESKTOP_REBUILD=1` to rebuild it after pulling changes; `docker rmi callboard/computer-use-desktop:local` removes it.

  - **Token:** it's a file, not an environment variable, on both sides. `run.sh` writes a fresh one into a private temp directory and mounts it into the container read-only.
    - **Never sent:** Callboard never sends the token itself. The container first proves it holds the token, so a process that took the port after the container stopped learns nothing.
    - **Rotation:** `CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE` is read at each connection, so a rotated token is picked up.
    - **Symlinks:** it may be a symlink, as Kubernetes secrets and some credential stores are.
    - **The variable:** `CALLBOARD_REMOTE_DESKTOP_TOKEN` still works but is discouraged, because every child process of Callboard inherits it. An empty value counts as unset.
  - **Hardening:**
    - **Filesystem:** a read-only root, with tmpfs only for the desktop home and `/tmp`.
    - **Capabilities:** every capability dropped except the two the entrypoint needs to start the desktop and the driver as separate unprivileged users, plus `no-new-privileges` and no setuid programs.
    - **Limits:** pids, memory and CPU are capped. There is no Docker socket.
    - **Port:** published on `127.0.0.1` only.
    - **Network:** its own bridge network (`callboard-sandbox`) with inter-container traffic off, so other containers can't reach it.
  - **Configuration:** with the URL and a token set, the desktop target uses the container. With only one set, it reports itself unavailable rather than using the local display. Permissions and approvals work exactly as for the local desktop, and the panel names the target `remote 127.0.0.1:7801`. A container from an incompatible release is reported unavailable rather than used.
  - **Network exposure, both ways:**
    - **Inbound:** keep the port on `127.0.0.1`. It grants full control of that desktop, so reach it from another machine only through a TLS proxy that authenticates. Callboard refuses plain `http` to anything but loopback.
    - **Outbound:** the container *can* reach this machine through the Docker bridge gateway (for example `172.17.0.1`). Any service listening on all interfaces is reachable from the desktop, and Docker flags can't prevent that. That includes Callboard itself, which listens on every interface. Bind host services to `127.0.0.1` where you can, or firewall the Docker bridge on the host. The desktop can also reach the internet.

  These variables are a stopgap: a separate Sandbox target with its own permission, and containers Callboard starts itself, are planned. See [Sandbox desktop container](packages/computer-use/README.md#sandbox-desktop-container) for the flags, the image, the handshake and protocol versioning.

Live sandboxed-browser use hasn't been qualified yet. The X11 driver has been qualified only against Xvfb in that container. For the security model and limits, see [`packages/computer-use/README.md`](packages/computer-use/README.md).

## Agents

An agent is a named identity with its own workspace, memory, schedule and triggers, created from the **Agents** page. Its identity (name, emoji, role, personality, tone, pronouns, guidelines) and what it knows about you (name, timezone, location) are compiled into a system-prompt append. You can inspect that append section by section, with token estimates, on the agent's dashboard.

Each agent gets:

- **A workspace** at `~/.callboard/agent-workspaces/<alias>/`, seeded with `CLAUDE.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md` and `MEMORY.md`.
- **Two-tier memory:** daily journals in `memory/YYYY-MM-DD.md`, plus a curated `MEMORY.md`. Every session preloads `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, today's journal and yesterday's journal. Yesterday's journal is capped by the **journal budget** on the Memory tab, which defaults to 16k tokens. A capped journal keeps its tail and includes a note telling the agent to read the full file.
- **Permissions:** the four original axes default to allow, and Browser Use and Computer Use are denied.
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

  Enrolled callers are listed on the same page with their fingerprints and bound agents, and can be deleted there.

### Audit log

Callboard ships a record of every model safety review to Drawlatch's `ingest_logs` tool (OTLP log data model, JSON encoding): `permission.review.requested` when a screen takes a permission ask, and `permission.review.result` with the verdict and what happened next. The two share a trace id. Records go out as the chat's own caller (an agent's caller, else the default caller), in batches about once a second. Drawlatch stores them append-only, so an agent on this machine can add records but cannot erase or rewrite ones already sent. Lost records (queue overflow, a hub that stayed down, records the hub rejected) are counted and reported in a `callboard.audit.dropped` record on the next batch. Records still queued in memory when Callboard dies are lost.

An older Drawlatch without `ingest_logs` disables the audit log for that caller and re-probes every 10 minutes. Set `CALLBOARD_AUDIT_LOG=off` to turn it off. It is on whenever a proxy is configured, and no agent-facing tool can reach `ingest_logs`.

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
callboard help
callboard -v                  Version
```

Every subcommand accepts `--help`. The first run creates `~/.callboard/.env`.

## Configuration

Callboard reads `~/.callboard/.env`. If the package root also has a `.env`, its values override the first file. `callboard config` prints the merged result.

| Variable                           | Default                                | Purpose                                                                                  |
| ---------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`                             | `8000`                                 | Server port                                                                              |
| `LOG_LEVEL`                        | `info`                                 | `error`, `warn`, `info`, `debug`. Process environment only (see below)                   |
| `SESSION_COOKIE_NAME`              | `callboard_session`                    | Change to avoid cookie collisions on localhost. Process environment only                 |
| `AUTH_PASSWORD_HASH` / `_SALT`     | —                                      | Written by `callboard set-password`; don't edit by hand                                  |
| `INSTANCE_NAME`                    | generated                              | Friendly instance name                                                                   |
| `CALLBOARD_DATA_DIR`               | `~/.callboard`                         | All stored data. Process environment only                                                |
| `CALLBOARD_WORKSPACES_DIR`         | `$CALLBOARD_DATA_DIR/agent-workspaces` | Where agent workspaces live. Process environment only                                    |
| `CALLBOARD_MAX_BACKGROUND_HOLD_MS` | `900000` (15 min)                      | How long a finished turn waits on its backgrounded shell tasks. Process environment only |
| `CALLBOARD_AUDIT_LOG`              | on                                     | `off` (or `0`/`false`) stops shipping review records to Drawlatch (see Audit log)        |

Variables marked **process environment only** must be set in the daemon's environment (for example `SESSION_COOKIE_NAME=x callboard start`); a value in `.env` is ignored. `CALLBOARD_DATA_DIR` decides which `.env` is read, so it can't be set inside one. The others are read while the server's modules load, before `.env` is applied. The data directory holds everything: chats, agents, jobs, workspaces, storage, artifacts, settings (`agent-settings.json`), API keys, themes, logs and the PID file.

## Remote access

Callboard doesn't expose itself to the internet. To reach it from your phone or another machine, put both devices on [Tailscale](https://tailscale.com/) (or another VPN or private network) and open `http://<host's tailnet address>:8000`. Running `tailscale serve` in front of the daemon port works too, and gives you HTTPS.

Browsers only allow microphone access on HTTPS or `localhost`, so composer voice input is unavailable over plain `http://<tailnet address>:8000`. Use `tailscale serve` (HTTPS) or open Callboard on the host itself. Read aloud plays over plain HTTP; only the mic needs HTTPS.

> ⚠️ Anyone who can reach the port can reach the login page, and the password (`callboard set-password`) is what protects your sessions, files and connected services. Use a strong, unique one, and keep the port off the public internet.

**Settings → Remote Access** has an optional **IP allowlist** (addresses or CIDR ranges) that refuses every other remote client before it reaches the login page. Browsers on the same machine or the LAN that connect directly are always allowed. Tailscale addresses (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`) are not treated as LAN, so if you set a list, add your devices or both of those ranges. Remote clients, Tailscale included, can't change binary paths or use the Install button.

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

- **Uncomment `DEV_PORT_SERVER`.** Vite proxies `/api` to 3002, but without this variable the dev backend binds `PORT` (8000) instead. Set `DEV_PORT_UI` too if 3000 is taken.
- **Dev has its own data directory.** `npm run dev` uses `~/.callboard-dev`, so the dev password hash lives there. That's why the `set-password` line above sets the directory. There's no auth bypass in dev.

| Command                                     | What it does                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run dev`                               | Frontend and backend dev servers against `~/.callboard-dev`                                                |
| `npm run build`                             | Build shared, computer-use, backend and frontend                                                           |
| `npm run clean`                             | Delete build output. Run it before `build` if you removed a `dist/` by hand, because `tsc -b` won't notice |
| `npm start`                                 | Run the production build from `backend/dist`                                                               |
| `npm test` / `test:watch` / `test:coverage` | Vitest (`npm test` also runs the computer-use package's tests)                                             |
| `npm run lint` / `lint:fix`                 | ESLint on **staged** files only. On a clean index this lints nothing                                       |
| `npm run lint:all` / `lint:all:fix`         | ESLint on the whole tree                                                                                   |
| `npm run prettier`                          | Format changed and staged files                                                                            |
| `npm run swagger`                           | Regenerate `backend/swagger.json`, which is served at `GET /api/docs`                                      |

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

Stack: React 18, React Router 6, Express 4, TypeScript 5, Vite 5, Zod 4, Winston, Vitest. Engines come from `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` and `@earendil-works/pi-coding-agent`. Connections come from `@wolpertingerlabs/drawlatch`.

## License

MIT
