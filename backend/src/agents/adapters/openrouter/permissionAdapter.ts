/**
 * OpenRouter permission adapter — maps the tool names the OpenRouter harness
 * actually emits into callboard's four {@link PermissionCategory} axes.
 *
 * ## Why this file exists
 *
 * Until it did, the OR path was gated by `categorizeClaudeTool`, whose map is
 * keyed on Claude Code's PascalCase names (`Bash`, `Read`, `Edit`). Every OR
 * tool name is snake_case, so **every one of them** missed the map and hit that
 * function's `return "fileWrite"` default. That is not a hypothetical: the
 * production log carries 641 `tool=bash, category=fileWrite, decision=allow`
 * lines. Under the common `{fileWrite: "allow", codeExecution: "ask"}` shape,
 * OR's shell tool ran with no prompt — a `codeExecution` bypass wearing a
 * `fileWrite` label.
 *
 * ## Ordering and prose rules
 *
 * This categorizer follows "The two-pass rule" (architect ruling, 2026-07-28;
 * see `plans/acp-adapter.md` and `../acp/permissionAdapter.ts`), which binds
 * every adapter and not just ACP:
 *
 *  - **Exact names first.** Unlike ACP, OR's client toolset is a closed,
 *    known set shipped by the harness, so the primary mechanism is an explicit
 *    table rather than a tokenizer. Guessing is the fallback, not the plan.
 *  - **Ambiguity resolves to the most restrictive matching category** — the
 *    {@link CATEGORY_TOKENS} fallback is ordered `codeExecution` → `fileWrite`
 *    → `webAccess` → `fileRead`, and a name matching several families gets the
 *    first. Resolving `search_and_run` to `fileRead` would treat a run-capable
 *    tool as read-only, which is the widening the rule exists to prevent.
 *  - **Never categorize from prose.** {@link isOrToolIdentifier} gates the
 *    tokenizer by shape; anything sentence-like is categorized to
 *    {@link MOST_RESTRICTIVE_CATEGORY} without its words being read.
 *
 * The token table and identifier test deliberately mirror the ACP adapter's
 * rather than importing them: scope item 1 is "each adapter owning its own"
 * categorizer, and the ACP file had just merged. Consolidating the two into one
 * shared tokenizer is a reasonable follow-up, but it should be a deliberate
 * refactor, not a side effect of this fix.
 *
 * ## What is NOT gated here
 *
 * OR's *server* tools (`openrouter:web_search`, `openrouter:web_fetch`,
 * `openrouter:datetime`) are mapped below, but that mapping is currently
 * **unreachable**. They are injected into the request body by an SDK hook and
 * execute on OpenRouter's servers; the harness's own agent loop says so:
 *
 *   > server-side tools (datetime/web_search/web_fetch) are injected via OR SDK
 *   > hooks and execute on OpenRouter's servers — they bypass this wrapper, so
 *   > canUseTool only ever sees client tools.
 *   >   — `openrouter-agent-harness/dist/agent.js`
 *
 * They come back as `openrouter:*` output items, not tool calls, so no
 * `canUseTool` pass ever runs for them. The entries below are defence in depth
 * (correct the moment the harness routes them through the gate) and a statement
 * of intent — they are not a gate.
 *
 * The gate that does work is `./serverToolPolicy.ts`, applied in
 * `optionsAdapter`: it withholds the web-carrying entries from the request body
 * when `webAccess` is not "allow", which for something that executes on someone
 * else's servers is the whole of the enforcement available. It covers BOTH
 * channels that never reach `canUseTool` — the `serverTools` array and the
 * `plugins` array inside `modelParams` (the deprecated `web` plugin and the
 * `fusion` plugin are web access too, and a plugin runs once per request whether
 * the model asked or not).
 *
 * Nothing below changed when either shipped — this file still describes only
 * what `canUseTool` would see, and plugins have no tool name to categorize at
 * all, so they are not represented here even unreachably.
 *
 * @see plans/acp-adapter.md (Permissions — "The two-pass rule")
 * @see ../acp/permissionAdapter.ts (the reference implementation)
 */
import type { PermissionCategory } from "../../permissions/ToolPermissionPolicy.js";
import { SERVER_TOOL_PREFIX } from "./serverTools.js";

