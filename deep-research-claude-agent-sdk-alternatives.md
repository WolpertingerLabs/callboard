# Replacements for the Claude Code Agent SDK: A Deep Research Report

*Generated: 2026-04-20*
*Research scope: Alternatives to `@anthropic-ai/claude-agent-sdk` as a programmable coding-agent harness for TypeScript/Node projects — coding-specific CLIs, general agent frameworks, real-world switching tradeoffs, and a decision framework.*

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Baseline: What the Claude Agent SDK Actually Gives You](#1-baseline-what-the-claude-agent-sdk-actually-gives-you)
3. [Coding-Agent-Specific Harnesses (Vendor + Open Source)](#2-coding-agent-specific-harnesses-vendor--open-source)
4. [General-Purpose Agent Frameworks (the "Build Your Own Harness" Option)](#3-general-purpose-agent-frameworks-the-build-your-own-harness-option)
5. [Tradeoffs: What Teams Gain and Lose When They Switch](#4-tradeoffs-what-teams-gain-and-lose-when-they-switch)
6. [Opinionated Decision Framework](#5-opinionated-decision-framework)
7. [Conclusion](#conclusion)
8. [References](#references)

---

## Executive Summary

The Claude Code SDK was renamed to the **Claude Agent SDK** in late 2025, signalling Anthropic's view that the same harness powering Claude Code is a general-purpose agent runtime [1][2]. As of April 2026 it ships as Python and TypeScript SDKs at `v0.2.116`, with a native per-platform Claude Code binary bundled as an optional dependency, first-class MCP across four transports, programmatic subagents, 19+ hook events, six permission modes, OS-level sandboxing, session forking, structured JSON Schema outputs, and Opus 4.7 support — but it remains **proprietary, Claude-only, and behaviourally tuned to its own tool schema** [1][3][4][6][7][8].

Credible alternatives fall into three camps. **Coding-specific CLIs** (OpenAI Codex CLI, Cursor Agent, Cline CLI 2.0, Goose, OpenCode, OpenHands, Gemini CLI, Copilot CLI, Amp, Plandex, Codebuff) vary wildly in whether they expose a programmable Node surface — only **OpenCode** (OpenAPI server + generated SDK, MIT), **OpenAI Codex** (`@openai/codex-sdk`, Apache-2.0 core), **Sourcegraph Amp** (published TS SDK, proprietary/credits-only), and **Codebuff** (`@codebuff/sdk`, Apache-2.0) ship real library surfaces; the rest are subprocess-only [22][29][30][31][32][33][34][35][36][37][38][39][40][41]. **General-purpose frameworks** (OpenAI Agents SDK, Mastra, Vercel AI SDK, LangGraph JS, Inngest AgentKit, Cloudflare Agents) give you building blocks for a harness of your own — none ship Claude Code's coding tool suite, but Mastra and LangGraph JS come closest to being a "turnkey framework for TypeScript" [28][29][24][32][34][37][52][57].

The headline finding from first-person engineering accounts is that **the Claude model is post-trained against its own harness** — Claude ranks ~#33 on Terminal-Bench 2.0 inside generic scaffolding vs roughly ~#5 inside Claude Code, per HumanLayer's analysis [19]. That means pointing the SDK at another model "works" mechanically but underperforms materially, and moving off the SDK onto another harness trades Claude-tuned coding quality for model portability, cost control, and orchestration flexibility. Teams that have switched report gaining portability (Arntz [14], Zechner [11]), cost (Folkman [13]: $45/mo vs $200/mo) and loop transparency; teams that stayed cite Claude Code's sub-agents-as-context-firewall, deterministic hooks, plan mode, and skills/memory ecosystem as primitives that are expensive to rebuild [19].

For a TypeScript/Node project like Callboard that currently embeds Claude Code, the cleanest recommendations are (a) **stay on Claude Agent SDK** if coding-quality dominates, (b) **OpenCode or Codex SDK** if you need model portability and a real Node library surface while keeping a coding-specific harness, (c) **Mastra or Vercel AI SDK + your own primitives** if you're building a multi-domain agent product where coding is just one workflow, and (d) **a hybrid** — wrap Claude Agent SDK in a provider-neutral façade today to preserve today's quality while keeping migration optionality cheap — which several sources frame as the dominant real-world pattern [19][24][26].

---

## 1. Baseline: What the Claude Agent SDK Actually Gives You

To reason about replacements you need a clear picture of the incumbent. This section is the spec-sheet.

### 1.1 Origin, versioning, and distribution

The SDK was originally the **Claude Code SDK** and was renamed to **Claude Agent SDK** in late 2025 to reflect a broader agent-runtime positioning — "the same agent harness powering Claude Code could power many other types of agents" [1][5]. The rename came with a Python type rename (`ClaudeCodeOptions` → `ClaudeAgentOptions`), a published migration guide [2], and re-publishing of the npm package as `@anthropic-ai/claude-agent-sdk` [1][6]. The v0.1.0 release also removed default loading of filesystem settings — callers must now explicitly set `settingSources: ["user", "project", "local"]` to get Claude Code-like behaviour [3].

Both **Python** (`claude-agent-sdk`) and **TypeScript** (`@anthropic-ai/claude-agent-sdk`) are first-class, with 91 releases as of April 2026 and current version **v0.2.116** [3][6]. The TypeScript package requires **Node 18+** and now bundles a native Claude Code binary per platform as an optional dependency (switched from a JS `cli.js` in v0.2.113) [3][6]. The SDK is **proprietary**, governed by Anthropic's Commercial Terms of Service — not OSS [1][6][10].

Architecturally, the SDK **spawns a native Claude Code binary** and communicates with it via a JSON-RPC-style control channel — it is a programmable harness *around* the CLI process, not a native library [3][10].

### 1.2 TypeScript surface area

The core API is small and stream-oriented [4]:

- `query({ prompt, options }): Query` — primary async generator returning `SDKMessage`s. `prompt` can be a `string` or an `AsyncIterable<SDKUserMessage>` for streaming input.
- `startup(params)` — pre-warms the CLI subprocess so first query is ~20× faster (v0.2.89) [3].
- `tool()` and `createSdkMcpServer()` — define in-process MCP tools with Zod schemas.
- Session management: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()`, `deleteSession()` (v0.2.113) [3][4].

The returned `Query` object exposes `interrupt()`, `rewindFiles()`, `setPermissionMode()`, `setModel()`, `setMaxThinkingTokens()`, `supportedCommands()`, `supportedModels()`, `supportedAgents()`, `mcpServerStatus()`, `reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()`, `streamInput()`, `stopTask()`, `close()` [4].

Notable `Options` fields [4]: `model`, `fallbackModel`, `effort` (`low|medium|high|xhigh|max`), `thinking`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, `allowedTools`, `disallowedTools`, `canUseTool`, `continue`, `resume`, `forkSession`, `resumeSessionAt`, `sessionId`, `persistSession`, `mcpServers`, `tools` (incl. `{ type: 'preset', preset: 'claude_code' }`), `agents`, `cwd`, `additionalDirectories`, `enableFileCheckpointing`, `systemPrompt`, `hooks`, `outputFormat` (JSON Schema structured outputs), `betas`, `settingSources`, `plugins`, `sandbox`, `sessionStore` (external transcript mirroring, v0.2.113), `title` (v0.2.113), `includePartialMessages`, `includeHookEvents`, `taskBudget`, `agentProgressSummaries`.

Streaming is via async generator; over 20 `SDKMessage` variants exist (assistant, user, result, system, partial assistant, compact boundary, status, hook lifecycle, tool progress, rate limit, etc.) [4]. Session resumption is via `resume: sessionId` or `continue: true`; branching uses `forkSession` [1][3][4].

### 1.3 Built-in tool ecosystem

Documented tools [1][4]:

| Tool | Purpose |
|------|---------|
| `Read` / `Write` / `Edit` | File I/O and precise edits |
| `Bash` | Shell execution |
| `Glob` / `Grep` | File pattern/content search (ripgrep-backed) |
| `WebSearch` / `WebFetch` | Search and HTML→markdown fetch |
| `Monitor` | Watch stdout of background processes as events |
| `Agent` | Spawn subagents (Task tool) |
| `AskUserQuestion` | Interactive multiple-choice prompts (v0.1.71) [3] |
| `NotebookEdit` | Jupyter notebook editing |
| `TodoWrite` | Agent todo tracking |
| `ExitPlanMode` | Exit plan mode |
| `TaskOutput` / `TaskStop` | Background task control |
| `ListMcpResources` / `ReadMcpResource` | MCP resource access |
| `Config`, `EnterWorktree` | Harness config + worktree integration [4] |

Tools can be scoped via `allowedTools` / `disallowedTools`, or replaced wholesale via `tools: string[]` (v0.1.57) [3].

### 1.4 MCP integration

MCP servers are configured in `options.mcpServers` or a project `.mcp.json` [7]. Four transports are supported:

1. **stdio** — `{ command, args, env }` [7]
2. **HTTP** — `{ type: "http", url, headers }` [7]
3. **SSE** — `{ type: "sse", url, headers }` (being phased out in favour of HTTP at the MCP spec level) [7]
4. **SDK in-process** — `createSdkMcpServer()` + `tool()` with Zod [4][7]

Tools are exposed as `mcp__<server-name>__<tool-name>`, and Claude requires `allowedTools: ["mcp__server__*"]` to call them — `acceptEdits` does **not** auto-approve MCP tools [7]. The SDK emits a `system/init` message listing each server's status for pre-run health checks [7]. Default MCP connection timeout is 60s [7]. Per-tool `permission_policy` values and `mcp_set_servers` control requests were added in v0.2.111 [3]. Tool search (loading tool definitions lazily) is default-on to keep context small [7].

### 1.5 Subagents and hooks

Subagents are spawned via the `Agent` built-in tool [1][4] and can be defined either in `.claude/agents/*.md` (filesystem) or programmatically via `options.agents: Record<string, AgentDefinition>` where each has `description`, `prompt`, `tools` [1][3]. Each subagent runs with its **own tools and model**, enabling different cost/capability profiles per subagent [5]. `agent_id` and `agent_type` fields in hook events enable subagent-scoped hooks [5]. Known bug: `agents: {}` does not filter Claude Code's built-in subagents from the Task-tool schema [3].

Hooks are registered via `options.hooks: Record<HookEvent, HookMatcher[]>` where each matcher has a regex `matcher` (e.g. `"Edit|Write"`) and an array of callbacks receiving `input_data` — they can **block, modify, or observe** tool calls [1][5]:

- `PreToolUse` / `PostToolUse` / `PostToolUseFailure`
- `PermissionRequest` — programmatic approve/deny
- `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `Notification`
- `SubagentStart`, `SubagentStop`, `PreCompact`
- `Setup`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`
- `WorktreeCreate`, `WorktreeRemove` [4]

Hook lifecycle messages can be streamed by setting `includeHookEvents: true` (v0.2.89) [3].

### 1.6 Permission modes and sandboxing

Six permission modes [8]:

| Mode | Auto-approves | Use case |
|------|---------------|----------|
| `default` | Reads only | Safe starting point |
| `acceptEdits` | Reads, file edits in cwd, common filesystem Bash | Iteration |
| `plan` | Reads only; Claude proposes a plan, doesn't edit | Pre-implementation exploration |
| `auto` (v2.1.83+, Max/Team/Enterprise/API only) | Everything, gated by a classifier model | Long-running autonomy |
| `dontAsk` | Only pre-approved tools | Locked-down CI |
| `bypassPermissions` | Everything (except protected paths) | Isolated containers/VMs |

**Protected paths** always require explicit approval regardless of mode: `.git`, `.vscode`, `.idea`, `.husky`, most of `.claude`, `.gitconfig`, `.bashrc`, `.mcp.json`, `.claude.json` [8]. **Sandboxing** is a separate OS-level feature invoked via `/sandbox` and exposed programmatically as `options.sandbox`, restricting Bash filesystem and network access [4][8]. `auto` mode is **not available on Bedrock/Vertex/Foundry** — Anthropic API only [8].

### 1.7 Slash commands, skills, memory, plan mode

All are accessible via the SDK, but only when `settingSources` explicitly includes project/user (not loaded by default since v0.1.0) [1][3]:

- **Slash commands** — `.claude/commands/*.md`, exposed via `Query.supportedCommands()` [1][4]
- **Skills** — `SKILL.md` files with YAML frontmatter in `.claude/skills/<name>/`, autonomously invoked by Claude or manually via `/name` [1]
- **Memory (CLAUDE.md)** — project and `~/.claude/CLAUDE.md` global, with a `system/memory_recall` event added in v0.2.105 [1][3]
- **Plan mode** — `permissionMode: "plan"`; read-only research mode; `ExitPlanMode` tool escapes it [1][4][8]

### 1.8 Model routing

**Claude only**, across multiple clouds [1]:

- Anthropic API (default, `ANTHROPIC_API_KEY`)
- Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`)
- Google Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`)
- Microsoft Azure Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`, v0.1.45) [3]

On Bedrock/Vertex, set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` to strip Anthropic-only beta headers [9]. **OAuth tokens from Claude Pro/Max accounts cannot power SDK-built products** — API keys or the three cloud providers only [1][10]. There is no first-class support for OpenAI, Gemini, or open-source models; AI gateways like Portkey can sometimes interpose Anthropic-compatible endpoints [9].

### 1.9 Known limitations and criticisms

From developer write-ups [10]:

- **CLI-wrapper architecture.** The SDK spawns `cli.js`/native binary and communicates via stdio — critics want the SDK decoupled from the CLI process [10].
- **Packaging/bundling pain.** Electron and other bundler-based apps routinely hit problems where the binary isn't where expected after packaging; end users without Node.js in PATH hit `spawn node ENOENT` [10].
- **OAuth/consumer-plan restrictions.** Free/Pro/Max OAuth tokens are explicitly prohibited for SDK-built products [1][10].
- **Resource management.** Production OOM reported; subagent sandboxing and multi-user filesystem isolation are "not trivial" [10].
- **Context exhaustion.** Agents tend to overcommit; plan mode and explicit scoping are the recommended mitigations [10].
- **Classifier limitations.** `auto` mode's safety classifier produces false positives for custom infra and is API-only [8].
- **MCP context bloat** — mitigated by default-on tool search but still an issue with many servers [7].
- **Branding restrictions.** Partners cannot call their product "Claude Code" or use Claude Code-branded visuals [1].

---

## 2. Coding-Agent-Specific Harnesses (Vendor + Open Source)

This section surveys coding-agent-specific alternatives. The central question for each is: **can it be embedded and driven programmatically from Node**, and what does it give up vs the Claude Agent SDK baseline above?

### 2.1 OpenAI Codex CLI (`openai/codex`)

The closest structural analog to Claude Code. Open source (Apache-2.0), ~95% Rust after a 2025 rewrite, with a TypeScript SDK wrapper [60][61]. Latest `v0.122.0` (April 20, 2026), ~76.6k stars [61]. Invocation surface spans an interactive TUI (`codex`), non-interactive `codex exec` with text/JSON/NDJSON streaming [62][68], and — the key item for this report — an **official `@openai/codex-sdk` for TypeScript/Node** [63][69]. The SDK exposes a thread-oriented API (`startThread()`, `run(prompt)`, `resumeThread(threadId)`) built over JSON-RPC against a local Codex app-server; requires Node 18+ [63][69]. MCP is supported as both client (stdio + Streamable HTTP with env/bearer/OAuth auth) and server, configured via `[mcp_servers.<name>]` in `config.toml` [64]. Three approval modes (Auto, Read-only, Full Access); a `/review` subagent-style command; hooks are less explicit than Claude Code's but the JSON-RPC event stream effectively gives lifecycle events in code [68]. Model-wise, **OpenAI-first** — documentation recommends `gpt-5.4`; there is no documented Claude or local-model path in the official SDK, though the Rust core can be pointed at OpenAI-compatible endpoints. **Biggest win vs Claude Agent SDK:** open-source core plus an official TS SDK with MCP and sandboxing. **Biggest loss:** Claude model support is unofficial at best; hook system is thinner; named subagents are thinner than Claude's Task-tool ergonomics.

### 2.2 Aider

The long-running Python pair-programmer (`Aider-AI/aider`), Apache-2.0, ~43.6k stars [65][66]. Its last *tagged* release is v0.86.0 from August 2025 though `main` remains active [66]. A Python scripting API (`Coder.create()` / `coder.run()`) exists but the docs warn it "is not officially supported or documented, and could change" [67]. **No official Node binding, no MCP, no subagents, no hooks.** Model-agnostic via LiteLLM (Claude, OpenAI, Gemini, DeepSeek, Ollama) [65]. Practical only as a subprocess for Node. **Win:** model breadth, deep git/commit integration. **Loss:** every primitive the Claude SDK makes ergonomic.

### 2.3 Cursor CLI / Cursor Agent

Anysphere's CLI for the Cursor agent [70][71]. **Closed source / proprietary**, distributed as a binary. Strong headless story: output formats `text`, `json`, `stream-json`, plus `--stream-partial-output` for token-level deltas [70][71]. Shares the IDE's config (`.cursor/rules`, `AGENTS.md`/`CLAUDE.md`, MCP servers) [71]. Cloud "Automations" for scheduled/event-triggered agent runs were announced Feb/March 2026 [72][73]. **No TypeScript library — subprocess-only.** Routed multi-model (Claude, GPT, Gemini, Cursor's own). **Win:** polished JSON stream, IDE parity. **Loss:** closed source, no library surface, vendor lock-in.

### 2.4 Cline + Cline CLI 2.0

`cline/cline` — Apache-2.0, TypeScript (98%), ~58k stars [76]. **Cline CLI 2.0** (Feb 13, 2026) is "a ground-up redesign of Cline for terminal use" [74][75]. Invocation: multi-IDE extensions, CLI with interactive and headless modes (`-y`, `--json`, stdin/stdout piping), plus a standout `--acp` flag that exposes Cline as an **Agent Client Protocol**-compliant agent — an LSP-like standard for agent↔editor communication [74]. Both client and marketplace MCP support. Parallelism is achieved by **spawning fully isolated CLI instances** — subagents via process isolation rather than a dedicated primitive [74][76]. Extremely broad provider list incl. local via LM Studio/Ollama [76]. **Win:** model breadth, ACP standard compatibility, multi-IDE. **Loss:** no published Node SDK contract, hooks aren't an explicit API.

### 2.5 Goose (Block)

`block/goose` — Apache-2.0, Rust (50%) + TypeScript (44%), ~42.8k stars, `v1.31.1` (April 20, 2026); inaugural Linux Foundation Agentic AI Foundation project [78][79]. Invocation includes desktop app, CLI, and an "embeddable API" [79]. **Best-in-class MCP story** — 70+ documented extensions; frequently cited as the reference MCP-consumer implementation [77][78][79]. First-class **Recipes** (portable YAML workflows) and **Subagents** primitives, plus tool permission controls and sandbox mode [78][79]. Multi-provider across 15+ incl. local [78]. **Win:** deepest open-source MCP integration, explicit recipes+subagents. **Loss:** no Node-native SDK (CLI or REST); Rust core makes patching heavier.

### 2.6 OpenCode (`sst/opencode`)

**MIT**, TypeScript 58%, **147k stars**, `v1.14.19` (April 20, 2026) — currently among the most-starred coding agents on GitHub [80][81]. The crucial architectural fact: the TUI is a client of a local HTTP server, and that server is a well-defined integration surface — `opencode serve` exposes an **OpenAPI 3.1 spec at `/doc`** with a generated SDK [80][81]. `npm i -g opencode-ai` gets you a Node-usable SDK directly. REST endpoints for sessions/messages/files/MCP/config/commands/agents/tools; HTTP basic auth via env vars [80]. MCP supported via `/mcp` endpoints. Three built-in agents — `build` (full access), `plan` (read-only), `general` (search) — with permission prompts answerable via API with optional "remember" [80]. Provider-agnostic over 75+ providers (AI SDK + Models.dev); Claude, OpenAI, Google, local all first-class [80][81]. **Win vs Claude Agent SDK:** MIT, clean client/server split, 75+ providers incl. local, explicit permission API. **Loss:** fewer hooks/named-subagent features than Claude Code's turnkey harness.

### 2.7 OpenHands / OpenDevin (All-Hands-AI)

MIT core (enterprise subdir separately licensed), Python 72% / TypeScript 26%, ~71.6k stars, `v1.6.0` (March 30, 2026; adds Kubernetes + Planning Mode beta) [82][83][84]. Invocation: an **OpenHands Software Agent SDK** (Python), CLI, REST-based Agent Server (Docker/Kubernetes), local GUI [83][84]. **No first-party TypeScript SDK** — from Node you hit REST or the CLI. Sandboxing is **Docker-by-design**, the strongest sandbox story in this list [83][84]. Model-agnostic (Claude, GPT, any LLM, Qwen, Devstral, etc.) [83][84]. **Win:** containerized sandbox, scale-to-1000s story, proven self-host. **Loss:** Python-first SDK, so for a Node project it's REST-or-shell-out.

### 2.8 Gemini CLI (Google)

Apache-2.0, TypeScript (98%), ~102k stars, `v0.38.2` (April 17, 2026) [86]. Interactive + headless (`--prompt`, stdin) modes; headless returns structured JSON with token stats, tool calls, file mods, errors [85]. MCP supported via `~/.gemini/settings.json`, local and remote [85][86]. Agent-reuse features, Trusted Folders, Windows/Linux sandbox expansions in recent 2026 updates [85]. **Gemini-only** model-wise. **Win:** open source, huge context, strong MCP, free tier. **Loss:** single-vendor lock; no Node library SDK; hooks/subagents aren't first-class.

### 2.9 GitHub Copilot CLI

**GA February 25, 2026** [87][88]. Distributed via `@github/copilot` on npm; source posture **unclear** — treat as effectively proprietary for planning. Interactive TUI + non-interactive mode. MCP supported with GitHub's MCP server by default plus custom servers [88]. **Autopilot** and fleet modes for parallel agents; enterprise admin policies can restrict models [87]. Multi-model: Claude Sonnet 4.5/4.6, Claude Opus 4.6/4.7, Claude Haiku 4.5, GPT-5.3-Codex, Gemini 3 Pro, plus `auto` [87][88]. **Win:** multi-model including Claude Opus 4.7, org-level policy controls, GitHub integration. **Loss:** unclear source/license; no published Node library SDK; designed for interactive/CI use, not embedded harness.

### 2.10 Sourcegraph Amp

Sourcegraph's agentic coding tool, **closed source / proprietary**, `@sourcegraph/amp` on npm; active release cadence [89][90]. Notable for this report because it **ships a documented TypeScript SDK** with Stream Inputs/Outputs, multi-turn threads, `dangerouslyAllowAll`, fine-grained permissions, and MCP integration [91][92]. MCP via `mcp.json` or direct config; both local and remote; OAuth supported [91][92]. Fixed routing across Opus 4.6, GPT-5.4, and fast models, selected by mode (smart/rush/deep). **No BYO key — uses credits against Sourcegraph's provider accounts; "Amp SDK consumes paid credits only"** [92]. **Win:** one of the few closed-source agents with a real TS SDK; top-tier routed models incl. Opus 4.6. **Loss:** closed, paid-credits-only, no BYO key, no local models.

### 2.11 Plandex

**MIT**, Go (93%), ~15.3k stars, `plandex-ai/plandex` [94]. Terminal-based, specialized in large multi-file tasks with a **cumulative-diff review sandbox** as its core safety primitive [93][94]. CLI + self-hosted Docker server; **Plandex Cloud is being wound down** as of 2026, OSS project continues [93][94]. Last tagged CLI release was `v2.2.1` on **July 16, 2025** — a notable staleness signal [94]. No MCP. Anthropic (incl. Pro/Max), OpenAI, Google, OpenRouter, local via self-host [93][94]. **Win:** rollback-friendly diff sandbox, MIT, local-model path. **Loss:** no Node SDK, no MCP, slowing release cadence.

### 2.12 Roo Code / Kilo Code (Cline forks)

Both primarily **VS Code extensions**. **Roo Code** (`RooCodeInc/Roo-Code`): Apache-2.0, ~23k stars, custom modes + diff editing (~30% token savings claimed); no documented CLI or headless mode [95][96]. **Kilo Code** (`Kilo-Org/kilocode`): MIT, TypeScript (92%), ~18k stars, $8M seed Dec 2025; fork-of-fork explicitly positioned as a superset. Differentiators: **Orchestrator mode** (task decomposition routed to specialist modes) and a CLI (`@kilocode/cli`) with `--auto` for CI [95][97]. Kilo is the better candidate of the two if you want VS Code-style agent you can also script.

### 2.13 Codebuff, Continue.dev

**Codebuff** (`CodebuffAI/codebuff`): Apache-2.0, TypeScript (97%), ~4.6k stars [98]. Ships **both** a `codebuff` CLI and an `@codebuff/sdk` npm package; multi-agent architecture (Base2 Orchestrator, File Picker, Planner, Editor, Reviewer) where custom agents can spawn subagents; SDK supports event handlers and structured responses; models via OpenRouter [98]. MCP is *not* a first-class feature — Codebuff positions agents as "the new MCP." One of the few tools here with a published Node SDK and explicit subagents, but smaller footprint. **Continue.dev** (`continuedev/continue`): open source, TypeScript. 2026 positioning has pivoted to "source-controlled AI checks, enforceable in CI" — essentially the CI-check use case [99][100]. CLI is `cn` with interactive and headless modes, shared `config.yaml` with IDE extensions, MCP tools, `--allow` / `--ask` / `--exclude` permissions, `CONTINUE_API_KEY` auth [99]. Headless mode is the integration surface; no prominent dedicated SDK.

### 2.14 Summary comparison

| Tool | Node-callable as lib? | MCP | Models | Open source | Biggest win | Biggest loss |
|---|---|---|---|---|---|---|
| Codex CLI | **Yes (`@openai/codex-sdk`)** | Client+server | OpenAI-first | Apache-2.0 | Structural parity incl. TS SDK | Claude unofficial |
| Aider | No (Python, unstable) | No | Broad | Apache-2.0 | Model breadth, git | No Node story, no MCP |
| Cursor CLI | Subprocess only | Yes | Routed multi-model | Closed | Polished JSON stream | Closed source |
| Cline CLI 2.0 | Subprocess/ACP | Yes | Broad incl. local | Apache-2.0 | ACP standardization | No Node SDK |
| Goose | REST/CLI only | **Deepest MCP** | 15+ incl. local | Apache-2.0 | Recipes + subagents | No Node SDK |
| **OpenCode** | **Yes (OpenAPI SDK)** | Yes | 75+ incl. local | **MIT** | Clean client/server, most providers | Fewer hooks |
| OpenHands | Python SDK + REST | Yes | Any LLM | MIT | Docker sandbox | Python-first |
| Gemini CLI | Subprocess only | Yes | Gemini only | Apache-2.0 | 1M context, free tier | Single vendor |
| Copilot CLI | Subprocess only | Yes | Claude+GPT+Gemini | Unclear | Org policies, multi-model | No Node SDK |
| **Amp** | **Yes (TS SDK)** | Yes | Fixed Sourcegraph routing | Closed | Real TS SDK + streams/permissions | Credits-only, closed |
| Plandex | Subprocess only | No | Broad incl. local | MIT | Diff-rollback sandbox | Slowing, no MCP |
| Roo/Kilo | Kilo has CLI | Yes | 500+ | Apache-2.0/MIT | VS Code native | Editor-first |
| **Codebuff** | **Yes (`@codebuff/sdk`)** | "Agents not MCP" | OpenRouter | Apache-2.0 | TS SDK + subagents | Smaller project |
| Continue `cn` | Subprocess only | Yes | Broad | Open source | CI-check workflow | Not library-first |

**For Node/TS projects:** the strongest library-surface replacements are **OpenCode** (OpenAPI/TS SDK, MIT, multi-provider incl. Claude and local), **Codex SDK** (TS SDK, MCP, but OpenAI-first), **Amp SDK** (real TS SDK, but closed + credits-only), and **Codebuff** (TS SDK with explicit subagents, smaller community). Everything else is best treated as a subprocess you shell out to.

---

## 3. General-Purpose Agent Frameworks (the "Build Your Own Harness" Option)

If no coding-specific harness fits, the alternative is to build one on top of a general framework. **None of these ship Claude Code's coding tool suite or hook lifecycle** — you'd implement those yourself — but they give you scaffolding for the loop, providers, and sometimes multi-agent primitives.

### 3.1 OpenAI Agents SDK (TypeScript)

`openai/openai-agents-js` — **MIT**, TypeScript first-class (not a port of the Python library — both have feature parity) [28][30]. `v0.8.5` (April 21, 2026), ~2.8k stars [28]. Agents are configured with instructions, tools, guardrails, and **handoffs** — the SDK's first-class multi-agent primitive (one agent delegates the full conversation to a specialist) [29]. Sessions for persistent memory; guardrails for parallel safety checks; human-in-the-loop via pause/serialize/resume [29]. **MCP client** is first-class across three transports — Hosted MCP (Responses API), Streamable HTTP, Stdio — as `MCPServerStdio`, `MCPServerSSE`, `MCPServerStreamableHttp`, with helpers like `getAllMcpTools()` and `mcpToFunctionTool()` and per-call `MCPToolFilterContext` filtering [31]. No first-class MCP server exposure. Provider-agnostic `Model` abstraction supports Anthropic, Google, local in addition to OpenAI [29]. **No coding tools out of the box** — no shell, no file-edit tool, no git, no sandbox. **Biggest gap vs Claude Agent SDK:** lacks the coding tool suite; hooks less explicit.

### 3.2 Mastra

`mastra-ai/mastra` — **Apache 2.0 core + Mastra Enterprise License for `ee/`**, TypeScript-native (99.4%), `v1.24.0` (April 8, 2026), **~23.2k stars** — highest-starred TS-native framework [24][32]. Autonomous agents, deterministic graph-based workflows, RAG, persistent memory, evals, supervisor multi-agent pattern [32][33]. **MCP is bidirectional** — Mastra agents consume remote MCP servers (client) *and* expose their own tools/agents as MCP servers for Claude Desktop, Cursor, VS Code, etc. [32]; that's unusual. Explicit lifecycle hooks, built-in LLM-as-judge evals, Logfire/Langfuse integrations [33]. Routes across 40+ providers [24]. **No built-in coding tools.** A community package `claude-code-mastra` wraps the Claude Agent SDK as a Mastra Agent, enabling the hybrid pattern [24]. **Biggest gap:** audit the `ee/` directory before committing — some production features fall under the Enterprise license.

### 3.3 Vercel AI SDK

`vercel/ai` — Apache-2.0 (confirm in repo), TypeScript, ~23.7k stars, extraordinarily active (5000+ releases) [34][35]. Not an agent framework per se but the lower-level toolkit heavily used *by* frameworks. AI SDK 5 (July 2025) and v6 preview added explicit agent features: `ToolLoopAgent` / `Agent` class, `stopWhen`, dynamic tools, provider-executed tools, tool-level provider options, and **lifecycle hooks** [36]. MCP client supported; an "MCP Registry" is in the changelog [35][36]. **No first-class handoff/subagent primitive** — compose agents manually. Unified provider abstraction (OpenAI, Anthropic, Google, Groq, Mistral, Bedrock, Azure, many more) [34][35]. Examples demonstrate `shell` and `imageGeneration` tools but nothing ships out of the box [35]. **Biggest gap:** no opinionated agent loop, no subagents, no sandboxing, no coding tools — you're building the harness on top.

### 3.4 LangGraph JS

`langchain-ai/langgraphjs` — MIT, TypeScript (97.9%), `@langchain/langgraph-sdk@1.8.9` (April 16, 2026), ~2.8k stars [37]. Graph-based orchestration (`StateGraph` = typed state + nodes); supports both supervisor and swarm multi-agent patterns natively [38][39]. First-class streaming; checkpointing; durable execution. `@langgraphjs/toolkit` adds `AgentMemory`, `TokenBudget`, `RateLimiter`, and templates like `createResearchAgent`, `createCodingAgent` [39]. MCP client via `@langchain/mcp-adapters` v1.0.0 [40]. LangChain v1 introduced "middleware" as first-class customization [41]. LangChain's "Deep Agents for JS" provides planning tools, sub-agent spawning, file-system access explicitly aimed at coding agents [41]. **Biggest gap:** lower-level than Claude Code's turnkey harness — more flexibility, more boilerplate; ecosystem sprawl is a learning-curve tax.

### 3.5 LangChain JS

`langchain-ai/langchainjs` — MIT, v1.2.0 (Dec 12, 2025); v1.0 milestone Oct 20, 2025 [40][41]. Legacy `AgentExecutor`/`initialize_agent` pattern is **deprecated** — agents are now built on top of LangGraph. "LangChain JS" in 2026 is effectively "high-level LangGraph wrapper + integrations library." MCP via `@langchain/mcp-adapters` v1.0.0; Anthropic server-side MCP toolset tools exposed through provider integration [40]. Use LangGraph directly if you want control; the LangChain layer is still evolving its 1.0 story.

### 3.6 Google ADK (TypeScript)

`google/adk-js` — Apache-2.0, devtools `v0.6.1` (March 31, 2026), ~1k stars, pre-GA [42][43]. Code-first hierarchical multi-agent, pre-built tools, OpenAPI-spec tool generation, **A2A protocol** (Google's alternative to MCP-style cross-agent interop) [42][43]. MCP support in the JS port is less documented than Python ADK's — **partially uncertain**; verify at release pin [42]. Gemini/Vertex-optimized; Anthropic/Claude not prominent. **Biggest gap:** Gemini-first bias, pre-GA, smaller ecosystem; awkward if Claude is primary.

### 3.7 Microsoft AutoGen / Microsoft Agent Framework

AutoGen (`microsoft/autogen`) is in **maintenance mode** as of 2026, superseded by **Microsoft Agent Framework 1.0** (~April 2026) for .NET and Python [44][45][46]. **TypeScript is not a first-class target** — a narrow `@microsoft/agentmesh-sdk` npm exists for governance but the core is .NET/Python [46]. Strong multi-agent (sequential/concurrent/handoff/group chat/Magentic-One). **Skip for TS projects** — running as a Python/.NET sidecar defeats the point.

### 3.8 CrewAI

MIT, Python-only. **No official TS/JS SDK**, no npm package, no roadmap; unofficial ports exist but one maintainer has stopped [47]. Running from Node means Python sidecar — **not recommended as a TS-native replacement**.

### 3.9 Hugging Face smolagents

`huggingface/smolagents` — Apache-2.0, Python-only, ~1000 lines core, `v1.24.0` (Jan 16, 2026), ~26.8k stars [48][49]. First-class **code agents** — agent *writes Python* as its action channel instead of JSON tool calls, benchmarks show ~30% fewer steps and higher GAIA scores [48][49]. Sandboxing via E2B/Blaxel/Modal/Docker/Pyodide+Deno WASM. MCP client, multi-agent hierarchies. **No TypeScript.** Conceptually the closest thing to what Claude Code itself does — consider as inspiration, not implementation.

### 3.10 PydanticAI

MIT, Python-only, `v1.84.1` (April 18, 2026), ~16.5k stars [50][51]. Strongly typed Python agent framework with durable execution, streamed structured outputs with real-time validation, graph support, harness capability library [50][51]. MCP client; A2A; UI event stream standards. **No TypeScript** — not usable in-process from Node.

### 3.11 Inngest AgentKit

`inngest/agent-kit` — Apache-2.0, TypeScript-native, `@inngest/agent-kit@0.13.2` (Nov 13, 2025), ~845 stars [52][53]. Layered on Inngest's **durable-execution** platform — automatic retries, fault tolerance, mid-execution resume without manual checkpointing [52][53]. Multi-agent via "networks" with state-based routing. MCP as tool source [52][53]. OpenAI, Anthropic, Gemini, OpenAI-compatible [53]. **Includes coding-agent examples** (SWE-bench solver, E2B, Daytona) — unusual among general frameworks [52]. **Biggest gap:** ties you to Inngest's runtime model; smaller community. Best fit among general frameworks if durable execution matters.

### 3.12 LlamaIndex.TS

`run-llama/llamaindex-ts` — MIT, TypeScript first-class (Node, Deno, Bun, Cloudflare Workers) [54]. Reasoning/tool-using agents, multi-agent workflows. Strong MCP client; `@llamaindex/tools` ships Streamable HTTP `mcp` helper; Azure AI Travel Agents is a canonical multi-agent MCP template [55][56]. **No coding-agent ergonomics** — LlamaIndex's DNA remains RAG/context. Good if your harness needs heavy document retrieval.

### 3.13 Cloudflare Agents SDK

`cloudflare/agents` — MIT, TypeScript, Node 24+ dev, `@cloudflare/think@0.3.0` (April 18, 2026), ~4.8k stars [57]. Each agent is a **Durable Object** — stateful micro-server with SQLite, WebSockets, scheduling. Cloudflare's "Project Think" (Agents Week 2026) adds durable execution with fibers, **sub-agents** (isolated children with own SQLite + typed RPC), persistent sessions (tree-structured messages, forking, compaction, full-text search), sandboxed code execution via Dynamic Workers + `codemode`, and **self-authored extensions** [57][58][59]. Packages: `agents`, `@cloudflare/ai-chat`, `@cloudflare/think`, `@cloudflare/codemode`, `@cloudflare/voice`, `@cloudflare/shell` (sandboxed execution) [57]. MCP first-class. `@cloudflare/shell` + `@cloudflare/codemode` are the most direct coding-agent primitives on this list apart from smolagents; sub-agents with isolated SQLite are close to Claude Code's Task tool. **Biggest gap:** lock-in to Cloudflare Workers runtime (Durable Objects aren't portable); team currently doesn't accept external PRs [57]. If you're already on Workers, arguably the best-aligned alternative on this list.

### 3.14 Framework summary

| Framework | TS | MCP | Subagents | Hooks | Claude | Coding primitives | Lic. | Recommendation |
|---|---|---|---|---|---|---|---|---|
| OpenAI Agents SDK | First-class | Client (3 transports) | Handoffs | Limited | Yes | None | MIT | Strong scaffolding, no batteries |
| **Mastra** | First-class | Client + **Server** | Supervisor | Yes | Yes | None | Apache 2.0 + EE | Best TS-native framework |
| Vercel AI SDK | First-class | Client | No (DIY) | Yes | Yes | Examples only | Apache 2.0 | Best low-level toolkit |
| LangGraph JS | First-class | Client (adapters) | Supervisor + Swarm | Middleware | Yes | `createCodingAgent`, Deep Agents | MIT | Most flexible, heavy LC |
| LangChain JS | First-class | Client | via LangGraph | Middleware | Yes | Deep Agents JS | MIT | "LangGraph with batteries" |
| Google ADK JS | First-class | Partial (uncertain) | Hierarchical | Limited | Second-class | None | Apache 2.0 | Gemini-first; avoid |
| MS Agent Framework | **No** | Yes | Rich | Yes | Yes | None | MIT | Skip for TS |
| CrewAI | **No** | Yes | Crews | Yes | Yes | None | MIT | Skip for TS |
| smolagents | **No** | Yes | Hierarchies | Some | Yes | **Code agents + sandboxes** | Apache 2.0 | Inspiration only |
| PydanticAI | **No** | Yes | A2A | Yes | Yes | None | MIT | Inspiration only |
| **Inngest AgentKit** | First-class | Client | State networks | Durable steps | Yes | SWE-bench / E2B / Daytona | Apache 2.0 | Best durable-execution fit |
| LlamaIndex.TS | First-class | Strong client | Workflows | Limited | Yes | None | MIT | If RAG-heavy |
| **Cloudflare Agents** | First-class (Workers) | Yes | **Isolated sub-agents** | Yes | Yes | **Shell + codemode sandbox** | MIT | If on Workers |

**Headline finding:** nothing in the general-framework ecosystem matches Claude Code's turnkey coding-agent ergonomics out of the box. The realistic TS-native candidates for building your own are **Mastra**, **LangGraph JS**, **OpenAI Agents SDK**, **Inngest AgentKit**, and **Cloudflare Agents** — each with distinct tradeoffs, and for all of them you'll implement Claude-Code-specific tools (sandboxed shell, structured file edits, git, diff rendering, prompt-cache coordination) yourself.

---

## 4. Tradeoffs: What Teams Gain and Lose When They Switch

This section weights first-person engineering accounts [11][12][13][14][19] over vendor-neutral comparison articles [15][16][17][18].

### 4.1 What teams report *losing* when they move off Claude Agent SDK

**1. Claude-tuned harness behaviour.** The HumanLayer write-up shows Claude models rank **~#33 on Terminal-Bench 2.0 in generic harnesses but ~#5 when run inside Claude Code** — strong evidence the model is post-trained against this harness's prompts, tool names, and conventions [19]. Builder.io's benchmarking found Claude Code finished an Express.js task **24 minutes faster than Codex with zero interventions**, and caught a race condition Codex missed [20][21]. That quality gap is the single most-cited loss.

**2. Subagent primitives with working context-isolation.** HumanLayer calls subagents a **"context firewall"** and ranks them the highest-leverage primitive in the harness [19]. Codex shipped an equivalent only in late 2025 [12]; most general frameworks don't ship one at all and you build it yourself [22].

**3. Hook lifecycle and Bash sandbox.** The deterministic hook system (pre-tool, post-tool, stop, etc.) is what lets teams enforce "do X every time" without trusting the model to remember [19]. On Vercel AI SDK or raw provider SDKs you rebuild that yourself. The Claude Code bash sandbox with its permission model is specifically called out as a reason developer-assistant workloads stay on Claude [16].

**4. MCP ergonomics and Skills/Agent-Skills.** Claude, OpenAI and Google all nominally support the Agent Skills format now [23], and MCP is cross-provider [7], but the out-of-the-box UX — auto-discovery of `~/.claude/skills`, slash commands, `CLAUDE.md`, plan mode wiring — is still markedly smoother in Claude Code than anywhere else in April 2026.

**5. Plan mode + memory/`CLAUDE.md` lore.** Plan mode, `CLAUDE.md` memory, and the auto-compaction loop are non-trivial to replicate [16][19]. Zechner argues you *shouldn't* replicate plan mode (prefers `PLAN.md` files) but concedes he deliberately chose observability over ergonomics [11].

### 4.2 What teams report *gaining*

**1. Model portability.** Folkman's OpenCode-based rebuild [13] and Arntz's AI Code Agents SDK [14] both treat escape from single-provider coupling as the headline gain. Zechner's `pi-ai` spans 8+ providers with cross-provider context handoff [11]. When a provider has a bad week — Folkman's trigger was Claude Code Max quality regressing in late February (Read:Edit ratio fell 6.6 → 2.0, ~67% drop in thinking depth) — a portable harness lets you fail over, not rewrite [13].

**2. Smaller, legible context.** Zechner's minimal harness keeps system prompt + tools under ~1,000 tokens vs Claude Code's large accumulated prompt; he reports Playwright MCP alone eats ~13.7k tokens per session, ~7–9% of context [11]. HumanLayer's "context rot" framing corroborates [19].

**3. Cheaper inference and observability.** Folkman's five-agent OpenCode system landed at **~$45/month vs $200/month on Claude Max** [13]. He also called out that Reviewer uses a *different* model than Coder — a pattern you can't cleanly express inside Claude Code.

**4. Owning the loop.** Arntz identifies three lock-ins that collapse once you own the loop: provider, tool-calling spec, and sandbox/execution silo [14]. Zechner's argument is similar: "exactly controlling what goes into the model's context yields better outputs, especially when it's writing code" [11].

**5. Fit for non-coding agents.** Comparison sources place OpenAI Agents SDK ahead on multi-agent coordination/handoffs, and Mastra ahead on general agentic app workflows (memory, evaluation, observability in-box) [15][16][24]. Teams report Claude Agent SDK feels right for "give the agent a computer" and less right for long-running business workflows [16].

### 4.3 Model lock-in reality check

**Claude Agent SDK:** the SDK *technically* supports Bedrock/Vertex/Foundry and isn't hard-coded to Anthropic endpoints, but the lock-in isn't at the API layer — it's at the **behavioural** layer. The post-training gap (#33 → #5 on Terminal-Bench depending on harness [19]) is evidence that Claude models are specifically tuned against this harness's tool schema, prompt cadence, and subagent plumbing. Pointing it at a non-Claude model will work mechanically and underperform materially. The Anthropic docs frame the SDK as "deliberately minimal … no lock-in opinion on state/cost/observability" [7][25] — true for *infra* lock-in but not *model-behaviour* lock-in.

**OpenAI Agents SDK (inverted):** slightly less tightly fused to GPT than Claude Code is to Claude, because the Agents SDK was positioned from launch as multi-provider and its handoffs/voice primitives are provider-agnostic [15][16]. In practice, though, Codex-specific features rev with OpenAI's models.

**Vercel AI SDK + MCP:** the most genuinely model-portable path. Arntz's SDK and several templates build directly on `ai` (Vercel) precisely because the provider swap is a one-line config change [14][26].

*Speculation:* as of April 2026, the strongest portability you can actually ship is "Vercel AI SDK + your own hook/subagent primitives + MCP for tools" — at the cost of rebuilding roughly everything listed in the "losing" section. That matches Arntz's and Zechner's independent conclusions.

### 4.4 Cost considerations

Cost is dominated by **model choice and token strategy**, not by harness. Folkman's 4× cost reduction came from switching to cheaper models per-role (Architect on a strong model, Verifier on a small one) and applying a 40-instruction budget per phase [13] — both model/orchestration decisions, not harness decisions. The Builder.io benchmark showed Claude Code consuming **6.2M tokens vs Codex's 1.5M on the same task** [21] — a 4× harness-level difference dwarfed by model-tier differences.

Harness-level cost levers that *do* matter:

- **Subagent routing to cheaper models.** Claude Agent SDK lets you set model per subagent but not as flexibly as OpenCode/Mastra [13][24].
- **MCP context bloat.** Playwright MCP alone costs 13.7k tokens/session; stripping MCP for CLI-via-README saves real money [11].
- **Compaction-driven re-reads.** Lossy compaction causes agents to re-read files [19].

### 4.5 Migration cost — what's hard to port

Kagawa's port from Claude Code to Codex CLI is the best data point: **22 subagents + 26 skills moved "in an afternoon"** [12]. What made that cheap:

- Agent instructions written as **natural-language job descriptions**, not bindings to Claude's `Agent` tool
- **File-based handoffs** (artifacts on disk) rather than shared in-memory state
- **Fresh-context-per-agent** as a portable design rule

What was *not* portable:

- Config format (Markdown frontmatter → TOML)
- Directory conventions (`.claude/` → `.codex/`)
- Any logic assuming specific hook names, plan-mode semantics, or Claude-Code-only slash commands

HumanLayer and Mendral both warn that Claude Code's path-prefix conventions and layout are a moving target; mirroring them too closely is a future migration tax [19][27].

Rank order of migration difficulty (hardest → easiest) across sources:

1. **Hook lifecycle semantics** (hardest — deterministic behaviour you relied on)
2. **Subagent orchestration** — easy if instructions stayed portable, painful if you bound to `Agent` tool calls
3. **Plan mode** — no direct equivalent; file-based `PLAN.md` is the common fallback [11]
4. **MCP server wiring** — portable by protocol, but discovery/auth/audit governance differ [7][25]
5. **Skills / `CLAUDE.md`** — mostly portable as text; the auto-loading UX is what you lose
6. **Bash sandbox / permissions** — has to be rebuilt, but the shape is well understood [27]

### 4.6 Hybrid patterns

Yes, and it's the most consistent pattern in first-person sources:

- **Claude Code for coding tasks, general framework for everything else.** The Vercel-vs-Claude analysis recommends "Vercel AI SDK for the user-facing layer, Claude Agent SDK for backend agent work" explicitly [26]. Mastra has a community package `claude-code-mastra` that wraps Claude Code SDK as a Mastra Agent [24].
- **Two CLIs in parallel.** Multiple reports describe running Claude Code and Codex side-by-side — Claude for quality-sensitive work, Codex for bulk/cheap work, ~$40/mo combined [20][21].
- **Portable instruction framework, swap engines.** Kagawa's pattern — job descriptions as the source of truth, CLIs as swappable engines [12].
- **Claude Code for human loop, custom loop for autonomous batch.** Folkman kept interactive work elsewhere and built the 5-agent CRISPY pipeline for lights-out batch coding [13].

---

## 5. Opinionated Decision Framework

Compact matrix synthesizing the sources for a TypeScript/Node project that today embeds Claude Code as a programmable harness.

### Axis 1 — what the agent actually does

| Primary workload | Best default |
|---|---|
| Coding on a real filesystem, human-in-loop, quality-sensitive | **Stay on Claude Agent SDK** |
| Coding, headless/autonomous batch, cost-sensitive | **OpenCode or roll-your-own on Vercel AI SDK** |
| Coding + non-coding business workflows in one product | **Hybrid: Claude Agent SDK wrapped inside Mastra or OpenAI Agents SDK** |
| Primarily non-coding (support, research, ops agents) | **Mastra (TS-native) or OpenAI Agents SDK** |
| Need to run locally / air-gapped / on open models | **Roll your own on Vercel AI SDK + MCP client** |

### Axis 2 — priorities the user named

| If the dominant priority is… | Pick |
|---|---|
| Coding-workflow quality (subagents, hooks, plan mode, Claude-tuned behaviour) | **Claude Agent SDK** [19][20][21] |
| Model portability | **Vercel AI SDK + your own loop** [14][26], or **Mastra** [24] |
| Headless orchestration across many agent types | **OpenAI Agents SDK** or **Mastra** [15][16][24] |
| Minimum dependency footprint / transparency / observability | **Roll your own (pi-style)** [11] |
| Cost reduction without losing quality | **Hybrid + per-role model routing** (Folkman pattern) [13] |

### Axis 3 — green-light / red-light rules

**Stay on Claude Agent SDK if** three or more are true: workload is coding-centric; you rely on subagents, hooks, or plan mode today; you have meaningful `CLAUDE.md`/Skills lore; you don't need to swap models for cost/availability reasons; team is <5 engineers (migration tax is real [12][19][27]).

**Switch to another coding CLI (Codex, OpenCode, Gemini CLI) if** you want to keep the "coding CLI" shape but cost, rate limits, or a provider-quality episode is the trigger (cf. Folkman [13]). Kagawa's result suggests the port is an afternoon *if* instructions are portable; budget a week if they aren't [12].

**Build on a general agent framework (Mastra, OpenAI Agents SDK) if** coding is only one of several agent domains in your product, or you need memory/eval/observability-in-box. Expect to rebuild coding-specific primitives yourself or via integrations like `claude-code-mastra` [24].

**Roll your own on Vercel AI SDK + MCP client if** model portability is a top-three business requirement, you need full context transparency, or you're shipping a developer tool users will swap models in (Arntz [14]). Expect to reimplement hooks, subagent context isolation, and plan-mode equivalents; Zechner's pi repo is the closest reference implementation [11].

**Hybrid (recommended default for this project):** keep Claude Agent SDK for coding-specific orchestration but expose it behind a thin provider-neutral interface (e.g., an `Agent` façade that could later be swapped for Mastra or a raw Vercel AI SDK loop). Keeps today's quality, puts optionality cost at ~1 sprint, and lines up with the "Claude Code inside Mastra" pattern already in the wild [24][26].

### Concretely for Callboard (a Node/TS project embedding Claude Code today)

Three pragmatic paths, ordered by risk-adjusted value:

1. **Stay + façade.** Keep `@anthropic-ai/claude-agent-sdk` but put it behind a narrow internal interface. Migration cost later drops sharply. Rationale: the behavioural advantage for coding work is real [19][20][21], and the rename to "Agent SDK" + v0.2.x release cadence suggests Anthropic is investing heavily [1][3].
2. **Switch coding CLI to OpenCode.** If cost/portability dominate and the harness behaviour tax is acceptable. OpenCode's OpenAPI server + TS SDK is the closest structural equivalent with MIT licensing, 75+ providers incl. local, and a real library surface [80][81].
3. **Build on Mastra (or Vercel AI SDK).** If coding is *one of several* agent types in Callboard's roadmap. Mastra's bidirectional MCP, evals, and supervisor pattern make it the strongest TS-native framework foundation [24][32][33], and `claude-code-mastra` lets you keep Claude Code as one agent inside a broader fleet.

Avoid: AutoGen/MAF, CrewAI, smolagents, PydanticAI (not TypeScript); Plandex (stale, no MCP); Aider (no supported SDK); Cursor CLI and Copilot CLI (no library surface); Google ADK JS (Gemini-first, pre-GA).

---

## Conclusion

As of April 2026 there is **no drop-in replacement** for the Claude Agent SDK that preserves all of: Claude-tuned coding quality, subagents-as-context-firewall, 19+ hook events, four-transport MCP, plan mode, skills/memory, OS-level sandbox, and a first-class TypeScript surface. The closest structural equivalents each trade one or two of these for open-source licensing or model portability.

The most important finding from first-person engineering sources is the **harness-coupled post-training effect** — Claude on Terminal-Bench 2.0 moves from ~#33 to ~#5 depending on whether it's in its own harness or someone else's [19]. That inverts the naive assumption that switching harnesses while keeping Claude is a safe choice: it's not, for coding specifically.

Three open questions remain:

1. **Whether Anthropic will open-source parts of the harness or publish the tool-calling conventions** so other harnesses can replicate the Claude post-training baseline. Nothing in current public material suggests this is imminent.
2. **Whether the Agent Client Protocol (ACP, Cline) or similar cross-harness standards will reduce the lock-in** the way LSP did for editors [74].
3. **How durable-execution frameworks like Inngest AgentKit and Cloudflare's Project Think** will compete with Claude Code's in-process model as agent runs grow longer and need to survive restarts [52][58].

For Callboard, the recommended move today is **"stay on Claude Agent SDK behind a thin provider-neutral façade"** — it preserves today's quality, makes later optionality cheap, and matches the hybrid pattern already visible in the wild [24][26]. Re-evaluate in 2–3 quarters if (a) Anthropic's pricing or availability changes, (b) ACP or a similar standard gains traction, or (c) Mastra/OpenCode close the coding-ergonomics gap meaningfully.

---

## References

[1] Anthropic. "Agent SDK overview." *Claude Code Docs*. https://code.claude.com/docs/en/agent-sdk/overview (also https://platform.claude.com/docs/en/agent-sdk/overview). Accessed April 2026.

[2] Anthropic. "Migrate to Claude Agent SDK." *Claude API Docs*. https://platform.claude.com/docs/en/agent-sdk/migration-guide. Accessed April 2026.

[3] Anthropic. "claude-agent-sdk-typescript CHANGELOG." GitHub. https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md. Accessed April 2026.

[4] Anthropic. "Agent SDK reference – TypeScript." *Claude Code Docs*. https://code.claude.com/docs/en/agent-sdk/typescript. Accessed April 2026.

[5] Nader Dabit. "The Complete Guide to Building Agents with the Claude Agent SDK." Substack, 2026. https://nader.substack.com/p/the-complete-guide-to-building-agents.

[6] Anthropic. "anthropics/claude-agent-sdk-typescript." GitHub repository README. https://github.com/anthropics/claude-agent-sdk-typescript. Accessed April 2026.

[7] Anthropic. "Connect to external tools with MCP." *Claude Code Docs*. https://code.claude.com/docs/en/agent-sdk/mcp (also https://platform.claude.com/docs/en/agent-sdk/mcp). Accessed April 2026.

[8] Anthropic. "Choose a permission mode." *Claude Code Docs*. https://code.claude.com/docs/en/permission-modes. Accessed April 2026.

[9] Portkey. "How to use Claude Code with Bedrock, Vertex AI and Anthropic." Portkey Blog. https://portkey.ai/blog/how-to-use-claude-code-with-bedrock-vertex-ai-and-anthropic/.

[10] liruifengv. "Common Pitfalls with the Claude Agent SDK." 2026. https://liruifengv.com/posts/claude-agent-sdk-pitfalls-en/.

[11] Mario Zechner. "What I learned building an opinionated and minimal coding agent." mariozechner.at, 2025-11-30. https://mariozechner.at/posts/2025-11-30-pi-coding-agent/.

[12] Shinsuke Kagawa (shinpr). "Same Framework, Different Engine: Porting AI Coding Workflows from Claude Code to Codex CLI." DEV Community. https://dev.to/shinpr/same-framework-different-engine-porting-ai-coding-workflows-from-claude-code-to-codex-cli-n3p.

[13] Tyler Folkman. "I Replaced Claude Code With a $45/Month Multi-Agent System." Substack. https://tylerfolkman.substack.com/p/i-replaced-claude-code-with-a-45month.

[14] Felix Arntz. "Introducing AI Code Agents: A TypeScript SDK to Solve Vendor Lock-in for Coding Agents." felix-arntz.me. https://felix-arntz.me/blog/introducing-ai-code-agents-a-typescript-sdk-to-solve-vendor-lock-in-for-coding-agents/.

[15] Composio. "Claude Agents SDK vs. OpenAI Agents SDK vs. Google ADK (2026)." https://composio.dev/content/claude-agents-sdk-vs-openai-agents-sdk-vs-google-adk.

[16] HolySheep AI. "Claude Agent SDK vs OpenAI Agents SDK vs Google ADK: 2026 Ultimate Framework Showdown." https://www.holysheep.ai/articles/en-claude-agent-sdk-vs-openai-agents-sdk-vs-google-ad-2026-04-13-0007.html.

[17] Verdent. "Best Claude Code Alternatives in 2026 for Agentic Workflows." https://www.verdent.ai/guides/claude-code-alternatives-2026.

[18] Builder.io. "5 Claude Code Alternatives in 2026." https://www.builder.io/blog/claude-code-alternatives.

[19] HumanLayer. "Skill Issue: Harness Engineering for Coding Agents." https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents.

[20] Builder.io. "Codex vs Claude Code: which is the better AI coding agent?" https://www.builder.io/blog/codex-vs-claude-code.

[21] NxCode. "Claude Code vs Codex CLI 2026." https://www.nxcode.io/resources/news/claude-code-vs-codex-cli-terminal-coding-comparison-2026.

[22] LangChain. "The Anatomy of an Agent Harness." https://www.langchain.com/blog/the-anatomy-of-an-agent-harness.

[23] MindStudio. "Agent Skills as an Open Standard: How Claude, OpenAI, and Google All Adopted the Same Format." https://www.mindstudio.ai/blog/agent-skills-open-standard-claude-openai-google-2.

[24] Mastra. GitHub repo + community `t3ta/claude-code-mastra` wrapper. https://github.com/mastra-ai/mastra and https://github.com/t3ta/claude-code-mastra.

[25] MintMCP. "Anthropic Claude SDK with MCP: enterprise deployment guide." https://www.mintmcp.com/blog/enterprise-development-guide-ai-agents.

[26] Robert Mill. "Vercel AI SDK vs Claude Agent SDK: Which One Should You Build With?" Medium. https://bertomill.medium.com/vercel-ai-sdk-vs-claude-agent-sdk-which-one-should-you-build-with-a88d2d6a4311.

[27] Mendral. "Agent Harness: Inside vs Outside the Sandbox." https://www.mendral.com/blog/agent-harness-inside-vs-outside-sandbox.

[28] OpenAI. "openai-agents-js." GitHub. https://github.com/openai/openai-agents-js.

[29] OpenAI. "Agents." OpenAI Agents SDK TypeScript docs. https://openai.github.io/openai-agents-js/guides/agents/.

[30] OpenAI Developers. TypeScript Agents SDK announcement. https://x.com/OpenAIDevs/status/1929950489539686901 and https://community.openai.com/t/updates-to-building-agents-typescript-agents-sdk-a-new-realtimeagent-feature-for-voice-agents-traces-for-realtime-and-speech-to-speech-improvements/1277152.

[31] OpenAI. "Model Context Protocol (MCP)." OpenAI Agents SDK TS docs. https://openai.github.io/openai-agents-js/guides/mcp/.

[32] generative.inc. "Mastra AI: The Complete Guide to the TypeScript Agent Framework (2026)." https://www.generative.inc/mastra-ai-the-complete-guide-to-the-typescript-agent-framework-2026.

[33] Mastra. "Agents." Mastra docs. https://mastra.ai/agents.

[34] Vercel. "AI SDK." Docs. https://ai-sdk.dev/docs/introduction.

[35] Vercel. "vercel/ai." GitHub. https://github.com/vercel/ai.

[36] Vercel. "AI SDK 5." Vercel Blog. https://vercel.com/blog/ai-sdk-5.

[37] LangChain AI. "langgraphjs." GitHub. https://github.com/langchain-ai/langgraphjs.

[38] LangChain. "LangGraph." Product page. https://www.langchain.com/langgraph.

[39] LangGraph.JS Guide. "Build AI Agents with LangGraph TypeScript." https://langgraphjs.guide/ and https://langgraphjs.guide/multi-agent/.

[40] LangChain. "LangChain JS Changelog." https://docs.langchain.com/oss/javascript/releases/changelog.

[41] LangChain. "LangChain and LangGraph v1.0 milestone." https://www.langchain.com/blog/langchain-langgraph-1dot0.

[42] Google. "adk-js." GitHub. https://github.com/google/adk-js.

[43] Google Developers. "Introducing ADK for TypeScript." Google Developers Blog. https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/.

[44] Microsoft. "autogen." GitHub. https://github.com/microsoft/autogen.

[45] Microsoft. "AutoGen → Microsoft Agent Framework migration guide." https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/.

[46] Microsoft. "Microsoft Agent Framework 1.0." Microsoft DevBlogs; Visual Studio Magazine. https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/ and https://visualstudiomagazine.com/articles/2026/04/06/microsoft-ships-production-ready-agent-framework-1-0-for-net-and-python.aspx.

[47] LangGraph.JS Guide. "LangGraph vs CrewAI vs OpenAI Agents — TS Comparison." https://langgraphjs.guide/comparison/.

[48] Hugging Face. "smolagents." GitHub. https://github.com/huggingface/smolagents.

[49] Hugging Face. "Introducing smolagents." HF Blog. https://huggingface.co/blog/smolagents.

[50] Pydantic. "pydantic-ai." GitHub. https://github.com/pydantic/pydantic-ai.

[51] Pydantic. "PydanticAI docs." https://ai.pydantic.dev/ and https://ai.pydantic.dev/mcp/overview/.

[52] Inngest. "agent-kit." GitHub. https://github.com/inngest/agent-kit.

[53] Inngest. "AgentKit docs." https://agentkit.inngest.com/overview and https://agentkit.inngest.com/concepts/agents.

[54] Run Llama. "LlamaIndex.TS docs." https://developers.llamaindex.ai/typescript/framework/.

[55] Microsoft DEV. "Using LlamaIndex.TS to Orchestrate MCP Servers." https://dev.to/azure/using-llamaindexts-to-orchestrate-mcp-servers-413k.

[56] Run Llama. "LlamaIndex MCP Documentation Search." https://developers.llamaindex.ai/typescript/shared/mcp/.

[57] Cloudflare. "cloudflare/agents." GitHub. https://github.com/cloudflare/agents.

[58] Cloudflare. "Project Think (Agents Week 2026)." https://blog.cloudflare.com/project-think/ and https://www.cloudflare.com/agents-week/updates/.

[59] Cloudflare. "Cloudflare Agents docs." https://developers.cloudflare.com/agents/.

[60] Daniel Vaughan. "codex-rs Rust rewrite architecture." https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/.

[61] OpenAI. "openai/codex." GitHub. https://github.com/openai/codex.

[62] OpenAI. "Codex CLI." OpenAI Developers. https://developers.openai.com/codex/cli.

[63] OpenAI. "Codex SDK." https://developers.openai.com/codex/sdk.

[64] OpenAI. "Codex MCP." https://developers.openai.com/codex/mcp.

[65] Aider. "Homepage." https://aider.chat/.

[66] Aider-AI. "aider." GitHub. https://github.com/Aider-AI/aider.

[67] Aider. "Scripting aider." https://aider.chat/docs/scripting.html.

[68] OpenAI. "Codex CLI features." https://developers.openai.com/codex/cli/features.

[69] OpenAI. "Codex SDK — headless JSON events (issue)." https://github.com/openai/codex/issues/2772.

[70] Cursor. "Headless." Cursor CLI docs. https://cursor.com/docs/cli/headless.

[71] Cursor. "CLI overview." https://cursor.com/docs/cli/overview.

[72] Cursor. "Cursor CLI announcement." https://cursor.com/blog/cli.

[73] TechCrunch. "Cursor is rolling out a new system for agentic coding." 2026-03-05. https://techcrunch.com/2026/03/05/cursor-is-rolling-out-a-new-system-for-agentic-coding/.

[74] Cline. "Introducing Cline CLI 2.0." 2026-02-13. https://cline.bot/blog/introducing-cline-cli-2-0.

[75] DevOps.com. "Cline CLI 2.0 Turns Your Terminal Into an AI Agent Control Plane." https://devops.com/cline-cli-2-0-turns-your-terminal-into-an-ai-agent-control-plane/.

[76] Cline. "cline/cline." GitHub. https://github.com/cline/cline.

[77] Arcade.dev. "Goose and MCP." https://www.arcade.dev/blog/goose-the-open-source-agent-that-shaped-mcp.

[78] Anthropic. "Donating Model Context Protocol and establishing the Agentic AI Foundation." https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation.

[79] Block. "Goose docs." https://goose-docs.ai/.

[80] OpenCode. "Server." Docs. https://opencode.ai/docs/server/.

[81] SST. "sst/opencode." GitHub. https://github.com/sst/opencode.

[82] All-Hands-AI. "OpenHands homepage." https://openhands.dev/.

[83] All-Hands-AI. "OpenHands docs." https://docs.openhands.dev/.

[84] All-Hands-AI. "OpenHands/OpenHands." GitHub. https://github.com/OpenHands/OpenHands.

[85] Google. "Gemini CLI headless + MCP." https://google-gemini.github.io/gemini-cli/docs/cli/headless.html.

[86] Google. "google-gemini/gemini-cli." GitHub. https://github.com/google-gemini/gemini-cli.

[87] GitHub Changelog. "GitHub Copilot CLI is now generally available." 2026-02-25. https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available/.

[88] GitHub. "github/copilot-cli releases." https://github.com/github/copilot-cli/releases.

[89] Sourcegraph. "@sourcegraph/amp on npm." https://www.npmjs.com/package/@sourcegraph/amp.

[90] Sourcegraph. "Amp product page." https://ampcode.com/.

[91] Sourcegraph. "Amp Owner's Manual." https://ampcode.com/manual.

[92] Sourcegraph. "Amp SDK." https://ampcode.com/manual/sdk.

[93] Plandex. "Homepage." https://plandex.ai/.

[94] Plandex-AI. "plandex." GitHub. https://github.com/plandex-ai/plandex.

[95] Morph. "Roo Code vs Cline 2026." https://www.morphllm.com/comparisons/roo-code-vs-cline.

[96] Roo Code Inc. "RooCodeInc/Roo-Code." GitHub. https://github.com/RooCodeInc/Roo-Code.

[97] Kilo-Org. "kilocode." GitHub. https://github.com/Kilo-Org/kilocode.

[98] CodebuffAI. "codebuff." GitHub. https://github.com/CodebuffAI/codebuff.

[99] Continue. "CLI docs." https://docs.continue.dev/guides/cli.

[100] Continue Dev. "continuedev/continue." GitHub. https://github.com/continuedev/continue.
