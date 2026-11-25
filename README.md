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
- **API keys:** mint `cbk_` bearer tokens under Settings → Account for scripts. These keys can't perform human-only actions: minting more keys, changing a chat's Browser Use, Sandbox desktop or Computer Use setting or answering its prompts, changing settings (they can read them, with credentials masked), restarting the server or changing the password.

### Browser, Sandbox & Computer Use (preview)

This lets an agent drive a managed Chromium browser or a Linux X11 desktop **on the machine running Callboard**, or a **Sandbox desktop**: a Linux desktop in a hardened Docker container, isolated from this machine's files and credentials. By default Callboard starts a fresh container for each session and removes it at the end, after copying out the files the agent left in `~/outbox`; you can instead point Callboard at one container you run yourself. It is off unless you turn it on. Agents with unrestricted code execution may still run their own automation.

- **Permissions:** three axes, one per target. All three default to **Deny**, and new child chats, job steps, agent sessions and Read only asides start with all three denied. Set them in the chat's permission dialog, or as defaults under Settings. None of them inherits from another: a chat created before an axis existed reads it as **Deny**.
  - **Browser Use** governs the managed browser. It needs no other axis: Web Access doesn't have to be Allow. The browser's network access is unrestricted, and Callboard treats Browser Use as the explicit opt-in to that, independent of Web Access (which governs only the agent's own web tools). If Web Access restrictions must also cover the browser, confine it on the host or leave Browser Use denied.
  - **Sandbox desktop** governs the container desktop. It needs no other axis, because the container is the boundary: nothing of this machine is mounted into it (no files, no credentials, no Docker socket). Its outbound network is unrestricted by default (Settings → Sandbox desktop can turn internet access off for managed containers), and, as with Browser Use, turning Sandbox desktop on is the opt-in to that. That includes this machine: code in the sandbox can reach any service here that listens on all interfaces, Callboard included, in either network setting, so bind those to `127.0.0.1` or firewall the Docker bridge (see **Sandbox desktop** under setup below). Use it for desktop apps and downloads that should stay off this machine. What it keeps depends on the mode: a **managed** sandbox (the default) is a fresh container per session, removed with everything in it when the session ends, once the files in `~/outbox` are copied to this machine, so nothing in it carries over to another session. An **endpoint** sandbox (one you run yourself) isn't fresh per session: everything an agent leaves there is visible to later sessions and other chats until you restart the container, so it isn't a place for work you wouldn't let them share.
  - **Computer Use** governs this machine's desktop. It also needs the four built-in axes and Browser Use on **Allow**, because a desktop session can open any app, a browser among them, and can't honour a narrower restriction. It doesn't need Sandbox desktop: the sandbox reaches less than your desktop already does.
- **Existing chats:** chats created before Browser Use existed read it as **Deny**. A chat that had Browser & Computer Control on Ask or Allow keeps that level as Computer Use, but loses the browser until you set Browser Use, and loses the desktop until Browser Use is Allow. A chat with Web Access on Deny or Ask can now browse if Browser Use is on. Saved defaults (new-chat defaults in the browser and space defaults) migrate the same way: a saved Browser & Computer Control on Ask or Allow now means Computer Use on and Browser Use off. A tab still running an older bundle can turn its old row off (that also denies Browser Use) but can't turn it on; it's asked to reload.
- **Enabling a target is always a human action.** The agent can call `cu_request_control` to put an **Enable browser control**, **Enable Sandbox desktop control** or **Enable desktop control** card in the chat. You can also enable a target from the Computer view, which you open with the monitor icon (**Show computer control**) in the chat header. The agent can't grant itself access.
- **Ask vs Allow** (per target, from its own axis): under **Ask**, every GUI action needs your approval in the chat first. Under **Allow**, the agent acts unattended and each action is written to the server log.
- **Requests wait for you, without holding the agent.** An enable card stays open until you answer it. An action card stays open until you answer it or its session ends; sessions last up to 15 minutes (a Sandbox desktop profile sets its own length). The agent's tool call returns straight away, and your answer is sent to the chat as a message. That message starts a new turn if the chat is idle, or waits for the current turn to finish. While a card is open you can keep typing, and the agent can still ask you other questions. Sending a message doesn't withdraw a card.
- **The agent can't change a card you're looking at.** While an action waits for your approval, the agent can't capture a new screenshot or request another action. Before an approved action runs, Callboard checks that the screenshot it was aimed at is still the current one. That screenshot can be minutes old, so check the live Computer view before you confirm. If you've taken over in the meantime, or the page changed, the action is skipped and the agent is told to look again.
- **Who can answer, and what withdraws a card:** only a signed-in browser can answer these cards. API keys and parent chats can't. **Deny** is an answer, not a withdrawal: the agent is told straight away, in a new turn if the chat is idle. These withdraw an open card: the chat's **Stop** button (while a run is going), **Stop computer control**, Stop or Revoke in the Computer view, taking over the session, a change to the chat's permissions, the session ending, archiving or deleting the chat, and rewinding, forking or compressing it. A withdrawal doesn't start a turn. The agent is told about it at the start of its next turn, in a marked notice at the top of that turn's message. If you answer a card that was already withdrawn, the chat tells you why.
- **Subagents share the grant.** Claude Code Task subagents and Codex native subagents act as the parent chat.
- **Stop computer control** in the chat header stops every session in the chat. Take over before you type or click yourself, and choose **Resume agent** to hand control back. Images already sent to a model can't be recalled.
- If a tab is running an older Callboard bundle, it shows **Reload this Callboard tab** instead of an approval card. A tab from before the Sandbox desktop isn't offered the sandbox: Callboard leaves its Enable out of that tab's Computer view and replaces its cards with the reload notice, but still lists a running sandbox session (as a desktop session labelled `sandbox …`) so that tab's **Stop computer control** stops it. The other way round, a current tab talking to an older Callboard (after a rollback) still shows the Sandbox desktop permission row, but that Callboard doesn't store it, so it reads back as **Deny** and grants nothing.

Set up the host first:

- **Browser:** Playwright installs with Callboard as an optional dependency, but no browser is downloaded. Provide Chromium and its OS libraries, and set `CALLBOARD_BROWSER_EXECUTABLE=/absolute/path/to/chrome` if Playwright won't find it. Chromium's sandbox is mandatory. On Linux, run as a non-root user with sandbox support. The chat's Browser Use permission must be Ask or Allow.
- **Desktop:** only an existing Linux X11 session works. It needs `/usr/bin/xdotool`, ImageMagick's `/usr/bin/import`, and `CALLBOARD_NATIVE_DISPLAY` (or `DISPLAY`). Computer Use must be Ask or Allow and all five other permission axes (Browser Use included) must be Allow, because desktop control can reach everything the user can. This isn't an isolation boundary. macOS, Windows and Wayland aren't supported.
- **Sandbox desktop (preview):** a hardened Linux desktop in Docker, as its own target. Callboard starts **one container per session** on the local Docker and removes it when the session ends. It isn't this machine's desktop, but it isn't sealed off from this machine either: code in the sandbox can reach services on this machine that listen on all interfaces, Callboard included (see **Network exposure** below).

  Build the image once, on the machine running Callboard (an npm install works: the Docker context ships with it):

  ```sh
  callboard sandbox build      # docker build of callboard/computer-use-desktop:local (and its builder stage); skipped if it's up to date
  callboard sandbox status     # Docker, the image and its protocol, running managed sandboxes
  ```

  Then turn **Sandbox desktop** on in a chat's permissions and enable it there (or let the agent ask with `cu_request_control`). That's all: there's nothing to start or point Callboard at. **Settings → Sandbox desktop** has a **Build image** button too, and shows the same diagnostics. Callboard never builds or pulls the image on its own.

  - **Updates:** the image carries a digest of the files it was built from (`dev.callboard.computer-use.content`). After you update Callboard, an image built from older files shows as **out of date** in Settings, `callboard sandbox status` and the Computer view, because it may lack driver-host fixes. Run `callboard sandbox build` again (it rebuilds an out-of-date image without `--force`). An out-of-date image still starts. Two kinds are refused until rebuilt:
    - one built for another protocol version;
    - one below the image security floor (`dev.callboard.computer-use.security-floor`), shown as **known security issue — rebuild**. The floor is raised only when a release fixes a security issue in the sandbox image.

    `run.sh` labels its builds the same way. A plain `docker build` of the Dockerfile doesn't set the content label, so its image shows as out of date (it still starts); build with `callboard sandbox build` instead.

  - **Lifecycle:** on Enable, after your consent, Callboard checks Docker, prepares the sandbox network, checks the image and its protocol label, writes a fresh token file, runs the container, waits for it to answer (bounded) and opens the session on it. The Computer view shows each step while it starts, then **Ready**, then **Stopping** and **Removed**. It removes the container and its token when the session ends, however it ends: Stop, Revoke, the session's time limit (15 minutes, or a profile's own), a permission change, archiving or deleting the chat, a mode change or Callboard shutting down. Anything a crash leaves behind is removed at the next startup and every few minutes after that, while managed mode is on or leftovers remain.
  - **Stopping Callboard:** `callboard stop` and `restart` wait up to 45 seconds before killing the daemon, so running sandboxes can be removed cleanly; a daemon with no sandboxes stops at once. Each session's metadata sits beside its token, so if the daemon is killed anyway, the next start finds the container, copies out of it the same way and then removes it. The same 30-second step before removal copies the sandbox's files out (see **Deliverables** below), all sandboxes in parallel, on a clean stop and after a crash alike; a sandbox whose copy fails is kept for recovery instead of removed.
  - **Deliverables (`~/outbox`):** the one way files leave a sandbox. Inside the desktop, save a file to `~/outbox` (`/home/desktop/outbox`) by writing it as `~/outbox/.NAME.part` and then renaming it to its final name. Only plain names are picked up (letters, digits, `.`, `_`, `-`; no spaces or subfolders), so the hidden `.part` file is never copied half-written. Agents are told this in their tool descriptions; it works the same if you save something there yourself.
    - **Sync:** while the session runs, Callboard checks the outbox every few seconds (backing off to 30 s when nothing changes) and copies each finished file to this machine, verified by its SHA-256. A file still changing is left for the next check. When the session ends it copies once more, gives files still being written a few seconds to settle, and checks that every listed file arrived with a matching digest.
    - **Where:** `<data dir>/sandbox-deliverables/<workspace or folder key>/<chat id>/<session id>/files/`, never in your project. The key is a hash of the chat's workspace (or, for a chat without one, its folder). Directories are `0700` and files `0600`. Each file is written to a temporary file and published with an exclusive link, so nothing is overwritten and symlinks are never followed. A file that changes after it was copied is stored again as `name (2).ext`, `name (3).ext`, …; the earlier copy stays as it was.
    - **In the chat:** a small **Delivered from Sandbox desktop** group at the end of the transcript shows each file as a file card (images, audio, video and PDFs inline, behind the untrusted-content gate). These cards only show a chat's own deliverables (and, read-through, those of the chats its history was copied from; see **Continue, Rerun, Compress, forks and asides** below). This isn't access control: `chat=` is supplied by the caller, and anyone signed in can already fetch any path through `/api/files/serve`. The agent gets the same list, with each file's path on this machine, from `cu_stop` and `cu_status`, so it can read them if it has file-read permission.
    - **Limits:** 64 MiB per file, 256 MiB and 100 files per session (every version counts). A file over a limit isn't copied; the chat and the agent are told which file and why. That alone doesn't keep the container.
    - **Disk:** all chats' deliverables together may use at most **Deliverables storage** (Settings → Sandbox desktop; 5 GiB by default, 1–1024). Past it, new files are refused and the chat says so (`over the disk limit`); nothing already delivered is deleted to make room. Each download reserves its size against the limit before it starts, and is checked again at the size that actually arrived, so concurrent sessions, or a host misreporting sizes, can't go over it. Deleting chats frees their space. A file that is refused keeps the reason it was first refused for.
    - **Kept for recovery:** if the final copy fails or times out (it gets 25 s, inside the 30-second drain step), the container isn't removed. That holds whether the session ended, Callboard was shutting down, or the reaper found the container after a crash. Callboard pauses it (`docker pause`, not `docker stop`: the outbox lives in the container's memory-backed home, which stopping would erase) and keeps it, with its token, for **Keep for recovery** hours counted from when it was kept (Settings → Sandbox desktop; 24 by default, 1–168). The chat says so, with **Retry export** (unpause, reconnect to the same instance, copy, then remove; a container that restarted in the meantime has lost its files and is removed) and **Discard** (remove now).
      - **Cap:** at most **Kept at once** containers are kept across all chats (2 by default, 0–8; 0 never keeps one). This is separate from **Sandboxes at once**: a paused container uses no CPU, so it doesn't take a running slot, but it still holds its memory. Past the cap a failed copy is removed, and the chat says so.
      - **Restarts:** whether a container is kept is recorded in its session's `session.json`, beside its token, so a restart of Callboard finds it kept (the Computer view shows **Kept**). No reaper pass drains, removes or deletes a kept container. Callboard releases it after a successful **Retry export**, on **Discard**, when its retention ends, when its container is gone, or when its chat is deleted. A container left paused but not yet recorded as kept (the daemon was killed in between) is adopted as kept on the next start, if its chat still exists and there is room under the cap.
      - **Losses:** a paused container doesn't survive a restart of Docker or of this machine; the chat then reports what it held as gone.
    - **Continue, Rerun, Compress, forks and asides:** a chat whose history was copied from another also shows that chat's deliverables, up to the point it was copied. For **Continue from**, **Rerun** and **Compress** that is the original's cutoff; for a fork, aside or engine switch it is the message it branched off. So the files keep showing in the new chat, and the file cards in its copied history keep loading; a file the original received after that point neither shows nor loads there. Only chats made by **Fork**, **Ask as aside**, an engine switch from the chat menu, or **Continue from**/**Rerun**/**Compress** read through: those are the only ways a chat's history is copied, and they record the copy point. A child an agent or an API key starts (`start_chat_session`, or `POST /api/chats/new/message` with `parentChatId`) reads through nothing, whatever role label it is given. Nothing is moved or copied: the files stay where they were delivered. The successor of a **Continue from**/**Rerun**/**Compress** also lists the hidden original's kept sandboxes, and can retry or discard them; a fork can't act on its parent's.
    - **Deleted chats:** deleting a chat discards its kept sandboxes at once, and nothing more is written for it. Its deliverables are deleted as soon as no surviving chat shows them. Deleting a hidden original, or a fork's parent, keeps its files while the successor or fork survives; deleting that last chat deletes them too. So does anything else that leaves them shown by no chat (detaching the fork, for example): a deleted chat whose files were kept is recorded as deleted, and a sweep after each reaper pass, and after every detach, removes them once nothing shows them. A session whose chat no longer exists when it ends (most often a container the reaper finds after a crash) isn't copied at all; its outbox goes with the container, and the log records that.
    - **Endpoint mode:** the outbox is synced and copied at the end of the session the same way, but nothing is ever removed, paused or kept: the container is yours. Its outbox is shared, so a session is only given files that are new or changed since it started, and the files stay in the outbox afterwards.
  - **Ownership:** every container is labelled `dev.callboard.managed=1`, with its chat, its session and an **owner** derived from Callboard's data directory. A dev server (`~/.callboard-dev`) and production (`~/.callboard`) on one Docker daemon each see, count and remove only their own containers, and never touch a container without these labels.
  - **Modes** (Settings → Sandbox desktop):
    - **Automatic** (the default): **endpoint** if `CALLBOARD_SANDBOX_DESKTOP_URL` is set, so a setup from before managed mode keeps working; otherwise **managed**. Until Docker and the image are ready it shows as off, with the step to take.
    - **Managed:** local Docker, as above.
    - **Endpoint:** a container you run yourself (below).
    - **Off.**

    Changing the mode ends any live sandbox session.
  - **Limits:** 1 CPU and 1024 MiB per sandbox, and 2 sandboxes at once across all chats, by default. Each is adjustable within bounds (0.5–8 CPUs, 512–16384 MiB, 1–8 at once). Past the cap, enabling is refused with a message saying so. Limits and the network setting apply to sandboxes started after you save; running ones keep theirs. Pids are capped at 256.
  - **Profiles:** the base desktop is deliberately bare: a terminal, no way to install packages, no OpenGL, 1 CPU, 1 GiB, a 512 MiB home and 15 minutes. A **profile** is a pre-built image for one purpose, built once from a recipe and started fresh for every session, with exactly the base desktop's run-time hardening; only its resources differ. Two ship with Callboard: **`blender`** (Blender 4.5 LTS from blender.org with software OpenGL: 4 CPUs, 4 GiB, a 2 GiB home, 60-minute sessions) and **`test`** (a tiny one Callboard's own tests use).
    - **Building is yours, and explicit:** `callboard sandbox build --profile blender`, or **Build** under **Settings → Sandbox desktop → Profiles**, which shows the build log and the whole recipe (packages, downloads, the setup script, PATH and variables) before you build. Callboard never builds one on its own, and an agent can't (an agent can *propose* one, below, but each build still waits for your click). Builds are queued and run one at a time, in the order asked; each keeps its own record and log (`GET /api/sandbox-desktop/builds`), which survive a restart. Settings lists them (queued, running, finished) with **View log** and **Cancel**; a cancelled build stops at once and tags nothing. In the CLI, Ctrl+C cancels the same way. Build output is untrusted (the recipe's setup script writes into it), so escape sequences and control characters are stripped before it reaches your terminal or a log. A profile that lists architectures (Blender: `amd64`) can't be built on another one. A build first builds the base image and its builder stage if they aren't current, downloads the recipe's pinned files (checked against their SHA-256, and cached under `<data dir>/sandbox-desktop/profile-downloads`; every redirect and every address a name resolves to must be public, so a recipe can't point the download at this machine or its network), installs its Debian packages, runs its setup script offline as the unprivileged desktop user, and then re-applies Callboard's hardening (see [the recipe threat model](packages/computer-use/README.md#sandbox-desktop-profiles)). Blender's took about 4 minutes on a 12-core machine with its 360 MB download cached (8 minutes with the download, at ~1.5 MB/s), and makes an image of about 1.2 GB; Blender's UI is up about 4 seconds after it is started.
    - **List and remove:** `callboard sandbox profiles` lists each profile with its limits and image state; `callboard sandbox rm --profile <name>` (or **Remove image** in Settings) removes its image. Profiles live in a scope: `global` for the built-ins (`--scope` names another). A chat sees the global profiles, its workspace's and its folder's (its resolved path): both, so a chat that gains a workspace record later still sees the profiles of its folder. A profile an agent proposes in a chat is stored under that chat's workspace's scope when it has one, else its folder's. Docker refuses while a sandbox, running or kept for recovery, uses it.
    - **Using one:** the agent asks with `cu_request_control` and `profile: "blender"` (`cu_open` lists the profiles and whether each is built). The consent card names the profile and what it will get (CPUs, memory, home, session length, OpenGL); the Computer view and `cu_status` show it on the session. A profile that isn't built is refused before you're asked, with the command to build it. Profiles need managed mode.
    - **Limits:** a recipe asks for its own CPUs, memory, home size and session length; each is capped by **Profile caps** in Settings (4 CPUs, 8 GiB memory, 4 GiB home and 120 minutes by default; up to 32 CPUs, 64 GiB, 64 GiB and 480 minutes). A recipe that asks for nothing gets the base desktop's values. **The home counts toward memory** (it's a memory-backed tmpfs, so a full home can get the session killed for running out of memory): a profile's home is kept small enough to leave the desktop a quarter of its memory, at least 512 MiB. The concurrency limit, keeping for recovery and the deliverables quota are the same for every profile.
    - **Updates:** a profile image is labelled with its recipe's digest, the base content it was built on and the profile compiler that built it.
      - **Out of date** (it still starts): the base or the compiler changed. It keeps running the driver host and hardening it was built with, so it doesn't get their fixes until you rebuild it. Rebuilding the base (`callboard sandbox build`) from new files makes every profile out of date; rebuild them after it.
      - **Refused until rebuilt:** an image built from another version of the recipe (your consent is to the current recipe, so an older build never starts for it), one not labelled as this profile's, and one below the base's or the profile compiler's security floor.
    - **Agent-built profiles.** When no profile fits, the agent can propose one. **Every build needs your click**: there is no automatic build or rebuild, even of a recipe you approved before, and no GPU.
      - **The loop:** the agent calls `sandbox_profile_propose({ name, recipe, note? })`. Callboard validates the recipe first; every problem goes back to the agent with its path (`packages[3]: …`) and nothing is stored. A valid recipe is stored as the next **version** of that profile and you get an approval card in the chat. The agent isn't held: it's told the outcome later, in the chat (approved with a build id, then the build's success, failure or cancellation; or refused; or withdrawn). Once it's built, the agent tests it with `cu_request_control({ kind: "sandbox", profile })`, an ordinary session that asks your consent again. To change it, it proposes the whole corrected recipe again under the same name. `sandbox_profile_status` lists the profiles the chat can see, their versions and the chat's builds with the end of each log; `sandbox_profile_cancel` cancels a build the chat's own proposal queued, and no other.
      - **The card** shows the canonical recipe and its diff against the earlier version (or "New profile"), with the risky parts first: the **setup script** (run at build time as the desktop user, offline), the **hosts** it downloads from, the number of **Debian packages** (installed as root), the **limits** it asks for against your caps (the home counts toward memory), the **architectures** and the **scope**. The agent's note is shown in a box of its own, marked as its words, escaped and capped at 1000 characters. **Approve & build** queues the build; **Refuse** is final. The approval is bound to the exact recipe digest: if the stored draft changed while the card was open, nothing is built. The build is pinned to that digest and queued behind anything already waiting (your builds are never displaced). Only you can answer the card, in this tab: not an API key, not a parent chat. An older tab shows "Reload this Callboard tab" instead of the card. Stop, a permission change, archiving the chat, rewinding or forking it, or removing the profile withdraws an open card.
      - **Who may:** only a chat whose **Sandbox desktop** permission is Ask or Allow, in managed mode. Children, jobs and agent chats default to Deny. One open proposal per chat, and per profile.
      - **Scope and promotion:** an agent-built profile belongs to its chat's workspace or folder scope, and the chats there can use it. It's labelled **agent-built** in Settings until you **Promote to global**. Promotion makes every chat able to use it: the same recipe and digest, its history and its origin kept, and **the exact image you tested relabelled** as the global one (nothing is rebuilt, since package mirrors move on), so build and test it in its scope first. An agent can't use the name of a global profile, built in or promoted. Settings also shows each agent-built profile's **version history** (each recipe, the diff to the one before with the setup script diffed line by line, and the agent's note), **Rebuild** and **Remove** (every version and its image). **Build and Rebuild of anything not built in open the same review as the approval card first** (setup script, packages, download hosts, limits, digest, the diff against what is built now, and the stored provenance, labelled unverified), and build exactly the recipe you read: if it changed in between, nothing is built. `callboard sandbox build --profile` prints it and needs `--digest` (add `--show-recipe` for the whole canonical recipe). Only shipped built-ins keep their one-click Build. Promotion, removal and rebuild are yours alone; no agent tool reaches them.
      - **Limits** (Settings → Sandbox desktop → Agent-built profiles): **profiles per workspace or folder** (5 by default; 0 stops agents proposing anything, new versions of existing profiles included), **versions kept per profile** (10; the oldest that isn't in force is dropped first) and **agent builds queued at once** (2, across all chats). A proposal past a limit is refused with the reason; each one under it still needs your approval.
      - Stored under `<data dir>/sandbox-desktop/profiles/<scope>/<name>.json` (private files, written atomically). That store is plain JSON: anything with file access to the data directory, an agent with write permission included, can edit it. So nothing in it is trusted for a build or a start. A global profile that isn't a shipped built-in and has no image Callboard built for it now (never built here, image removed, or needs a rebuild) shows as **unverified** in Settings, with the image's state; its file can't be trusted on its own, so agents don't see it and it can't start until you review and build it. The same goes for a file in the built-in profiles' folder that isn't a recipe this Callboard version shipped (their digests are pinned in its source). **Code execution is root:** in managed mode Callboard's user drives Docker, so an agent allowed to run code can drive it too, and could build an image that passes as a verified profile; starting it still needs your consent in the chat. Allow code execution only where you'd allow root. The agent's recipe is untrusted input: see [the threat model](packages/computer-use/README.md#agent-built-profiles).
  - **Network:** **Internet access** (the default) or **No internet**. Both use a bridge network Callboard creates with inter-container traffic off, so sandboxes can't reach each other. **No internet** uses an `--internal` network (`callboard-sandbox-internal`), which has no route off the bridge. Docker publishes no ports there, so Callboard reaches the container at its bridge address, which never leaves this machine. That needs this machine to reach container bridge addresses, which Docker Engine on Linux allows and Docker Desktop (macOS, Windows) and rootless Docker don't; there, keep **Internet access**.
  - **Token:** a file, never an environment variable, in a private (`0700`) directory under the data directory, one per session. It's mounted into the container read-only, and Callboard never sends it: the container first proves it holds it. It's deleted with the container.
  - **Hardening:**
    - **Filesystem:** a read-only root, with tmpfs only for the desktop home and `/tmp`.
    - **Capabilities:** every capability dropped except the two the entrypoint needs to start the desktop and the driver as separate unprivileged users, plus `no-new-privileges` and no setuid programs.
    - **Limits:** pids, memory and CPU are capped. There is no Docker socket.
    - **Port:** published on `127.0.0.1` only, on a port Docker picks.
  - **Endpoint mode (a box you run yourself):** build and start the container, then point Callboard at it and restart Callboard:

    ```sh
    packages/computer-use/docker/run.sh 7801   # from a source checkout; prints the two variables
    # from an npm install:  "$(npm root -g)/@wolpertingerlabs/callboard/packages/computer-use/docker/run.sh" 7801
    export CALLBOARD_SANDBOX_DESKTOP_URL=http://127.0.0.1:7801
    export CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE=/tmp/callboard-desktop-XXXXXX/token   # the path run.sh printed
    ```

    - `run.sh` builds the image only if it's missing (from the compiled package, so run `npm run build:computer-use` first in a source checkout). Set `COMPUTER_USE_DESKTOP_REBUILD=1` to rebuild it.
    - `CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE` is read at each connection, so a rotated token is picked up, and it may be a symlink. `CALLBOARD_SANDBOX_DESKTOP_TOKEN` also works but is discouraged, because every child process of Callboard inherits it. Empty values count as unset.
    - With some of the variables set, or a value Callboard rejects, the target shows as misconfigured and says what's wrong. A container from an incompatible release is reported unavailable rather than used.
    - The panel names the target `sandbox 127.0.0.1:7801`. Consent is bound to the container instance that was asked about: if the container is replaced while a card is open, approving it opens nothing. (A managed sandbox's consent is for a fresh container, and the session must open on the one Callboard started, proven with that session's own token.)
  - **Network exposure, both ways:**
    - **Inbound:** keep an endpoint's port on `127.0.0.1`. It grants full control of that desktop, so reach it from another machine only through a TLS proxy that authenticates. Callboard refuses plain `http` to anything but loopback (and, in managed **No internet** mode, the container's own bridge address).
    - **Outbound:** the container *can* reach this machine through the Docker bridge gateway (for example `172.17.0.1`), in either network setting. Any service listening on all interfaces is reachable from the desktop, and Docker flags can't prevent that. That includes Callboard itself, which listens on every interface. Bind host services to `127.0.0.1` where you can, or firewall the Docker bridge on the host. With **Internet access** the desktop can also reach the internet.

  - **Manual cleanup and uninstall:** Callboard removes its own containers, but to remove everything by hand (with Callboard stopped):

    ```sh
    # every managed sandbox container (add --filter label=dev.callboard.owner=<owner> for one Callboard's;
    # `callboard sandbox status` prints its owner)
    docker ps -aq --filter label=dev.callboard.managed=1 | xargs -r docker rm -f
    docker network rm callboard-sandbox callboard-sandbox-internal   # whichever exist
    docker rmi callboard/computer-use-desktop:local callboard/computer-use-desktop-builder:local
    docker images callboard/computer-use-profile -q | xargs -r docker rmi   # every profile image
    rm -rf ~/.callboard/sandbox-desktop ~/.callboard/sandbox-desktop.json   # tokens, metadata, profile downloads, and the settings
    ```

    Use your data directory in place of `~/.callboard` (`~/.callboard-dev` for the dev server). An endpoint container you started with `run.sh` is yours to stop: `docker rm -f callboard-computer-use-desktop`, then delete the token directory it printed.

  See [Sandbox desktop container](packages/computer-use/README.md#sandbox-desktop-container) for the flags, the image, the handshake and protocol versioning.

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

[Drawlatch](https://www.npmjs.com/package/@wolpertingerlabs/drawlatch) (source in [`packages/drawlatch`](packages/drawlatch)) gives agents authenticated access to external APIs such as Discord, GitHub, Slack, Google and Trello. A connection is a route template: allowed URL patterns, required secrets and auth headers. An agent calls `secure_request` with a URL, and Drawlatch checks it against the patterns, injects credentials and proxies the call. The agent never sees the keys.

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
callboard sandbox build [--force] Build the Sandbox desktop image (Docker)
callboard sandbox status      Docker, the image, running managed sandboxes
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
| `CALLBOARD_SANDBOX_IMAGE`          | `callboard/computer-use-desktop:local` | The image managed Sandbox desktops run and `sandbox build` builds. Process environment only |
| `CALLBOARD_DOCKER_BIN`             | `docker` on `PATH`                     | The Docker CLI Callboard runs for managed Sandbox desktops                               |

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
| `npm run build`                             | Build shared, computer-use, drawlatch, backend and frontend                                                |
| `npm run build:drawlatch`                   | Rebuild only drawlatch. The dev backend runs the built `dist/`, so run this after editing its source       |
| `npm run clean`                             | Delete build output. Run it before `build` if you removed a `dist/` by hand, because `tsc -b` won't notice |
| `npm start`                                 | Run the production build from `backend/dist`                                                               |
| `npm test` / `test:watch` / `test:coverage` | Vitest (`npm test` and `test:coverage` also run the computer-use and drawlatch tests)                      |
| `npm run test:drawlatch`                    | Drawlatch's unit tests. `test:drawlatch:e2e` runs its live-API tests (needs `packages/drawlatch/.env.e2e`) |
| `npm run lint` / `lint:fix`                 | ESLint on **staged** files only (drawlatch's `src/` with its own config). A clean index lints nothing      |
| `npm run lint:all` / `lint:all:fix`         | ESLint on the whole tree, except `packages/drawlatch`                                                      |
| `npm run lint:drawlatch`                    | ESLint on drawlatch, with its own typed config                                                             |
| `npm run format:drawlatch:check`            | Prettier check of drawlatch's `src/**/*.ts` and top-level config, with its own `.prettierrc`               |
| `npm run prettier`                          | Format changed and staged files                                                                            |
| `npm run swagger`                           | Regenerate `backend/swagger.json`, which is served at `GET /api/docs`                                      |
| `npm run reload`                            | Build, pack and global-install callboard with the workspace drawlatch, then `callboard restart`            |

`reload` takes `--prefix <dir>` (install there instead, no restart) and `--no-restart`, e.g. `node scripts/reload.cjs --prefix /tmp/cb`. It always installs the workspace drawlatch, never the one on npm, and stops before building if `node_modules` doesn't match `package-lock.json` (run `npm install` after a pull that changes the lockfile).

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
packages/drawlatch/  Drawlatch, the credential proxy (published separately as @wolpertingerlabs/drawlatch)
bin/                 The `callboard` CLI
scripts/             Build and release helpers
plans/               Design records
```

Contributor conventions (the wire-compatibility rules for `shared/types/stream.ts`, `cwd` vs `workspaceId` keying, theming) are in [`.claude/CLAUDE.md`](.claude/CLAUDE.md).

Stack: React 18, React Router 6, Express 5, TypeScript 5, Vite 5, Zod 4, Winston, Vitest. Engines come from `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` and `@earendil-works/pi-coding-agent`. Connections come from `@wolpertingerlabs/drawlatch` (`packages/drawlatch`).

### Releasing

Callboard and drawlatch are published to npm separately and keep their own version numbers. Callboard pins drawlatch **exactly** (`"@wolpertingerlabs/drawlatch": "<version>"`, no `^`) in both `package.json` and `backend/package.json`, and that pin must equal `packages/drawlatch/package.json`'s `version`; `npm run deps:check` (in CI and `prepublishOnly`) fails otherwise. That way each callboard release names the exact drawlatch it was built and tested against. (npm links the workspace for any range the workspace version satisfies; the exact pin is about lockstep, not linking.) To bump drawlatch:

```bash
npm version <version> -w @wolpertingerlabs/drawlatch --no-git-tag-version
# set both pins to <version>
npm install
```

Both packages are published by the **Publish to npm** workflow (`.github/workflows/publish.yml`), never with `npm publish` from a checkout. drawlatch must be on npm before callboard, and the workflow publishes them in that order. Bump the version(s), merge to `main`, then in GitHub → Actions → **Publish to npm** → **Run workflow** on `main`:

- **`dry_run`** (on by default) runs everything except the publishes and the tags. That covers the release plan, the full `prepublishOnly` gate, packing both tarballs (the log lists their contents) and `npm publish --dry-run` of each tarball that would be published. It also covers the registry check (step 4 below), except when the run would publish drawlatch: drawlatch isn't on npm yet then, so the check is skipped. Run a dry run first. npm still exchanges the job's OIDC token in a dry run, and the dry run fails if that exchange doesn't work, so it also checks the trusted-publisher setup below.
- **`dist_tag`** (default `latest`) is passed as `--tag`, which npm requires for prerelease versions. The run refuses an empty value, and any value npm would read as a semver range (`1.x`, `^1`, `v1`). It also refuses to move a dist-tag backwards, so a hotfix for an older version needs another dist-tag.

The workflow has two jobs, so that dependencies' install scripts and the test suite never run where a credential is reachable:

- **build** has a read-only token, which isn't persisted. It plans, installs, gates and packs both tarballs.
- **publish** runs in the `npm` environment with the OIDC token and the token that pushes tags. It installs and builds nothing, and publishes the exact tarballs **build** packed.

What a run does, decided by `scripts/release-plan.mjs` and printed in the run summary:

1. **Plan.**
   - Fails if callboard's drawlatch pin isn't the workspace version.
   - **drawlatch:** if its version isn't on npm, it will be published. If it is, nothing that ships may have changed under `packages/drawlatch` since the commit it was published from (its `drawlatch-v<version>` tag); otherwise the run fails with "bump drawlatch". Tests, JSON fixtures, lint/test config, `.gitignore`, `CLAUDE.md`, `plans/` and example configs don't count.
   - **callboard:** its version must not be on npm yet, or the run fails with "bump callboard" (a dry run only warns).
2. **Gate.** `npm run prepublishOnly`: lint, a clean build, every test suite and `deps:check`, run once, before anything is published. It runs with `CALLBOARD_SKIP_REGISTRY_CHECK=1`, which makes `prepublishOnly` skip its registry check (that the pinned drawlatch is already on npm), because drawlatch isn't published until the publish job.
3. **Pack.** Writes the commit into each `package.json` as `gitHead` (npm records it, and re-runs use it), then runs `npm pack` for both.
4. **Publish drawlatch** (if needed).
5. **Check that callboard's drawlatch pin is installable from npm** with `npm run deps:check:registry`, retried for about two minutes.
   - It always runs in a real run.
   - `CALLBOARD_SKIP_REGISTRY_CHECK` doesn't affect it.
   - A dry run that would publish drawlatch skips it, since drawlatch isn't on npm yet.
6. **Publish callboard.** Both publishes use `--provenance --access public`.
7. **Tag** `drawlatch-v<version>` and `v<version>`, annotated and pushed by `github-actions[bot]`, after both publishes.

**Re-running after a partial failure.** Use one of these:

- **A new dispatch, or "Re-run all jobs"** re-plans from the registry and the tags, so it always picks up where the failed run stopped:
  - A package already on npm isn't published again.
  - A missing tag is created on the commit npm recorded for that version (`gitHead`).
  - A tag already on the right commit is left alone.
  - The run fails on a tag that disagrees with the commit npm recorded, or on a tag at a different commit for a version that isn't on npm.
- **"Re-run failed jobs"**, when only the publish job failed, reuses the build job's plan and tarballs. This is safe too:
  - Each publish first checks npm. A version already published from this run's commit is skipped with a notice. One published from any other commit fails the step; start a new dispatch so the plan can say what to bump.
  - A tag already on origin at the right commit is skipped.
  - The tarballs are kept for 7 days, so this only works within that window.

If in doubt, start a new dispatch.

Releasing only callboard is the common case: leave drawlatch's version alone and the run skips it, as long as drawlatch hasn't changed. Releasing a drawlatch change means bumping drawlatch (above) and callboard together, since callboard's pin moves.

**The drift check only sees `packages/drawlatch`.** The root `package-lock.json` decides which versions of drawlatch's frontend dependencies (react, react-router-dom, lucide-react) and build toolchain (vite, typescript) are used. A lockfile change can therefore change what drawlatch's tarball would contain without touching `packages/drawlatch`. **Bump drawlatch's version if a lockfile change affects its frontend or build toolchain.**

**One-time setup** (repository admin and npm package owner). Do it **in this order**:

1. **GitHub environment, first.** Repo Settings → Environments → **New environment** named `npm`. Under Deployment branches and tags, choose **Selected branches and tags** and add `main`.
   - The publish job runs in this environment, so its credentials are only available to runs from `main`, whatever the workflow file on a branch says.
   - Create it **before** the trusted publishers. npm only matches the workflow filename and the environment name. GitHub creates a referenced environment automatically on first use, and with no branch rule, so until the rule exists any branch that edits `publish.yml` could publish.
   - Adding **required reviewers** to the environment is possible. They would gate every run's publish job, dry runs included.
2. **Trusted publishers on npmjs.com.** Publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so there is no npm token in the repo. Set this up for **each** of `@wolpertingerlabs/drawlatch` and `@wolpertingerlabs/callboard`: package → Settings → Trusted Publisher → GitHub Actions, with:
   - organization `WolpertingerLabs`
   - repository `callboard`
   - workflow filename `publish.yml`
   - environment `npm`
3. **Retire the standalone drawlatch repo's publishing.** Revoke the npm token its `publish.yml` used, and disable that workflow.
4. **Optional:** once each package has published once this way, set its Publishing access to "Require two-factor authentication and disallow tokens".

After a release, `npm view @wolpertingerlabs/<package>@<version> dist.attestations` should show the provenance attestation.

`npm run deps:check:registry` checks that the pinned drawlatch version is on npm. It needs only Node, `npm` and the network (no install or build), so CI's `ci.yml` doesn't run it. Callboard's `prepublishOnly` runs the same check and only skips it when `CALLBOARD_SKIP_REGISTRY_CHECK=1`, so a manual publish checks by default. That includes a local rehearsal: `npm publish --dry-run` (or `npm run publish:dry-run`) runs `prepublishOnly`, so before the pinned drawlatch is on npm it needs `CALLBOARD_SKIP_REGISTRY_CHECK=1`. The workflow's dry run sets the variable for you.

## License

MIT