/**
 * The category anything unrecognizable resolves to.
 *
 * `codeExecution` is the top of the restrictiveness order: a tool that can run
 * code can do everything the other three axes describe, so it is the only safe
 * answer when we do not know what a tool is.
 *
 * Note what this is NOT: `null`. `decidePermission(null, …)` returns "ask"
 * *unconditionally* — it does not consult the user's settings at all — so a
 * `null` default would prompt even under an all-"allow" policy. Callboard's
 * unattended runners (job steps, deployed agents, `start_chat_session`) all
 * hardcode `{fileRead, fileWrite, codeExecution, webAccess} = "allow"`
 * precisely so they need no human, and an agent job step has no timeout: a
 * prompt nobody answers hangs the run until it is aborted. `codeExecution` is
 * strictly more conservative than the old `fileWrite` default while still
 * resolving to a definite decision under every policy.
 */
export const MOST_RESTRICTIVE_CATEGORY: PermissionCategory = "codeExecution";

/**
 * Tools that touch nothing the four axes govern, mapped to `fileRead`.
 *
 * The honest category for `task_create` (an in-memory checklist) or
 * `ask_user_question` (host-mediated prompt) is "none of the above", and the
 * type has a way to spell that — `null`. We do not use it, for the reason in
 * {@link MOST_RESTRICTIVE_CATEGORY}: `null` means "ask", not "allowed", and
 * these tools DO reach `canUseTool` (the production log shows `task_create` 35
 * times, `task_update` 26, `ask_user_question` 13). Mapping them to `null`
 * would make every unattended OR run stop and wait for a human on its first
 * bookkeeping call.
 *
 * `fileRead` is the weakest of the four gates, so it is the smallest lie
 * available: it over-approximates these tools as "observes only", which is a
 * true upper bound on what they can do, and it resolves to "allow" under every
 * policy that allows reading.
 *
 * `ask_user_question` is worth spelling out. It is OR's analogue of Claude's
 * `AskUserQuestion`, but `buildCanUseTool`'s special case matches the PascalCase
 * name only — the OR tool is surfaced by the harness's own `onAskUserQuestion`
 * host handler *after* the gate lets it run. So it must resolve to "allow"
 * under a normal policy; sending it to the generic permission prompt would put
 * a permission dialog in front of every question the agent asks.
 */
const NO_AXIS_TOOLS = ["ask_user_question", "task_create", "task_update", "tool_search", "tool_load", "datetime"] as const;

/**
 * Exact tool-name → category table for everything OpenRouter ships.
 *
 * Sources, all verified against the installed harness rather than assumed:
 *  - client tools: `allTools()` in `openrouter-agent-harness/dist/tools/index.js`
 *  - server tools: `DEFAULT_SERVER_TOOLS` in `.../tools/server-tools.js`
 */
const EXACT_CATEGORIES: ReadonlyMap<string, PermissionCategory> = new Map<string, PermissionCategory>([
  // ── Client tools: read-only file access ──
  ["read_file", "fileRead"],
  ["list_directory", "fileRead"],
  ["grep_files", "fileRead"],
  ["glob", "fileRead"],
  // `skill` resolves a skill by name and returns its SKILL.md body — a disk
  // read, and nothing more; the *contents* may instruct the model to act, but
  // that action is gated when the model calls the tool that performs it.
  ["skill", "fileRead"],
  // Parity with the Claude map, which special-cases this same callboard tool as
  // `mcp__callboard-tools__render_file`. Under OR it arrives bare — the in-process
  // bundle bridge (`createSdkMcpServer`) is a value bag that passes `def.name`
  // straight through with no server prefix. Neither `render` nor `file` is a
  // token in any family below, so without this entry it would fall through to
  // `codeExecution`.
  ["render_file", "fileRead"],

  // ── Client tools: file mutation ──
  ["write_file", "fileWrite"],
  ["edit_file", "fileWrite"],
  ["edit_notebook", "fileWrite"],

  // ── Client tools: code execution ──
  ["bash", "codeExecution"],
  // `monitor` is not a viewer despite the name — it spawns a shell command via
  // `/bin/sh -c` and streams its output. The tokenizer fallback would not catch
  // this, which is exactly why the exact table comes first.
  ["monitor", "codeExecution"],
  // A subagent inherits the full client toolset, `bash` included, so spawning
  // one is at least as privileged as running a command.
  ["spawn_subagent", "codeExecution"],
  ["spawn_subagents", "codeExecution"],

  // ── Server tools (see the "What is NOT gated here" note above) ──
  ["web_search", "webAccess"],
  ["web_fetch", "webAccess"],

  // ── Tools with no axis of their own ──
  ...NO_AXIS_TOOLS.map((name) => [name, "fileRead"] as [string, PermissionCategory]),
]);

/**
 * Token families for names not in {@link EXACT_CATEGORIES}, **most restrictive
 * first**. A name matching more than one family resolves to the first listed.
 *
 * This is the fallback path, and in the OR adapter it mostly serves MCP tools:
 * callboard's in-process bundles surface under their bare names (`render_file`,
 * `spawn_job`), and the harness's MCP bridge names external server tools
 * `<server>__<tool>` (`mcp-proxy__secure_request`). None of those are knowable
 * in advance, so they get tokenized and, failing that, the strictest gate.
 */
const CATEGORY_TOKENS: ReadonlyArray<readonly [PermissionCategory, readonly string[]]> = [
  ["codeExecution", ["bash", "sh", "shell", "exec", "execute", "run", "terminal", "command", "spawn", "eval", "script", "process", "kill"]],
  ["fileWrite", ["write", "edit", "create", "delete", "remove", "move", "rename", "patch", "apply", "mkdir", "replace", "insert", "append", "update", "modify", "save", "touch"]],
  ["webAccess", ["fetch", "http", "https", "web", "browse", "url", "download", "upload", "curl", "request"]],
  ["fileRead", ["read", "glob", "grep", "search", "find", "list", "cat", "view", "stat"]],
];

/**
 * Does this string look like a *tool name* rather than a sentence?
 *
 * Rule 3 of the two-pass ruling. `canUseTool` is a `(toolName: string, …)`
 * bridge and nothing structurally guarantees the caller passes an identifier,
 * so prose is never parsed for a gate: anything that is not a single
 * identifier-shaped token goes straight to {@link MOST_RESTRICTIVE_CATEGORY}.
 *
 * Permissive enough for every naming convention in play — `read_file`,
 * `mcp-proxy__secure_request`, `openrouter:web_search`, `mcp__server__tool`.
 */
export function isOrToolIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,63}$/.test(value);
}

/**
 * Category for an OpenRouter tool, from its name and nothing else.
 *
 * Resolution order:
 *  1. exact match in {@link EXACT_CATEGORIES} (with any `openrouter:` prefix
 *     stripped, since server tools surface both ways)
 *  2. token match in {@link CATEGORY_TOKENS}, most restrictive family first
 *  3. {@link MOST_RESTRICTIVE_CATEGORY}
 *
 * Never returns `null` — see {@link MOST_RESTRICTIVE_CATEGORY} for why "ask"
 * is not a safe default on a path that unattended runs depend on.
 */
export function categorizeOpenRouterTool(toolName: string): PermissionCategory | null {
  const trimmed = toolName.trim();
  if (!isOrToolIdentifier(trimmed)) return MOST_RESTRICTIVE_CATEGORY;

  // `openrouter:web_search` and the UI-facing `web_search` are the same tool;
  // `serverToolName()` strips the prefix for display, so the gate must accept
  // whichever form reaches it.
  const bare = trimmed.startsWith(SERVER_TOOL_PREFIX) ? trimmed.slice(SERVER_TOOL_PREFIX.length) : trimmed;

  const exact = EXACT_CATEGORIES.get(bare);
  if (exact) return exact;

  // Tokenize rather than using `\b` word boundaries: OR tool names are
  // overwhelmingly snake_case and `_` is a word character, so `/\bread\b/` does
  // NOT match `read_file`. Splitting on non-alphanumerics handles snake_case,
  // camelCase, kebab-case and the `__` MCP separator for free.
  const tokens = new Set(
    bare
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

  for (const [category, words] of CATEGORY_TOKENS) {
    if (words.some((w) => tokens.has(w))) return category;
  }
  return MOST_RESTRICTIVE_CATEGORY;
}
